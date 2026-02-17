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
import { InstructionDecoder } from './instructionDecoder.js';
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
  private instructionDecoder: InstructionDecoder;

  // Monitoring
  private metrics: MetricsCollector;
  private alertManager: AlertManager;
  private tradeJournal: TradeJournal;
  private wsBroadcaster: WebSocketBroadcaster | null = null;

  // Strategies
  private strategies: Map<string, BaseStrategy> = new Map();
  private mevStrategies: Array<SandwichStrategy | FrontrunStrategy | JITLiquidityStrategy> = [];

  // State
  private status: BotStatus = 'stopped';
  private startedAt: number = 0;
  private scanLoopTimer: ReturnType<typeof setTimeout> | null = null;
  private solPriceUsd: number = 0;
  private solPriceCacheTs: number = 0;
  private stats: BotStats;

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
    this.positionTracker = new PositionTracker();
    this.riskManager = new RiskManager(this.config, this.pnlTracker, this.positionTracker, this.connectionManager);

    // Data
    this.geyserClient = new GeyserClient(this.config);
    this.poolMonitor = new PoolMonitor(this.connectionManager, this.config);
    this.instructionDecoder = new InstructionDecoder();

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
      engineLog.info({ balance, publicKey: this.connectionManager.getPublicKey().toString() }, 'Wallet balance');
      this.stats.currentBalanceSol = balance;
    }

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

      // Refresh SOL price
      await this.refreshSolPrice();
      if (!this.solPriceUsd) {
        engineLog.warn('No SOL price available, skipping scan');
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

      // Run poll-based strategies (cyclic, multi-hop, cross-dex, backrun, liquidation)
      const allOpportunities: Opportunity[] = [];

      for (const [name, strategy] of this.strategies) {
        if (!strategy.isActive()) continue;

        // Skip event-driven strategies in poll loop
        if (name === 'sandwich' || name === 'frontrun' || name === 'jit-liquidity') continue;

        try {
          this.stats.totalScans++;
          this.metrics.recordScan(name);

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

      // Execute best opportunities (up to concurrent trade limit)
      this.stats.opportunitiesFound += allOpportunities.length;

      for (const opp of allOpportunities) {
        if (this.status !== 'running') break;

        await this.executeOpportunity(opp);
      }

      // Broadcast status
      this.broadcastStatus();

    } catch (err) {
      engineLog.error({ err }, 'Scan loop error');
      this.riskManager.reportTradeResult(false, 0);
    }

    // Schedule next scan
    const interval = this.getScanInterval();
    this.scanLoopTimer = setTimeout(() => this.runScanLoop(), interval);
  }

  private async executeOpportunity(opp: Opportunity): Promise<void> {
    const log = tradeLogger(opp.id, opp.strategy);

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
        tradeAmountLamports.toString(), this.solPriceUsd
      );
    }

    const startTime = Date.now();

    try {
      // Execute the trade
      let result: ExecutionResult;

      if (opp.quotes.length === 2) {
        // Standard 2-leg arbitrage: SOL → Token → SOL
        result = await this.executor.executeArbitrageCycle(
          opp.quotes[0],
          opp.mintPath[1],
          opp.tokenPath[1],
          this.solPriceUsd
        );
      } else if (opp.quotes.length >= 3) {
        // Multi-leg: execute via Jito bundle if possible
        if (this.config.jitoEnabled) {
          const txStrings = opp.quotes.map((q: any) => q.swapTransaction).filter(Boolean);
          if (txStrings.length > 0) {
            result = await this.executor.executeViaJitoBundle(txStrings, this.config.jitoTipLamports);
          } else {
            // Fall back to sequential execution
            result = await this.executor.executeArbitrageCycle(
              opp.quotes[0],
              opp.mintPath[1],
              opp.tokenPath[1],
              this.solPriceUsd
            );
          }
        } else {
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
        this.stats.totalProfitSol += result.profitSol || 0;
        this.stats.totalProfitUsd += result.profitUsd || 0;

        // Record everywhere
        this.riskManager.reportTradeResult(true, result.profitSol || 0);
        this.pnlTracker.recordTrade(
          opp.id, opp.strategy,
          result.profitSol || 0, result.profitUsd || 0,
          result.gasUsed || 0, (result.gasUsed || 0) * this.solPriceUsd
        );
        this.metrics.recordTrade(opp.strategy, 'success', result.profitSol || 0, latencyMs);
        this.tradeJournal.completeTrade(
          opp.id,
          result.outputAmount || '0',
          result.profitSol || 0,
          result.profitUsd || 0,
          result.gasUsed || 0,
          result.jitoTip || 0,
          result.signatures,
          opp.tokenPath.join('→')
        );

        // Close position
        this.positionTracker.closePosition(opp.id, result.outputAmount || '0', this.solPriceUsd);

        log.info({
          profitSol: result.profitSol,
          profitUsd: result.profitUsd,
          signatures: result.signatures,
          latencyMs,
        }, 'Trade successful');

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
        if (result.needsRecovery && result.stuckTokenMint) {
          this.database.addStuckToken(
            result.stuckTokenMint,
            opp.tokenPath[1] || 'UNKNOWN',
            result.stuckTokenBalance || '0',
            opp.id
          );
          await this.alertManager.alertStuckToken(
            opp.tokenPath[1] || 'UNKNOWN',
            result.stuckTokenMint,
            result.stuckTokenBalance || '0'
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
            const opp = await strategy.onPendingTransaction(txData);
            if (opp) await this.executeOpportunity(opp);
          } else if (strategy instanceof FrontrunStrategy) {
            const opp = await strategy.onPendingTransaction(txData);
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
        this.connectionManager, this.config, this.geyserClient, this.instructionDecoder
      );
      this.strategies.set('sandwich', strategy);
      this.mevStrategies.push(strategy);
    }

    if (profile.strategies.frontrun) {
      const strategy = new FrontrunStrategy(
        this.connectionManager, this.config, this.geyserClient, this.instructionDecoder
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
        this.connectionManager, this.config, this.riskProfile, this.geyserClient
      );
      this.strategies.set('jit-liquidity', strategy);
      this.mevStrategies.push(strategy as any);
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

        // Try to swap back to SOL
        const result = await this.executor.executeQuotedSwap(
          { inputMint: stuck.token_mint, outputMint: 'So11111111111111111111111111111111111111112', amount: balance.toString() },
          this.riskProfile.slippageBps
        );

        if (result.success) {
          this.database.markTokenRecovered(stuck.id, result.signatures[0] || 'recovered');
          engineLog.info({ symbol: stuck.symbol, signature: result.signatures[0] }, 'Stuck token recovered');
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
    if (this.solPriceUsd > 0 && now - this.solPriceCacheTs < 30000) return;

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
      }
    } catch (err) {
      if (this.solPriceUsd > 0) {
        engineLog.warn({ err }, 'SOL price refresh failed, using cached');
      } else {
        engineLog.error({ err }, 'SOL price unavailable');
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
        engineLog.warn({ tradeId: pos.tradeId, age: Date.now() - pos.openedAt, token: pos.tokenSymbol }, 'Position aging');
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
    const hour = new Date().getUTCHours();
    // High activity: faster scanning
    if ((hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 16) || (hour >= 21 && hour <= 24)) {
      return Math.max(5000, Math.ceil(1000 / this.config.maxRequestsPerSecond) * SCAN_TOKENS.length * 2 + 2000);
    }
    return Math.max(10000, Math.ceil(1000 / this.config.maxRequestsPerSecond) * SCAN_TOKENS.length * 2 + 5000);
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
