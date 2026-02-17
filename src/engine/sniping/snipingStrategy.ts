// SNIPING STRATEGY
// Extends BaseStrategy to integrate pool detection, safety filtering,
// and snipe execution into the bot engine's scan loop.
//
// Capital rules:
//   - Bot snipe wallet: 2 SOL max hard cap
//   - Daily halt: if wallet drops to 1.5 SOL from snipe losses, stop for 24h
//   - Max 5 snipes per hour
//   - After 3 consecutive stop-losses: 1 hour pause
//   - Max 3 concurrent open snipes

import { BaseStrategy, Opportunity, StrategyConfig } from '../strategies/baseStrategy.js';
import { strategyLog } from '../logger.js';
import { BotConfig, SOL_MINT, LAMPORTS_PER_SOL } from '../config.js';
import { ConnectionManager } from '../connectionManager.js';
import { PoolDetector, NewPoolInfo } from './poolDetector.js';
import { TokenSafetyFilter, SafetyResult, TokenCheckInput } from './tokenSafetyFilter.js';
import { SnipeExecutor, SnipePosition, SnipeResult } from './snipeExecutor.js';

// ── Capital Rule Constants ────────────────────────────────────────────────────
const MAX_SNIPE_WALLET_SOL = 2.0;          // Hard cap for sniping capital
const DAILY_HALT_THRESHOLD_SOL = 1.5;      // Stop sniping if wallet drops below this
const DAILY_HALT_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SNIPES_PER_HOUR = 5;
const MAX_CONCURRENT_SNIPES = 3;
const CONSECUTIVE_SL_LIMIT = 3;
const CONSECUTIVE_SL_PAUSE_MS = 60 * 60 * 1000; // 1 hour pause after 3 SL

export interface SnipingStats {
  poolsDetected: number;
  tokensEvaluated: number;
  tokensPassed: number;
  tokensRejected: number;
  snipesExecuted: number;
  snipesSuccessful: number;
  snipesFailed: number;
  totalProfitSol: number;
  openPositions: number;
  consecutiveStopLosses: number;
  snipesThisHour: number;
  isPaused: boolean;
  pauseReason: string | null;
  pauseExpiresAt: number | null;
}

