// BOT ENGINE ORCHESTRATOR
// Central coordinator that wires all components together:
// Data Layer → Strategies → Risk Manager → Executor → Monitoring
// Every trade: SOL → [route] → SOL

import { engineLog, tradeLogger } from './logger.js';
import { BotConfig, loadConfig, RISK_PROFILES, RiskProfile, SCAN_TOKENS } from './config.js';
import { ConnectionManager } from './connectionManager.js';
import { BotDatabase } from './database.js';
import { Executor, ExecutionResult } from './executor.js';
import { RiskManager } from './riskManager.js';
import { PnLTracker } from './pnlTracker.js';
import { PositionTracker } from './positionTracker.js';
import { MetricsCollector } from './metrics.js';
import { AlertManager } from './alertManager.js';
import { TradeJournal } from './tradeJournal.js';
import { GeyserClient } from './geyserClient.js';
import { PoolMonitor } from './poolMonitor.js';
import { decodeSwapInstruction, decodeAllSwaps } from './instructionDecoder.js';
import { WebSocketServer as WebSocketBroadcaster } from './api/websocket.js';

// Strategies
import { BaseStrategy, Opportunity } from './strategies/baseStrategy.js';
import { CyclicArbitrageStrategy } from './strategies/cyclicArbitrage.js';
import { MultiHopArbitrageStrategy } from './strategies/multiHopArbitrage.js';
import { CrossDexArbitrageStrategy } from './strategies/crossDexArbitrage.js';
import { SandwichStrategy } from './strategies/sandwichStrategy.js';
import { FrontrunStrategy } from './strategies/frontrunStrategy.js';
import { BackrunStrategy } from './strategies/backrunStrategy.js';
import { LiquidationStrategy } from './strategies/liquidationStrategy.js';
import { JITLiquidityStrategy } from './strategies/jitLiquidityStrategy.js';
import { SnipingStrategy } from './sniping/snipingStrategy.js';

export type BotStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'circuit_breaker' | 'error';

export interface BotStats {
  status: BotStatus;
  uptime: number;
  startedAt: string | null;
  totalScans: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  tradesSuccessful: number;
  tradesFailed: number;
  tradesSkipped: number;
  totalProfitSol: number;
  totalProfitUsd: number;
  currentBalanceSol: number;
  currentSolPriceUsd: number;
  activeStrategies: string[];
  riskLevel: string;
  wsClients: number;
}

export class BotEngine {
  // Core
  private config: BotConfig;
  private riskProfile: RiskProfile;
  private connectionManager: ConnectionManager;
  private database: BotDatabase;

  // Execution
  private executor: Executor;

  // Risk
  private riskManager: RiskManager;
  private pnlTracker: PnLTracker;
  private positionTracker: PositionTracker;

  // Data
  private geyserClient: GeyserClient;
  private poolMonitor: PoolMonitor;
  // Adapter object wrapping the instructionDecoder module functions
  // to satisfy the local InstructionDecoder interface in sandwich/frontrun strategies
  private instructionDecoderAdapter: {
    decodeSwapInstruction: typeof decodeSwapInstruction;
    decodeTransaction: (tx: any) => any | null;
  };

  // Monitoring
  private metrics: MetricsCollector;
  private alertManager: AlertManager;
  private tradeJournal: TradeJournal;
  private wsBroadcaster: WebSocketBroadcaster | null = null;

  // Strategies
  private strategies: Map<string, BaseStrategy> = new Map();
  private mevStrategies: Array<SandwichStrategy | FrontrunStrategy | JITLiquidityStrategy> = [];
  private snipingStrategy: SnipingStrategy | null = null;

  // State
  private status: BotStatus = 'stopped';
  private startedAt: number = 0;
  private scanLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private solPriceUsd: number = 0;
  private solPriceCacheTs: number = 0;
  private stats: BotStats;

  // Recent opportunities buffer (shown on dashboard even without execution)
  private recentOpportunities: Array<{
    id: string;
    strategy: string;
    tokenPath: string[];
    expectedProfitSol: number;
    expectedProfitUsd: number;
    confidence: number;
    timestamp: number;
    metadata: Record<string, any>;
  }> = [];
  private readonly MAX_RECENT_OPPORTUNITIES = 50;

  constructor() {
    this.config = loadConfig();
    this.riskProfile = RISK_PROFILES[this.config.riskLevel];

    // Initialize core components
    this.connectionManager = new ConnectionManager(this.config);
    this.database = new BotDatabase();

    // Execution
    this.executor = new Executor(this.connectionManager, this.config);

    // Risk
    this.pnlTracker = new PnLTracker(this.database);
    this.positionTracker = new PositionTracker(this.database);
    this.riskManager = new RiskManager(this.config, this.pnlTracker, this.positionTracker, this.connectionManager);

    // Data
    this.geyserClient = new GeyserClient(this.config);
    this.poolMonitor = new PoolMonitor(this.connectionManager, this.config);
    this.instructionDecoderAdapter = {
      decodeSwapInstruction,
      decodeTransaction: (tx: any) => {
        // Adapt raw Geyser transaction data into the ParsedTransactionData
        // format that sandwich/frontrun strategies expect
        if (!tx || !tx.instructions) return null;
        const swaps = tx.instructions
          .map((ix: any) => decodeSwapInstruction(ix))
          .filter(Boolean);
        if (swaps.length === 0) return null;
        return {
          signature: tx.signature || '',
          instructions: swaps,
          feePayer: tx.accounts?.[0] || '',
          recentBlockhash: '',
          raw: tx,
        };
      },
    };

    // Monitoring
    this.metrics = new MetricsCollector();
    this.alertManager = new AlertManager(this.config);
    this.tradeJournal = new TradeJournal(this.database);

    // Init stats
    this.stats = this.createEmptyStats();
  }

