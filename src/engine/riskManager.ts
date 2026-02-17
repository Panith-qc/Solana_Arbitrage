// RISK MANAGER
// Central risk enforcement layer -- gates EVERY trade.
// Checks daily loss limits, drawdown, position limits, circuit breaker,
// strategy permissions, and balance before allowing execution.

import { riskLog } from './logger.js';
import {
  BotConfig,
  RiskProfile,
  RISK_PROFILES,
  LAMPORTS_PER_SOL,
} from './config.js';
import type { ConnectionManager } from './connectionManager.js';
import type { PnLTracker } from './pnlTracker.js';
import type { PositionTracker } from './positionTracker.js';

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  adjustedAmount?: number;
}

export interface CircuitBreakerState {
  triggered: boolean;
  consecutiveFailures: number;
  cooldownRemaining: number;
  lastFailureAt: number | null;
  lastResetAt: number | null;
}

export interface RiskStatus {
  dailyLossSol: number;
  dailyLossLimitSol: number;
  dailyLossPercent: number;
  openPositions: number;
  maxPositions: number;
  totalExposureSol: number;
  maxPositionSol: number;
  drawdownPercent: number;
  maxDrawdownPercent: number;
  circuitBreaker: CircuitBreakerState;
  emergencyStopped: boolean;
  riskLevel: string;
  balanceSol: number;
}

// ═══════════════════════════════════════════════════════════
// RISK MANAGER CLASS
// ═══════════════════════════════════════════════════════════

export class RiskManager {
  private readonly config: BotConfig;
  private readonly riskProfile: RiskProfile;
  private readonly pnlTracker: PnLTracker;
  private readonly positionTracker: PositionTracker;
  private readonly connectionManager: ConnectionManager;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitBreakerTriggered = false;
  private circuitBreakerTriggeredAt = 0;
  private lastFailureAt: number | null = null;
  private lastResetAt: number | null = null;

  // Emergency stop
  private emergencyStopped = false;

  // Cached balance to avoid hammering RPC on every risk check
  private cachedBalanceSol = 0;
  private lastBalanceFetchAt = 0;
  private static readonly BALANCE_CACHE_TTL_MS = 5_000; // 5 seconds

  // Peak balance tracking for drawdown calculation
  private peakBalanceSol = 0;

  constructor(
    config: BotConfig,
    pnlTracker: PnLTracker,
    positionTracker: PositionTracker,
    connectionManager: ConnectionManager,
  ) {
    this.config = config;
    this.riskProfile = RISK_PROFILES[config.riskLevel];
    this.pnlTracker = pnlTracker;
    this.positionTracker = positionTracker;
    this.connectionManager = connectionManager;

    // Initialize peak balance from config capital
    this.peakBalanceSol = config.capitalSol;

    riskLog.info(
      {
        riskLevel: this.riskProfile.level,
        maxDailyLossSol: this.riskProfile.maxDailyLossSol,
        maxPositionSol: this.riskProfile.maxPositionSol,
        maxConcurrentTrades: this.riskProfile.maxConcurrentTrades,
        maxDrawdownPercent: this.riskProfile.maxDrawdownPercent,
        circuitBreakerThreshold: this.riskProfile.circuitBreakerFailures,
      },
      `RiskManager initialized [${this.riskProfile.level}]`,
    );
  }

  // ─────────────────────────────────────────────────────────
  // MAIN GATE
  // ─────────────────────────────────────────────────────────