export class SnipingStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private poolDetector: PoolDetector;
  private safetyFilter: TokenSafetyFilter;
  private snipeExecutor: SnipeExecutor;

  // Pool queue: pools detected since last scan() call
  private poolQueue: NewPoolInfo[] = [];

  // Capital rules state
  private snipeAmountSol: number;
  private consecutiveStopLosses: number = 0;
  private snipeTimestamps: number[] = [];  // timestamps of recent snipes for rate limiting
  private pausedUntil: number = 0;
  private pauseReason: string | null = null;
  private dailyHaltUntil: number = 0;
  private initialWalletSol: number = 0;    // Tracked at start of day for daily halt logic

  // Stats
  private snipingStats: SnipingStats = {
    poolsDetected: 0,
    tokensEvaluated: 0,
    tokensPassed: 0,
    tokensRejected: 0,
    snipesExecuted: 0,
    snipesSuccessful: 0,
    snipesFailed: 0,
    totalProfitSol: 0,
    openPositions: 0,
    consecutiveStopLosses: 0,
    snipesThisHour: 0,
    isPaused: false,
    pauseReason: null,
    pauseExpiresAt: null,
  };

  constructor(connectionManager: ConnectionManager, config: BotConfig) {
    const strategyConfig: StrategyConfig = {
      name: 'sniping',
      enabled: true,
      scanIntervalMs: 1_000,  // Check pool queue every 1s
      minProfitUsd: 0,        // Sniping doesn't use arb profit thresholds
      maxPositionSol: MAX_SNIPE_WALLET_SOL,
      slippageBps: 1500,      // 15% for new tokens
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.snipeAmountSol = config.snipeAmountSol || 0.1;

    // Create sub-components
    this.poolDetector = new PoolDetector(connectionManager, config);
    this.safetyFilter = new TokenSafetyFilter(connectionManager, config);
    this.snipeExecutor = new SnipeExecutor(connectionManager, config);

    // Wire pool detection → queue
    this.poolDetector.onNewPool((pool) => {
      this.poolQueue.push(pool);
      this.snipingStats.poolsDetected++;
      strategyLog.info(
        { source: pool.source, base: pool.baseMint.slice(0, 8), liq: (pool.initialLiquidityLamports / LAMPORTS_PER_SOL).toFixed(2) },
        'Pool queued for evaluation',
      );
    });

    // Wire position updates for stats tracking
    this.snipeExecutor.onPositionUpdate((pos) => {
      this.snipingStats.openPositions = this.snipeExecutor.getOpenPositionCount();
      if (pos.status === 'closed') {
        this.snipingStats.totalProfitSol += pos.realizedProfitSol;

        // Track consecutive stop-losses
        if (pos.exitReason === 'stop_loss' || pos.exitReason === 'timeout' || pos.exitReason === 'rug_detected') {
          this.consecutiveStopLosses++;
          this.snipingStats.consecutiveStopLosses = this.consecutiveStopLosses;
          strategyLog.warn(
            { consecutive: this.consecutiveStopLosses, reason: pos.exitReason },
            'Snipe position closed at loss',
          );
        } else {
          // Profitable exit resets the counter
          this.consecutiveStopLosses = 0;
          this.snipingStats.consecutiveStopLosses = 0;
        }
      }
    });
  }

  getName(): string {
    return 'Token Sniping (New Launches)';
  }

  // Override start to also start the pool detector
  start(): void {
    super.start();
    this.poolDetector.start();
    this.initialWalletSol = 0; // Will be set on first scan
    strategyLog.info('SnipingStrategy started');
  }

  // Override stop to clean up
  stop(): void {
    super.stop();
    this.poolDetector.stop();
    this.snipeExecutor.shutdown();
    strategyLog.info('SnipingStrategy stopped');
  }

  // ═══════════════════════════════════════════════════════════════
  // SCAN — called by BotEngine on each scan loop iteration
  // ═══════════════════════════════════════════════════════════════

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];
    this.scanCount++;

    // Prune old data periodically
    if (this.scanCount % 100 === 0) {
      this.poolDetector.pruneSeenSignatures();
    }

    // ── Capital rule checks ─────────────────────────────────────
    const now = Date.now();

    // Check daily halt
    if (now < this.dailyHaltUntil) {
      return [];
    }

    // Check pause (consecutive stop-losses)
    if (now < this.pausedUntil) {
      this.snipingStats.isPaused = true;
      this.snipingStats.pauseReason = this.pauseReason;
      this.snipingStats.pauseExpiresAt = this.pausedUntil;
      return [];
    }
    this.snipingStats.isPaused = false;
    this.snipingStats.pauseReason = null;
    this.snipingStats.pauseExpiresAt = null;

    // Check consecutive stop-loss pause trigger
    if (this.consecutiveStopLosses >= CONSECUTIVE_SL_LIMIT) {
      this.pausedUntil = now + CONSECUTIVE_SL_PAUSE_MS;
      this.pauseReason = `${CONSECUTIVE_SL_LIMIT} consecutive stop-losses`;
      this.consecutiveStopLosses = 0; // Reset counter after applying pause
      strategyLog.warn(
        { pauseUntil: new Date(this.pausedUntil).toISOString() },
        'Sniping paused: consecutive stop-losses',
      );
      return [];
    }

    // Check wallet balance for daily halt
    try {
      const walletSol = await this.connectionManager.getBalance();
      if (this.initialWalletSol === 0) {
        this.initialWalletSol = walletSol;
      }
      if (walletSol < DAILY_HALT_THRESHOLD_SOL) {
        this.dailyHaltUntil = now + DAILY_HALT_DURATION_MS;
        strategyLog.warn(
          { walletSol, threshold: DAILY_HALT_THRESHOLD_SOL, haltUntil: new Date(this.dailyHaltUntil).toISOString() },
          'DAILY HALT: Wallet below threshold',
        );
        return [];
      }
    } catch {
      // Can't check balance - skip this cycle
      return [];
    }

    // ── Process pool queue ──────────────────────────────────────
    const pools = this.poolQueue.splice(0, this.poolQueue.length);
    if (pools.length === 0) return [];

    // Prune hourly snipe rate
    this.snipeTimestamps = this.snipeTimestamps.filter(t => now - t < 3_600_000);
    this.snipingStats.snipesThisHour = this.snipeTimestamps.length;

    for (const pool of pools) {
      // Rate limit: max snipes per hour
      if (this.snipeTimestamps.length >= MAX_SNIPES_PER_HOUR) {
        strategyLog.info('Max snipes per hour reached, skipping remaining pools');
        break;
      }

      // Concurrency limit
      if (this.snipeExecutor.getOpenPositionCount() >= MAX_CONCURRENT_SNIPES) {
        strategyLog.info(
          { open: this.snipeExecutor.getOpenPositionCount() },
          'Max concurrent snipes reached, skipping',
        );
        break;
      }

      // Only snipe SOL-paired pools
      if (pool.quoteMint !== SOL_MINT) {
        strategyLog.debug({ quote: pool.quoteMint }, 'Skipping non-SOL pool');
        continue;
      }

      // ── Safety filter ──────────────────────────────────────
      this.snipingStats.tokensEvaluated++;

      const checkInput: TokenCheckInput = {
        tokenMint: pool.baseMint,
        poolAddress: pool.poolAddress,
        initialLiquidityLamports: pool.initialLiquidityLamports,
        poolCreatedAt: pool.detectedAt,
        lpMint: pool.lpMint,
      };

      let safety: SafetyResult;
      try {
        safety = await this.safetyFilter.check(checkInput);
      } catch (err) {
        strategyLog.error({ err, token: pool.baseMint.slice(0, 8) }, 'Safety check failed');
        this.snipingStats.tokensRejected++;
        continue;
      }

      // Log every token seen
      strategyLog.info(
        {
          token: pool.baseMint.slice(0, 8),
          source: pool.source,
          score: safety.score,
          passed: safety.passed,
          reason: safety.rejectReason,
        },
        `Token evaluated: ${safety.passed ? 'ACCEPTED' : 'REJECTED'}`,
      );

      if (!safety.passed) {
        this.snipingStats.tokensRejected++;
        continue;
      }

      this.snipingStats.tokensPassed++;

      // ── Execute snipe ──────────────────────────────────────
      this.snipingStats.snipesExecuted++;
      this.snipeTimestamps.push(now);

      let result: SnipeResult;
      try {
        result = await this.snipeExecutor.executeSnipe(
          pool.baseMint,
          `TOKEN_${pool.baseMint.slice(0, 6)}`,
          pool.poolAddress,
          this.snipeAmountSol,
          pool.initialLiquidityLamports,
        );
      } catch (err) {
        strategyLog.error({ err, token: pool.baseMint.slice(0, 8) }, 'Snipe execution error');
        this.snipingStats.snipesFailed++;
        continue;
      }

      if (result.success) {
        this.snipingStats.snipesSuccessful++;
        strategyLog.info(
          {
            token: pool.baseMint.slice(0, 8),
            signature: result.signature,
            position: result.position?.id.slice(0, 8),
          },
          'Snipe EXECUTED successfully',
        );
      } else {
        this.snipingStats.snipesFailed++;
        strategyLog.warn(
          { token: pool.baseMint.slice(0, 8), error: result.error },
          'Snipe FAILED',
        );
      }
    }

    // Sniping doesn't return Opportunity objects to the standard executor.
    // It handles its own execution via SnipeExecutor + tiered exits.
    // Return empty so botEngine doesn't try to execute these as arb trades.
    return [];
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC GETTERS
  // ═══════════════════════════════════════════════════════════════

  getSnipingStats(): SnipingStats {
    this.snipingStats.openPositions = this.snipeExecutor.getOpenPositionCount();
    return { ...this.snipingStats };
  }

  getOpenSnipePositions(): SnipePosition[] {
    return this.snipeExecutor.getOpenPositions();
  }

  getSnipeExecutor(): SnipeExecutor {
    return this.snipeExecutor;
  }
}