  // ═══════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  async initialize(): Promise<void> {
    engineLog.info('Initializing bot engine...');

    // Connect RPC
    await this.connectionManager.initialize();

    // Validate wallet
    if (!this.connectionManager.hasWallet()) {
      engineLog.warn('No wallet configured - bot will run in read-only/scan mode');
    } else {
      const balance = await this.connectionManager.getBalance();
      // Sync capital to actual wallet balance
      this.config.capitalSol = balance;
      this.riskManager.syncCapital(balance);
      engineLog.info({ balance, capitalSol: balance, publicKey: this.connectionManager.getPublicKey().toString() }, 'Wallet loaded — capital synced to wallet balance');
      this.stats.currentBalanceSol = balance;
    }

    await this.completeInitialization();
  }

  /**
   * Lightweight init — only connect RPC, don't require wallet.
   * Used when the user will provide their private key via the web UI.
   * Falls back to full initialize() if RPC is configured via env.
   */
  async initializeDeferred(): Promise<void> {
    engineLog.info('Initializing bot engine (deferred mode — waiting for wallet via UI)...');

    // Connect RPC if configured — gracefully handle all failures so the
    // server starts regardless and the user can fix config via the dashboard.
    try {
      await this.connectionManager.initialize();
    } catch (err: any) {
      engineLog.warn({ error: err.message }, 'RPC initialization failed — server will start but bot requires valid RPC + wallet to trade');
      return;
    }

    // If wallet was loaded from env, complete init fully
    if (this.connectionManager.hasWallet()) {
      const balance = await this.connectionManager.getBalance();
      this.config.capitalSol = balance;
      this.riskManager.syncCapital(balance);
      engineLog.info({ balance, capitalSol: balance, publicKey: this.connectionManager.getPublicKey().toString() }, 'Wallet loaded — capital synced to wallet balance');
      this.stats.currentBalanceSol = balance;
      await this.completeInitialization();
      return;
    }

    engineLog.info('RPC connected. Waiting for wallet connection via UI...');
  }

  /**
   * Connect a wallet dynamically (from UI) and finish engine setup.
   * Returns wallet public key and balance.
   */
  async connectWallet(bs58PrivateKey: string): Promise<{ publicKey: string; balanceSol: number }> {
    if (this.status === 'running') {
      throw new Error('Cannot change wallet while bot is running — stop the bot first');
    }

    if (!this.connectionManager.isInitialized()) {
      throw new Error('RPC not connected — configure HELIUS_RPC_URL first');
    }

    const publicKey = this.connectionManager.setWallet(bs58PrivateKey);
    const balanceSol = await this.connectionManager.getBalance();
    this.stats.currentBalanceSol = balanceSol;

    // Sync capital to actual wallet balance — don't use a hardcoded value
    this.config.capitalSol = balanceSol;
    this.riskManager.syncCapital(balanceSol);

    // Complete initialization if strategies haven't been set up yet
    if (this.strategies.size === 0) {
      await this.completeInitialization();
    }

    engineLog.info({ publicKey, balanceSol, capitalSol: balanceSol }, 'Wallet connected via UI — capital synced to wallet balance');
    return { publicKey, balanceSol };
  }

  /**
   * Disconnect the current wallet and stop the bot if running.
   */
  async disconnectWallet(): Promise<void> {
    if (this.status === 'running') {
      await this.stop();
    }
    this.connectionManager.disconnectWallet();
    this.stats.currentBalanceSol = 0;
    engineLog.info('Wallet disconnected via UI');
  }

  /**
   * Get the current wallet status.
   */
  getWalletStatus(): { connected: boolean; publicKey: string | null; balanceSol: number; rpcConnected: boolean } {
    return {
      connected: this.connectionManager.hasWallet(),
      publicKey: this.connectionManager.hasWallet() ? this.connectionManager.getPublicKey().toString() : null,
      balanceSol: this.stats.currentBalanceSol,
      rpcConnected: this.connectionManager.isInitialized(),
    };
  }

  private async completeInitialization(): Promise<void> {
    // Initialize strategies based on risk profile
    this.initializeStrategies();

    // Connect Geyser if configured (for MEV strategies)
    if (this.config.geyserUrl) {
      try {
        await this.geyserClient.connect();
        this.setupMEVEventHandlers();
        engineLog.info('Geyser client connected - MEV strategies active');
      } catch (err) {
        engineLog.warn({ err }, 'Geyser client not available - MEV strategies (sandwich/frontrun/JIT) disabled');
      }
    } else {
      engineLog.info('No Geyser URL configured - poll-based strategies only');
    }

    // Get initial SOL price
    await this.refreshSolPrice();

    engineLog.info({
      riskLevel: this.config.riskLevel,
      strategies: Array.from(this.strategies.keys()),
      solPrice: this.solPriceUsd,
    }, 'Bot engine initialized');
  }

  async start(): Promise<void> {
    if (this.status === 'running') {
      engineLog.warn('Bot already running');
      return;
    }

    this.status = 'starting';
    this.startedAt = Date.now();
    this.stats = this.createEmptyStats();

    engineLog.info('Starting bot engine...');

    // Start all enabled strategies
    for (const [name, strategy] of this.strategies) {
      strategy.start();
      engineLog.info({ strategy: name }, 'Strategy started');
    }

    // Start pool monitoring
    if (this.riskProfile.strategies.backrun || this.riskProfile.strategies.crossDexArbitrage) {
      // Monitor major pool addresses (would be populated from on-chain data)
      this.poolMonitor.startMonitoring([]);
    }

    this.status = 'running';
    this.stats.status = 'running';
    this.stats.startedAt = new Date().toISOString();
    this.stats.activeStrategies = Array.from(this.strategies.keys());

    // Alert
    await this.alertManager.alertBotStarted();

    // Start main scan loop
    this.runScanLoop();

    // Start periodic tasks
    this.startPeriodicTasks();

    engineLog.info('Bot engine running');
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') return;

    engineLog.info('Stopping bot engine...');
    this.status = 'stopping';

    // Stop scan loop
    if (this.scanLoopTimer) {
      clearTimeout(this.scanLoopTimer);
      this.scanLoopTimer = null;
    }

    // Stop strategies
    for (const [name, strategy] of this.strategies) {
      strategy.stop();
      engineLog.info({ strategy: name }, 'Strategy stopped');
    }

    // Stop monitoring
    this.poolMonitor.stopMonitoring();
    this.geyserClient.disconnect();

    // Wait for in-flight trades (max 30s)
    const openPositions = this.positionTracker.getOpenPositions();
    if (openPositions.length > 0) {
      engineLog.warn({ count: openPositions.length }, 'Open positions at shutdown - will attempt recovery on next start');
    }

    this.status = 'stopped';
    this.stats.status = 'stopped';

    await this.alertManager.alertBotStopped();
    engineLog.info('Bot engine stopped');
  }

  async emergencyStop(): Promise<void> {
    engineLog.error('EMERGENCY STOP triggered');
    this.status = 'stopped';

    // Stop everything immediately
    if (this.scanLoopTimer) {
      clearTimeout(this.scanLoopTimer);
      this.scanLoopTimer = null;
    }

    for (const strategy of this.strategies.values()) {
      strategy.stop();
    }

    this.poolMonitor.stopMonitoring();
    this.geyserClient.disconnect();

    // Try to close open positions
    const openPositions = this.positionTracker.getOpenPositions();
    for (const pos of openPositions) {
      try {
        engineLog.info({ position: pos.tradeId, token: pos.tokenSymbol }, 'Emergency closing position');
        // Queue for stuck token recovery
        this.database.addStuckToken(pos.tokenMint, pos.tokenSymbol, pos.amountLamports.toString(), pos.tradeId);
      } catch (err) {
        engineLog.error({ err, position: pos.tradeId }, 'Failed to queue position for recovery');
      }
    }

    await this.alertManager.sendAlert('critical', 'EMERGENCY STOP', `Bot emergency stopped. ${openPositions.length} positions queued for recovery.`);
    this.stats.status = 'stopped';
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN SCAN LOOP
  // ═══════════════════════════════════════════════════════════════

  private async runScanLoop(): Promise<void> {
    if (this.status !== 'running') return;

    try {
      // Check circuit breaker
      const cbStatus = this.riskManager.getCircuitBreakerStatus();
      if (cbStatus.triggered) {
        this.stats.status = 'circuit_breaker';
        engineLog.warn({ cooldownRemaining: cbStatus.cooldownRemaining }, 'Circuit breaker active');
        this.metrics.updateCircuitBreaker(true, cbStatus.consecutiveFailures);
        await this.alertManager.alertCircuitBreaker(cbStatus.consecutiveFailures);

        // Wait for cooldown
        this.scanLoopTimer = setTimeout(() => this.runScanLoop(), Math.min(cbStatus.cooldownRemaining, 10000));
        return;
      }

      this.stats.status = 'running';
      this.metrics.updateCircuitBreaker(false, 0);

      // Auto emergency stop check (rapid balance drops)
      const autoStopped = await this.riskManager.checkAutoEmergencyStop();
      if (autoStopped) {
        engineLog.error('Auto emergency stop triggered - halting all operations');
        await this.alertManager.sendAlert('critical', 'AUTO EMERGENCY STOP',
          'Bot automatically stopped due to rapid balance drop or critically low balance');
        await this.emergencyStop();
        return;
      }

      // Refresh SOL price
      await this.refreshSolPrice();
      if (!this.solPriceUsd || this.solPriceUsd <= 0) {
        engineLog.warn('No valid SOL price available, skipping scan to protect capital');
        this.scanLoopTimer = setTimeout(() => this.runScanLoop(), 5000);
        return;
      }

      // Recover stuck tokens first
      await this.recoverStuckTokens();

      // Update balance
      if (this.connectionManager.hasWallet()) {
        try {
          this.stats.currentBalanceSol = await this.connectionManager.getBalance();
          this.metrics.updateBalance(this.stats.currentBalanceSol);
        } catch {
          // Non-fatal
        }
      }

      // Run poll-based strategies SEQUENTIALLY to respect API rate limits
      // (1 RPS on Jupiter Basic plan — concurrent scans cause 429 errors)
      const allOpportunities: Opportunity[] = [];
      const EVENT_DRIVEN = new Set(['sandwich', 'frontrun', 'jit-liquidity']);

      for (const [name, strategy] of this.strategies) {
        if (!strategy.isActive()) continue;
        if (EVENT_DRIVEN.has(name)) continue;
        if (this.status !== 'running') break;

        this.stats.totalScans++;
        this.metrics.recordScan(name);

        try {
          const opportunities = await strategy.scan();
          if (opportunities.length > 0) {
            engineLog.info({ strategy: name, count: opportunities.length }, 'Opportunities found');
            allOpportunities.push(...opportunities);
          }
        } catch (err) {
          engineLog.error({ err, strategy: name }, 'Strategy scan failed');
        }
      }

      // Sort all opportunities by expected profit
      allOpportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

      // Track all opportunities for dashboard display (even without execution)
      this.stats.opportunitiesFound += allOpportunities.length;
      for (const opp of allOpportunities) {
        this.recentOpportunities.unshift({
          id: opp.id,
          strategy: opp.strategy,
          tokenPath: opp.tokenPath,
          expectedProfitSol: opp.expectedProfitSol,
          expectedProfitUsd: opp.expectedProfitUsd,
          confidence: opp.confidence,
          timestamp: opp.timestamp,
          metadata: opp.metadata,
        });
      }
      // Cap buffer size
      if (this.recentOpportunities.length > this.MAX_RECENT_OPPORTUNITIES) {
        this.recentOpportunities = this.recentOpportunities.slice(0, this.MAX_RECENT_OPPORTUNITIES);
      }

      // Execute best opportunities (only if wallet is funded)
      const hasBalance = this.stats.currentBalanceSol > 0.01;
      for (const opp of allOpportunities) {
        if (this.status !== 'running') break;
        if (!hasBalance) {
          engineLog.info(
            { path: opp.tokenPath.join('→'), profitUsd: opp.expectedProfitUsd.toFixed(4) },
            'Opportunity found (scan-only mode — wallet not funded)',
          );
          continue;
        }
        await this.executeOpportunity(opp);
      }

      // Broadcast status
      this.broadcastStatus();

    } catch (err) {
      engineLog.error({ err }, 'Scan loop error');
      this.riskManager.reportTradeResult(false, 0);
    }

    // Schedule next scan with ±20% jitter to avoid predictable timing
    const baseInterval = this.getScanInterval();
    const jitter = baseInterval * (0.8 + Math.random() * 0.4);
    this.scanLoopTimer = setTimeout(() => this.runScanLoop(), Math.round(jitter));
  }

  private async executeOpportunity(opp: Opportunity): Promise<void> {
    const log = tradeLogger(opp.id, opp.strategy);

    // ── EXPIRATION CHECK ─────────────────────────────────────────
    if (Date.now() > opp.expiresAt) {
      log.info({ expiredAgoMs: Date.now() - opp.expiresAt }, 'Opportunity expired, skipping');
      this.stats.tradesSkipped++;
      this.metrics.recordTrade(opp.strategy, 'skipped', 0, 0);
      return;
    }

    // ── PRICE IMPACT CHECK ───────────────────────────────────────
    // Reject opportunities where any leg has excessive price impact
    const MAX_PRICE_IMPACT_PCT = 2.0; // 2% max acceptable price impact
    for (const quote of opp.quotes) {
      const impact = parseFloat(quote?.priceImpactPct || '0');
      if (Math.abs(impact) > MAX_PRICE_IMPACT_PCT) {
        log.info(
          { priceImpact: impact, maxAllowed: MAX_PRICE_IMPACT_PCT },
          'Price impact too high, skipping opportunity',
        );
        this.stats.tradesSkipped++;
        this.metrics.recordTrade(opp.strategy, 'skipped', 0, 0);
        return;
      }
    }

    // ── SOL PRICE CHECK ──────────────────────────────────────────
    if (!this.solPriceUsd || this.solPriceUsd <= 0) {
      log.warn('No valid SOL price available, refusing to trade');
      this.stats.tradesSkipped++;
      return;
    }

    // Risk check
    const riskCheck = await this.riskManager.canTrade(
      opp.strategy,
      Number(opp.inputAmountLamports) / 1e9,
      this.solPriceUsd
    );

    if (!riskCheck.allowed) {
      log.info({ reason: riskCheck.reason }, 'Trade blocked by risk manager');
      this.stats.tradesSkipped++;
      this.metrics.recordTrade(opp.strategy, 'skipped', 0, 0);
      return;
    }

    // Use adjusted amount if risk manager reduced it
    const tradeAmountLamports = riskCheck.adjustedAmount
      ? BigInt(Math.floor(riskCheck.adjustedAmount * 1e9))
      : opp.inputAmountLamports;

    log.info({
      strategy: opp.strategy,
      path: opp.tokenPath.join('→'),
      amount: Number(tradeAmountLamports) / 1e9,
      expectedProfit: opp.expectedProfitUsd,
    }, 'Executing opportunity');

    // Start trade journal entry
    this.tradeJournal.startTrade(
      opp.id, opp.strategy,
      opp.mintPath[0], opp.mintPath[opp.mintPath.length - 1],
      tradeAmountLamports.toString(), this.solPriceUsd
    );

    // Open position tracking
    if (opp.mintPath.length > 2) {
      this.positionTracker.openPosition(
        opp.id, opp.strategy,
        opp.mintPath[1], opp.tokenPath[1],
        tradeAmountLamports, this.solPriceUsd
      );
    }

    const startTime = Date.now();

    // Capture pre-trade balance for actual profit verification
    let preTradeBalanceSol = 0;
    try {
      preTradeBalanceSol = await this.connectionManager.getBalance();
    } catch {
      // Non-fatal, we'll use quote-based profit
    }

    try {
      // Execute the trade
      let result: ExecutionResult;

      if (opp.quotes.length === 2) {
        // Standard 2-leg arbitrage: SOL → Token → SOL
        // Use the sequential executor which handles inter-leg verification
        result = await this.executor.executeArbitrageCycle(
          opp.quotes[0],
          opp.mintPath[1],
          opp.tokenPath[1],
          this.solPriceUsd
        );
      } else if (opp.quotes.length >= 3) {
        // Multi-leg: MUST use Jito bundles for atomic execution
        // Sequential execution of 3+ legs is too risky (stuck tokens)
        if (!this.config.jitoEnabled) {
          log.warn('Multi-leg trade requires Jito bundles but JITO_ENABLED=false, skipping');
          this.stats.tradesSkipped++;
          this.metrics.recordTrade(opp.strategy, 'skipped', 0, 0);
          return;
        }

        const txStrings = opp.quotes.map((q: any) => q.swapTransaction).filter(Boolean);
        if (txStrings.length > 0) {
          result = await this.executor.executeViaJitoBundle(txStrings, this.config.jitoTipLamports);
        } else {
          // Quotes don't have pre-built transactions, fall back to 2-leg
          // (only swap first pair as a safer subset)
          log.warn('Multi-leg quotes lack pre-built TXs, falling back to first 2-leg cycle');
          result = await this.executor.executeArbitrageCycle(
            opp.quotes[0],
            opp.mintPath[1],
            opp.tokenPath[1],
            this.solPriceUsd
          );
        }
      } else {
        log.error('Invalid opportunity: no quotes');
        return;
      }

      const latencyMs = Date.now() - startTime;

      if (result.success) {
        this.stats.tradesExecuted++;
        this.stats.tradesSuccessful++;

        // ── ACTUAL BALANCE VERIFICATION ──────────────────────────
        // Use real on-chain balance delta as ground truth for profit
        let verifiedProfitSol = result.profitSol || 0;
        let verifiedProfitUsd = result.profitUsd || 0;
        const estimatedFeesSol = result.jitoTip || 0; // Jito tip already tracked

        if (preTradeBalanceSol > 0) {
          try {
            // Small delay for balance to settle on-chain
            await new Promise(r => setTimeout(r, 1000));
            const postTradeBalanceSol = await this.connectionManager.getBalance();
            const actualDelta = postTradeBalanceSol - preTradeBalanceSol;

            // Use actual delta if it's significantly different from reported
            const reportedVsActualDiff = Math.abs(actualDelta - verifiedProfitSol);
            if (reportedVsActualDiff > 0.0001) { // > 0.0001 SOL discrepancy
              log.warn({
                reportedProfitSol: verifiedProfitSol.toFixed(6),
                actualDeltaSol: actualDelta.toFixed(6),
                discrepancy: reportedVsActualDiff.toFixed(6),
              }, 'Balance delta differs from reported profit - using actual');
            }
            // Always trust the on-chain balance delta
            verifiedProfitSol = actualDelta;
            verifiedProfitUsd = actualDelta * this.solPriceUsd;
          } catch {
            // If post-trade balance check fails, use executor's calculation
            log.warn('Post-trade balance check failed, using executor profit estimate');
          }
        }

        this.stats.totalProfitSol += verifiedProfitSol;
        this.stats.totalProfitUsd += verifiedProfitUsd;

        // Record everywhere with VERIFIED profit
        this.riskManager.reportTradeResult(true, verifiedProfitSol);
        this.pnlTracker.recordTrade(
          opp.id, opp.strategy,
          verifiedProfitSol, verifiedProfitUsd,
          result.gasUsed || 0, estimatedFeesSol * this.solPriceUsd
        );
        this.metrics.recordTrade(opp.strategy, 'success', verifiedProfitSol, latencyMs);
        // Compute the output amount from input + verified profit
        const outputLamports = tradeAmountLamports + BigInt(Math.round(verifiedProfitSol * 1e9));
        const outputAmountStr = outputLamports.toString();

        this.tradeJournal.completeTrade(
          opp.id,
          outputAmountStr,
          verifiedProfitSol,
          verifiedProfitUsd,
          result.gasUsed || 0,
          result.jitoTip || 0,
          result.signatures,
          opp.tokenPath.join('→')
        );

        // Close position
        this.positionTracker.closePosition(opp.id, outputLamports, this.solPriceUsd);

        log.info({
          verifiedProfitSol: verifiedProfitSol.toFixed(6),
          verifiedProfitUsd: verifiedProfitUsd.toFixed(2),
          signatures: result.signatures,
          latencyMs,
        }, 'Trade successful (profit verified via balance delta)');

        // Alert on significant profit
        if ((result.profitUsd || 0) > 1.0) {
          await this.alertManager.alertTradeExecuted(opp.strategy, result.profitSol || 0, result.profitUsd || 0);
        }

        // Broadcast to dashboard
        this.broadcastTrade(opp, result, latencyMs);
      } else {
        this.stats.tradesFailed++;
        this.riskManager.reportTradeResult(false, 0);
        this.metrics.recordTrade(opp.strategy, 'failed', 0, latencyMs);
        this.tradeJournal.failTrade(opp.id, result.error || 'Unknown error', result.signatures);

        log.error({ error: result.error, signatures: result.signatures }, 'Trade failed');

        // Handle stuck tokens
        if (result.stuckToken) {
          this.database.addStuckToken(
            result.stuckToken.tokenMint,
            result.stuckToken.tokenSymbol || opp.tokenPath[1] || 'UNKNOWN',
            String(result.stuckToken.estimatedBalanceLamports),
            opp.id
          );
          await this.alertManager.alertStuckToken(
            result.stuckToken.tokenSymbol || opp.tokenPath[1] || 'UNKNOWN',
            result.stuckToken.tokenMint,
            String(result.stuckToken.estimatedBalanceLamports)
          );
        }
      }
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.stats.tradesFailed++;
      this.riskManager.reportTradeResult(false, 0);
      this.metrics.recordTrade(opp.strategy, 'failed', 0, latencyMs);
      this.tradeJournal.failTrade(opp.id, (err as Error).message);
      log.error({ err }, 'Trade execution error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MEV EVENT HANDLERS (for Geyser-driven strategies)
  // ═══════════════════════════════════════════════════════════════

  private setupMEVEventHandlers(): void {
    // Register pending transaction handler for sandwich/frontrun/JIT strategies
    this.geyserClient.onTransaction(async (txData) => {
      if (this.status !== 'running') return;

      for (const strategy of this.mevStrategies) {
        try {
          if (!strategy.isActive()) continue;

          if (strategy instanceof SandwichStrategy) {
            // Adapt geyser ParsedTransactionData to the strategy's local format
            const adapted = this.instructionDecoderAdapter.decodeTransaction(txData);
            if (!adapted) continue;
            const opp = await strategy.onPendingTransaction(adapted);
            if (opp) await this.executeOpportunity(opp);
          } else if (strategy instanceof FrontrunStrategy) {
            const adapted = this.instructionDecoderAdapter.decodeTransaction(txData);
            if (!adapted) continue;
            const opp = await strategy.onPendingTransaction(adapted);
            if (opp) await this.executeOpportunity(opp);
          }
          // JIT liquidity uses onPendingSwap with decoded swap details
          // It will be connected when instructionDecoder integration is complete
        } catch (err) {
          engineLog.error({ err, strategy: strategy.getName() }, 'MEV event handler error');
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // STRATEGIES INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  private initializeStrategies(): void {
    const profile = this.riskProfile;
    const baseConfig = {
      slippageBps: profile.slippageBps,
      minProfitUsd: profile.minProfitUsd,
      maxPositionSol: profile.maxPositionSol,
    };

    if (profile.strategies.cyclicArbitrage) {
      const strategy = new CyclicArbitrageStrategy(
        this.connectionManager, this.config, this.riskProfile
      );
      this.strategies.set('cyclic-arbitrage', strategy);
    }

    if (profile.strategies.multiHopArbitrage) {
      const strategy = new MultiHopArbitrageStrategy(
        this.connectionManager, this.config, this.riskProfile
      );
      this.strategies.set('multi-hop-arbitrage', strategy);
    }

    if (profile.strategies.crossDexArbitrage) {
      const strategy = new CrossDexArbitrageStrategy(
        this.connectionManager, this.config, this.riskProfile
      );
      this.strategies.set('cross-dex-arbitrage', strategy);
    }

    if (profile.strategies.sandwich) {
      const strategy = new SandwichStrategy(
        this.connectionManager, this.config, this.riskProfile,
        this.geyserClient as any, this.instructionDecoderAdapter as any
      );
      this.strategies.set('sandwich', strategy);
      this.mevStrategies.push(strategy);
    }

    if (profile.strategies.frontrun) {
      const strategy = new FrontrunStrategy(
        this.connectionManager, this.config, this.riskProfile,
        this.geyserClient as any, this.instructionDecoderAdapter as any
      );
      this.strategies.set('frontrun', strategy);
      this.mevStrategies.push(strategy);
    }

    if (profile.strategies.backrun) {
      const strategy = new BackrunStrategy(
        this.connectionManager, this.config, this.riskProfile
      );
      this.strategies.set('backrun', strategy);
    }

    if (profile.strategies.liquidation) {
      const strategy = new LiquidationStrategy(
        this.connectionManager, this.config, this.riskProfile
      );
      this.strategies.set('liquidation', strategy);
    }

    if (profile.strategies.jitLiquidity) {
      const strategy = new JITLiquidityStrategy(
        this.connectionManager, this.config, this.riskProfile, this.geyserClient as any
      );
      this.strategies.set('jit-liquidity', strategy);
      this.mevStrategies.push(strategy as any);
    }

    // Sniping strategy (uses its own pool detection + execution pipeline)
    if (this.config.snipingEnabled && profile.strategies.sniping) {
      const strategy = new SnipingStrategy(this.connectionManager, this.config);
      this.strategies.set('sniping', strategy);
      this.snipingStrategy = strategy;
    }

    engineLog.info(
      { strategies: Array.from(this.strategies.keys()) },
      `Initialized ${this.strategies.size} strategies`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // STUCK TOKEN RECOVERY
  // ═══════════════════════════════════════════════════════════════

  private async recoverStuckTokens(): Promise<void> {
    const stuckTokens = this.database.getStuckTokens();
    if (stuckTokens.length === 0) return;

    engineLog.info({ count: stuckTokens.length }, 'Attempting stuck token recovery');

    for (const stuck of stuckTokens) {
      try {
        // Check if we still hold the token
        const balance = await this.connectionManager.getTokenBalance(stuck.token_mint);
        if (balance <= 0n) {
          this.database.markTokenRecovered(stuck.id, 'already_recovered');
          engineLog.info({ symbol: stuck.symbol }, 'Stuck token already recovered');
          continue;
        }

        // Use aggressive slippage for recovery - we want OUT of this position
        // Start with normal slippage, escalate if repeated failures
        const recoverySlippageBps = Math.min(
          500, // 5% max recovery slippage
          this.riskProfile.slippageBps * 3, // 3x normal slippage
        );

        // Get a proper Jupiter quote for the recovery swap
        const quoteUrl = new URL(`${this.config.jupiterApiUrl}/swap/v1/quote`);
        quoteUrl.searchParams.set('inputMint', stuck.token_mint);
        quoteUrl.searchParams.set('outputMint', 'So11111111111111111111111111111111111111112');
        quoteUrl.searchParams.set('amount', balance.toString());
        quoteUrl.searchParams.set('slippageBps', recoverySlippageBps.toString());

        const quoteResp = await fetch(quoteUrl.toString());
        if (!quoteResp.ok) {
          engineLog.warn({ symbol: stuck.symbol, status: quoteResp.status }, 'Failed to get recovery quote');
          continue;
        }
        const recoveryQuote = await quoteResp.json();

        // Check if recovery output is worth the gas (don't waste SOL on dust)
        const outputLamports = parseInt(recoveryQuote.outAmount || '0', 10);
        const MIN_RECOVERY_LAMPORTS = 50_000; // ~0.00005 SOL minimum to bother
        if (outputLamports < MIN_RECOVERY_LAMPORTS) {
          engineLog.info(
            { symbol: stuck.symbol, outputLamports, min: MIN_RECOVERY_LAMPORTS },
            'Stuck token value too low to recover, marking as dust',
          );
          this.database.markTokenRecovered(stuck.id, 'dust_too_small');
          continue;
        }

        // Swap back to SOL
        const result = await this.executor.executeQuotedSwap(
          recoveryQuote,
          recoverySlippageBps,
        );

        if (result.success) {
          const recoveredSol = outputLamports / 1e9;
          this.database.markTokenRecovered(stuck.id, result.signatures[0] || 'recovered');
          engineLog.info(
            { symbol: stuck.symbol, signature: result.signatures[0], recoveredSol: recoveredSol.toFixed(6) },
            'Stuck token recovered successfully',
          );
          await this.alertManager.sendAlert('info', 'Token Recovered',
            `Recovered ${recoveredSol.toFixed(4)} SOL from stuck ${stuck.symbol}`);
        }
      } catch (err) {
        engineLog.error({ err, symbol: stuck.symbol }, 'Stuck token recovery failed');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SOL PRICE
  // ═══════════════════════════════════════════════════════════════

  private async refreshSolPrice(): Promise<void> {
    const now = Date.now();
    // Cache for 60s — SOL price doesn't need sub-minute precision for profit calc
    if (this.solPriceUsd > 0 && now - this.solPriceCacheTs < 60_000) return;

    // Try CoinGecko free API first (doesn't burn Jupiter quota)
    try {
      const cgResp = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { signal: AbortSignal.timeout(5000) },
      );
      if (cgResp.ok) {
        const data = await cgResp.json();
        const price = data?.solana?.usd;
        if (price && price > 0 && price < 100000) {
          this.solPriceUsd = price;
          this.solPriceCacheTs = now;
          this.stats.currentSolPriceUsd = price;
          this.config.solPriceUsd = price;
          engineLog.debug({ price }, 'SOL price refreshed via CoinGecko');
          return;
        }
      }
    } catch {
      // CoinGecko failed, try Jupiter fallback
    }

    // Fallback: Jupiter quote (costs 1 API call)
    try {
      const url = new URL(`${this.config.jupiterApiUrl}/swap/v1/quote`);
      url.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112');
      url.searchParams.set('outputMint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      url.searchParams.set('amount', '1000000000'); // 1 SOL
      url.searchParams.set('slippageBps', '50');

      const resp = await fetch(url.toString());
      if (!resp.ok) throw new Error(`Quote failed: ${resp.status}`);
      const quote = await resp.json();
      const price = parseInt(quote.outAmount) / 1e6;

      if (price > 0 && price < 100000) {
        this.solPriceUsd = price;
        this.solPriceCacheTs = now;
        this.stats.currentSolPriceUsd = price;
        this.config.solPriceUsd = price;
        engineLog.debug({ price }, 'SOL price refreshed via Jupiter');
      }
    } catch (err) {
      if (this.solPriceUsd > 0 && Date.now() - this.solPriceCacheTs < 300_000) {
        // Cache is less than 5 min old, acceptable to use
        engineLog.warn({ err, cachedPrice: this.solPriceUsd }, 'SOL price refresh failed, using recent cache');
      } else {
        // Cache is stale or doesn't exist - clear it to halt trading
        engineLog.error({ err }, 'SOL price unavailable and cache too old - trading will pause');
        this.solPriceUsd = 0;
        this.config.solPriceUsd = 0;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PERIODIC TASKS
  // ═══════════════════════════════════════════════════════════════

  private startPeriodicTasks(): void {
    // Health check RPC every 30s
    setInterval(async () => {
      if (this.status !== 'running') return;
      try {
        const health = await this.connectionManager.healthCheck();
        this.metrics.recordRpcCall('healthcheck', health.primary || health.backup);
      } catch {
        // Non-fatal
      }
    }, 30000);

    // Update metrics every 10s
    setInterval(() => {
      if (this.status !== 'running') return;
      this.metrics.updatePositions(this.positionTracker.getPositionCount());
      const dailyPnl = this.pnlTracker.getDailyPnL();
      if (dailyPnl) {
        this.metrics.updateDailyPnL(dailyPnl.net_profit_sol, dailyPnl.net_profit_usd);
      }
    }, 10000);

    // Check for aged positions every 60s
    setInterval(() => {
      if (this.status !== 'running') return;
      const aged = this.positionTracker.getOldPositions(300000); // 5 min
      for (const pos of aged) {
        engineLog.warn({ tradeId: pos.tradeId, age: Date.now() - pos.entryTimestamp, token: pos.tokenSymbol }, 'Position aging');
      }
    }, 60000);

    // Balance check + low balance alert every 5 min
    setInterval(async () => {
      if (this.status !== 'running' || !this.connectionManager.hasWallet()) return;
      try {
        const balance = await this.connectionManager.getBalance();
        this.stats.currentBalanceSol = balance;
        this.metrics.updateBalance(balance);

        if (balance < 0.1) {
          await this.alertManager.alertBalanceLow(balance, 0.1);
        }
      } catch {
        // Non-fatal
      }
    }, 300000);
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  private getScanInterval(): number {
    // With serialized strategies and trimmed token lists (~10 cyclic + 6 cross-dex + 6 multi-hop pairs),
    // each full cycle takes ~40-60s at 1 RPS. Use a short pause between cycles.
    const hour = new Date().getUTCHours();
    // High activity: minimal pause between cycles
    if ((hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 16) || (hour >= 21 && hour <= 24)) {
      return 3_000;
    }
    // Low activity: slightly longer pause
    return 5_000;
  }

  private createEmptyStats(): BotStats {
    return {
      status: 'stopped',
      uptime: 0,
      startedAt: null,
      totalScans: 0,
      opportunitiesFound: 0,
      tradesExecuted: 0,
      tradesSuccessful: 0,
      tradesFailed: 0,
      tradesSkipped: 0,
      totalProfitSol: 0,
      totalProfitUsd: 0,
      currentBalanceSol: 0,
      currentSolPriceUsd: 0,
      activeStrategies: [],
      riskLevel: this.config.riskLevel,
      wsClients: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // BROADCASTING
  // ═══════════════════════════════════════════════════════════════

  setWebSocketBroadcaster(broadcaster: WebSocketBroadcaster): void {
    this.wsBroadcaster = broadcaster;
  }

  private broadcastStatus(): void {
    if (!this.wsBroadcaster) return;
    this.stats.uptime = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    this.stats.wsClients = this.wsBroadcaster.getClientCount();
    this.wsBroadcaster.broadcastStatus(this.stats);

    // Broadcast sniping data if active
    if (this.snipingStrategy) {
      const snipeStats = this.snipingStrategy.getSnipingStats();
      const openPositions = this.snipingStrategy.getOpenSnipePositions();
      this.wsBroadcaster.broadcast('sniping', {
        stats: snipeStats,
        openPositions: openPositions.map(p => ({
          id: p.id,
          token: p.tokenSymbol,
          mint: p.tokenMint,
          entryAmountSol: p.entryAmountSol,
          entryTimestamp: p.entryTimestamp,
          status: p.status,
          tier1Sold: p.tier1Sold,
          tier2Sold: p.tier2Sold,
          tier3Sold: p.tier3Sold,
          totalSolRecovered: p.totalSolRecovered,
          realizedProfitSol: p.realizedProfitSol,
        })),
      });
    }
  }

  private broadcastTrade(opp: Opportunity, result: ExecutionResult, latencyMs: number): void {
    if (!this.wsBroadcaster) return;
    this.wsBroadcaster.broadcastTrade({
      tradeId: opp.id,
      strategy: opp.strategy,
      path: opp.tokenPath.join('→'),
      profitSol: result.profitSol,
      profitUsd: result.profitUsd,
      signatures: result.signatures,
      latencyMs,
      timestamp: Date.now(),
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC GETTERS (for API routes)
  // ═══════════════════════════════════════════════════════════════

  getStatus(): BotStats {
    this.stats.uptime = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    return { ...this.stats };
  }

  getConfig(): BotConfig {
    return this.config;
  }

  getRiskProfile(): RiskProfile {
    return this.riskProfile;
  }

  getDatabase(): BotDatabase {
    return this.database;
  }

  getMetrics(): MetricsCollector {
    return this.metrics;
  }

  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  getPnLTracker(): PnLTracker {
    return this.pnlTracker;
  }

  getPositionTracker(): PositionTracker {
    return this.positionTracker;
  }

  getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  getStats(): BotStats {
    return {
      ...this.stats,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      currentSolPriceUsd: this.solPriceUsd,
    };
  }

  getRecentOpportunities(): typeof this.recentOpportunities {
    return this.recentOpportunities;
  }

  getRiskStatus(): Record<string, any> {
    return {
      riskLevel: this.config.riskLevel,
      capitalSol: this.config.capitalSol,
    };
  }

  getCircuitBreakerStatus(): Record<string, any> {
    try {
      return this.riskManager.getCircuitBreakerStatus();
    } catch {
      return { triggered: false, consecutiveFailures: 0 };
    }
  }

  getSnipingStrategy(): SnipingStrategy | null {
    return this.snipingStrategy;
  }

  setRiskLevel(level: string): void {
    if (level in RISK_PROFILES) {
      this.config.riskLevel = level as any;
      this.riskProfile = RISK_PROFILES[level as keyof typeof RISK_PROFILES];
      this.stats.riskLevel = level;
      engineLog.info({ level }, 'Risk level changed');
    }
  }

  // Cleanup
  async shutdown(): Promise<void> {
    await this.stop();
    this.database.close();
    engineLog.info('Bot engine shut down completely');
  }
}