  /**
   * THE main trade gate. Every trade attempt must pass through here.
   * Returns { allowed, reason, adjustedAmount }.
   */
  async canTrade(
    strategy: string,
    amountSol: number,
    solPrice: number,
  ): Promise<RiskCheck> {
    // 1. Emergency stop
    if (this.emergencyStopped) {
      return this.deny('Emergency stop is active -- all trading halted');
    }

    // 2. Circuit breaker
    if (this.circuitBreakerTriggered) {
      const cooldownRemaining = this.getCooldownRemaining();
      if (cooldownRemaining > 0) {
        return this.deny(
          `Circuit breaker active: ${this.consecutiveFailures} consecutive failures. ` +
          `Cooldown: ${Math.ceil(cooldownRemaining / 1000)}s remaining`,
        );
      }
      // Cooldown expired -- auto-resume
      this.resetCircuitBreaker();
      riskLog.info('Circuit breaker cooldown expired, auto-resuming trading');
    }

    // 3. Strategy enabled check
    if (!this.isStrategyEnabled(strategy)) {
      return this.deny(
        `Strategy "${strategy}" is not enabled in ${this.riskProfile.level} risk profile`,
      );
    }

    // 4. Daily loss limit
    const dailyLoss = this.pnlTracker.getDailyLoss();
    if (dailyLoss >= this.riskProfile.maxDailyLossSol) {
      return this.deny(
        `Daily loss limit reached: ${dailyLoss.toFixed(4)} SOL >= ${this.riskProfile.maxDailyLossSol} SOL limit`,
      );
    }

    // Also check percentage-based daily loss limit
    const dailyPnl = this.pnlTracker.getDailyPnL();
    const capitalSol = this.config.capitalSol;
    if (capitalSol > 0) {
      const dailyLossPercent = (dailyLoss / capitalSol) * 100;
      if (dailyLossPercent >= this.riskProfile.maxDailyLossPercent) {
        return this.deny(
          `Daily loss percentage limit reached: ${dailyLossPercent.toFixed(1)}% >= ${this.riskProfile.maxDailyLossPercent}% limit`,
        );
      }
    }

    // 5. Drawdown limit
    const balance = await this.getBalanceSol();
    if (balance > this.peakBalanceSol) {
      this.peakBalanceSol = balance;
    }
    const drawdown = this.pnlTracker.getDrawdown(balance, this.peakBalanceSol);
    if (drawdown.currentDrawdownPercent >= this.riskProfile.maxDrawdownPercent) {
      return this.deny(
        `Max drawdown reached: ${drawdown.currentDrawdownPercent.toFixed(1)}% >= ${this.riskProfile.maxDrawdownPercent}% limit ` +
        `(peak: ${drawdown.peakBalanceSol.toFixed(4)} SOL, current: ${balance.toFixed(4)} SOL)`,
      );
    }

    // 6. Max concurrent positions
    const openPositions = this.positionTracker.getPositionCount();
    if (openPositions >= this.riskProfile.maxConcurrentTrades) {
      return this.deny(
        `Max concurrent positions reached: ${openPositions} >= ${this.riskProfile.maxConcurrentTrades}`,
      );
    }

    // 7. Max trade amount
    let effectiveAmount = amountSol;
    if (effectiveAmount > this.riskProfile.maxTradeAmountSol) {
      effectiveAmount = this.riskProfile.maxTradeAmountSol;
      riskLog.warn(
        {
          requested: amountSol.toFixed(6),
          adjusted: effectiveAmount.toFixed(6),
          maxTradeAmountSol: this.riskProfile.maxTradeAmountSol,
        },
        'Trade amount capped to max trade size',
      );
    }

    // 8. Max position size (total exposure + this trade)
    const currentExposure = this.positionTracker.getTotalExposureSol();
    if (currentExposure + effectiveAmount > this.riskProfile.maxPositionSol) {
      const available = Math.max(0, this.riskProfile.maxPositionSol - currentExposure);
      if (available <= 0) {
        return this.deny(
          `Max position size reached: exposure ${currentExposure.toFixed(4)} SOL >= ${this.riskProfile.maxPositionSol} SOL limit`,
        );
      }
      effectiveAmount = available;
      riskLog.warn(
        {
          requested: amountSol.toFixed(6),
          adjusted: effectiveAmount.toFixed(6),
          currentExposure: currentExposure.toFixed(6),
          maxPositionSol: this.riskProfile.maxPositionSol,
        },
        'Trade amount reduced to fit within max position size',
      );
    }

    // 9. Sufficient balance
    // Leave a small buffer for transaction fees (0.01 SOL)
    const FEE_BUFFER_SOL = 0.01;
    if (balance < effectiveAmount + FEE_BUFFER_SOL) {
      return this.deny(
        `Insufficient balance: ${balance.toFixed(4)} SOL < ${effectiveAmount.toFixed(4)} SOL + ${FEE_BUFFER_SOL} SOL fee buffer`,
      );
    }

    // All checks passed
    riskLog.debug(
      {
        strategy,
        requestedSol: amountSol.toFixed(6),
        effectiveSol: effectiveAmount.toFixed(6),
        dailyLoss: dailyLoss.toFixed(4),
        openPositions,
        drawdownPercent: drawdown.currentDrawdownPercent.toFixed(2),
        balance: balance.toFixed(4),
      },
      'Trade approved by risk manager',
    );

    return {
      allowed: true,
      adjustedAmount: effectiveAmount !== amountSol ? effectiveAmount : undefined,
    };
  }

  // ─────────────────────────────────────────────────────────
  // TRADE SIZE ADJUSTMENT
  // ─────────────────────────────────────────────────────────

  /**
   * Calculate an adjusted trade size based on current risk conditions.
   * Reduces size when approaching limits. Returns 0 if trading should be blocked.
   */
  getAdjustedTradeSize(requestedSol: number, strategy: string): number {
    if (this.emergencyStopped || this.circuitBreakerTriggered) {
      return 0;
    }

    let adjusted = requestedSol;

    // Cap at max trade amount
    adjusted = Math.min(adjusted, this.riskProfile.maxTradeAmountSol);

    // Cap at remaining position capacity
    const currentExposure = this.positionTracker.getTotalExposureSol();
    const remainingCapacity = Math.max(0, this.riskProfile.maxPositionSol - currentExposure);
    adjusted = Math.min(adjusted, remainingCapacity);

    // Scale down proportionally as we approach daily loss limit
    const dailyLoss = this.pnlTracker.getDailyLoss();
    const dailyLossRatio = dailyLoss / this.riskProfile.maxDailyLossSol;
    if (dailyLossRatio > 0.5) {
      // Start reducing size once we've used 50% of daily loss budget
      // Linear scale: at 50% loss budget => 100% size, at 100% loss budget => 0% size
      const scaleFactor = Math.max(0, 1 - (dailyLossRatio - 0.5) * 2);
      adjusted *= scaleFactor;

      riskLog.debug(
        {
          requestedSol: requestedSol.toFixed(6),
          adjustedSol: adjusted.toFixed(6),
          dailyLossRatio: dailyLossRatio.toFixed(3),
          scaleFactor: scaleFactor.toFixed(3),
        },
        'Trade size scaled down due to approaching daily loss limit',
      );
    }

    // Scale down based on consecutive failures (even below circuit breaker threshold)
    if (this.consecutiveFailures > 0) {
      const failureRatio = this.consecutiveFailures / this.riskProfile.circuitBreakerFailures;
      const failureScale = Math.max(0.25, 1 - failureRatio * 0.5);
      adjusted *= failureScale;
    }

    return Math.max(0, adjusted);
  }

  // ─────────────────────────────────────────────────────────
  // STRATEGY CHECKS
  // ─────────────────────────────────────────────────────────

  /**
   * Check if a strategy is enabled in the current risk profile.
   */
  isStrategyEnabled(strategy: string): boolean {
    const strategies = this.riskProfile.strategies as Record<string, boolean>;
    // If the strategy key exists in the profile, use its value.
    // Unknown strategies are denied by default.
    if (strategy in strategies) {
      return strategies[strategy];
    }
    riskLog.warn(
      { strategy, riskLevel: this.riskProfile.level },
      'Unknown strategy checked against risk profile -- denied by default',
    );
    return false;
  }

  // ─────────────────────────────────────────────────────────
  // CIRCUIT BREAKER
  // ─────────────────────────────────────────────────────────

  /**
   * Report the result of a trade attempt. Updates circuit breaker state.
   * Call this AFTER every trade execution, whether it succeeded or failed.
   */
  reportTradeResult(success: boolean, profitSol: number): void {
    if (success && profitSol >= 0) {
      // Successful profitable trade -- reset failure counter
      if (this.consecutiveFailures > 0) {
        riskLog.info(
          { previousFailures: this.consecutiveFailures },
          'Consecutive failure counter reset after successful trade',
        );
      }
      this.consecutiveFailures = 0;
    } else {
      // Failed or unprofitable trade
      this.consecutiveFailures++;
      this.lastFailureAt = Date.now();

      riskLog.warn(
        {
          consecutiveFailures: this.consecutiveFailures,
          threshold: this.riskProfile.circuitBreakerFailures,
          profitSol: profitSol.toFixed(6),
        },
        `Trade failure #${this.consecutiveFailures}`,
      );

      // Check if circuit breaker should trip
      if (this.consecutiveFailures >= this.riskProfile.circuitBreakerFailures) {
        this.tripCircuitBreaker();
      }
    }
  }

  /**
   * Get current circuit breaker status.
   */
  getCircuitBreakerStatus(): CircuitBreakerState {
    return {
      triggered: this.circuitBreakerTriggered,
      consecutiveFailures: this.consecutiveFailures,
      cooldownRemaining: this.getCooldownRemaining(),
      lastFailureAt: this.lastFailureAt,
      lastResetAt: this.lastResetAt,
    };
  }

  private tripCircuitBreaker(): void {
    this.circuitBreakerTriggered = true;
    this.circuitBreakerTriggeredAt = Date.now();

    const cooldownSec = this.riskProfile.circuitBreakerCooldownMs / 1000;

    riskLog.error(
      {
        consecutiveFailures: this.consecutiveFailures,
        cooldownMs: this.riskProfile.circuitBreakerCooldownMs,
        cooldownSec,
      },
      `CIRCUIT BREAKER TRIPPED after ${this.consecutiveFailures} consecutive failures. ` +
      `Trading paused for ${cooldownSec}s`,
    );
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerTriggered = false;
    this.consecutiveFailures = 0;
    this.circuitBreakerTriggeredAt = 0;
    this.lastResetAt = Date.now();

    riskLog.info('Circuit breaker reset -- trading resumed');
  }

  private getCooldownRemaining(): number {
    if (!this.circuitBreakerTriggered) {
      return 0;
    }
    const elapsed = Date.now() - this.circuitBreakerTriggeredAt;
    return Math.max(0, this.riskProfile.circuitBreakerCooldownMs - elapsed);
  }

  // ─────────────────────────────────────────────────────────
  // EMERGENCY STOP
  // ─────────────────────────────────────────────────────────

  /**
   * Activate emergency stop. Blocks ALL trading until manually cleared.
   */
  activateEmergencyStop(reason: string): void {
    this.emergencyStopped = true;
    riskLog.error(
      { reason },
      'EMERGENCY STOP ACTIVATED -- all trading halted until manual reset',
    );
  }

  /**
   * Clear the emergency stop. Trading will resume (subject to other checks).
   */
  clearEmergencyStop(): void {
    this.emergencyStopped = false;
    riskLog.info('Emergency stop cleared -- trading may resume');
  }

  /**
   * Check if emergency stop is currently active.
   */
  isEmergencyStopped(): boolean {
    return this.emergencyStopped;
  }

  // ─────────────────────────────────────────────────────────
  // STATUS
  // ─────────────────────────────────────────────────────────

  /**
   * Get full risk status snapshot (useful for dashboards and API).
   */
  async getStatus(): Promise<RiskStatus> {
    const dailyLoss = this.pnlTracker.getDailyLoss();
    const balance = await this.getBalanceSol();
    const drawdown = this.pnlTracker.getDrawdown(balance, this.peakBalanceSol);
    const capitalSol = this.config.capitalSol;
    const dailyLossPercent = capitalSol > 0 ? (dailyLoss / capitalSol) * 100 : 0;

    return {
      dailyLossSol: dailyLoss,
      dailyLossLimitSol: this.riskProfile.maxDailyLossSol,
      dailyLossPercent,
      openPositions: this.positionTracker.getPositionCount(),
      maxPositions: this.riskProfile.maxConcurrentTrades,
      totalExposureSol: this.positionTracker.getTotalExposureSol(),
      maxPositionSol: this.riskProfile.maxPositionSol,
      drawdownPercent: drawdown.currentDrawdownPercent,
      maxDrawdownPercent: this.riskProfile.maxDrawdownPercent,
      circuitBreaker: this.getCircuitBreakerStatus(),
      emergencyStopped: this.emergencyStopped,
      riskLevel: this.riskProfile.level,
      balanceSol: balance,
    };
  }

  // ─────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────

  /**
   * Get wallet SOL balance with a short TTL cache to avoid hammering RPC.
   */
  private async getBalanceSol(): Promise<number> {
    const now = Date.now();
    if (now - this.lastBalanceFetchAt < RiskManager.BALANCE_CACHE_TTL_MS) {
      return this.cachedBalanceSol;
    }

    try {
      const balance = await this.connectionManager.getBalance();
      this.cachedBalanceSol = balance;
      this.lastBalanceFetchAt = now;

      // Update peak
      if (balance > this.peakBalanceSol) {
        this.peakBalanceSol = balance;
      }

      return balance;
    } catch (err) {
      riskLog.error({ err }, 'Failed to fetch wallet balance for risk check');
      // Return cached value if available, otherwise assume 0
      return this.cachedBalanceSol;
    }
  }

  /**
   * Helper to construct a denial RiskCheck with logging.
   */
  private deny(reason: string): RiskCheck {
    riskLog.warn({ reason }, 'Trade denied by risk manager');
    return { allowed: false, reason };
  }

  /**
   * Update peak balance externally (e.g. after deposits).
   */
  setPeakBalance(peakSol: number): void {
    this.peakBalanceSol = peakSol;
    riskLog.info({ peakSol: peakSol.toFixed(4) }, 'Peak balance updated');
  }

  /**
   * Get the active risk profile.
   */
  getRiskProfile(): RiskProfile {
    return this.riskProfile;
  }
}
