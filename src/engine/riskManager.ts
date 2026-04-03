// RISK MANAGER — Phase 6
// Fast (<1ms) in-memory gatekeeper. Runs in the hot path before EVERY trade.
// Both hot path (directSwapBuilder) and warm path (circularScanner) call
// canTrade() synchronously before executing.
//
// HARD-CODED LIMITS (10 SOL wallet):
//   MAX_SINGLE_TRADE_SOL      = 0.5     — never risk >5% of wallet on one trade
//   MAX_OPEN_POSITIONS         = 3       — limit concurrent exposure
//   MAX_DAILY_LOSS_SOL         = 1.0     — stop trading after 10% daily drawdown
//   MIN_NET_PROFIT_LAMPORTS    = 50000   — minimum profit to justify TX fees + risk
//   CIRCUIT_BREAKER_FAILURES   = 50      — 50 failures in 10 min → pause trading
//   MAX_DAILY_FAILED_ATTEMPTS  = 200     — hard cap on daily failed TXs (fee burn limit)
//
// POSITION TRACKING:
//   openPositions increments on SEND (not on confirm).
//   openPositions decrements on BOTH success AND failure confirmation.
//   This ensures we never exceed MAX_OPEN_POSITIONS even with in-flight TXs.
//
// CODING STANDARDS:
//   - canTrade() is SYNC — zero async, zero RPC calls, <1ms
//   - All on-chain amounts are BigInt (standard 1)
//   - Circuit breaker uses sliding window (not consecutive count)

import { riskLog } from './logger.js';

// ═══════════════════════════════════════════════════════════════
// HARD-CODED LIMITS
// ═══════════════════════════════════════════════════════════════

const MAX_SINGLE_TRADE_SOL = 0.5;
const MAX_OPEN_POSITIONS = 3;
const MAX_DAILY_LOSS_SOL = 1.0;
const MIN_NET_PROFIT_LAMPORTS = 50_000n;
const CIRCUIT_BREAKER_FAILURES = 50;
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 min pause after trip
const MAX_DAILY_FAILED_ATTEMPTS = 200;
const LAMPORTS_PER_SOL = 1_000_000_000;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

export interface CircuitBreakerState {
  triggered: boolean;
  failuresInWindow: number;
  cooldownRemaining: number;
  lastFailureAt: number | null;
  lastResetAt: number | null;
}

export interface RiskStatus {
  openPositions: number;
  maxPositions: number;
  dailyLossSol: number;
  dailyLossLimitSol: number;
  dailyFailedAttempts: number;
  maxDailyFailedAttempts: number;
  circuitBreaker: CircuitBreakerState;
  emergencyStopped: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Risk Manager
// ═══════════════════════════════════════════════════════════════

export class RiskManager {
  // ── Position tracking ───────────────────────────────────────
  // Incremented on send, decremented on confirmation (success OR failure).
  private openPositions = 0;

  // ── Daily loss tracking ─────────────────────────────────────
  // Accumulated realized loss (positive number = loss) for today.
  private dailyLossSol = 0;
  private dailyResetDate = this.todayKey();

  // ── Daily failed attempts ───────────────────────────────────
  private dailyFailedAttempts = 0;

  // ── Circuit breaker ─────────────────────────────────────────
  // Sliding window: track failure timestamps in last 10 minutes.
  private failureTimestamps: number[] = [];
  private circuitBreakerTriggered = false;
  private circuitBreakerTriggeredAt = 0;
  private lastFailureAt: number | null = null;
  private lastResetAt: number | null = null;

  // ── Emergency stop ──────────────────────────────────────────
  private emergencyStopped = false;

  constructor() {
    riskLog.info(
      {
        maxSingleTradeSol: MAX_SINGLE_TRADE_SOL,
        maxOpenPositions: MAX_OPEN_POSITIONS,
        maxDailyLossSol: MAX_DAILY_LOSS_SOL,
        minNetProfitLamports: MIN_NET_PROFIT_LAMPORTS.toString(),
        circuitBreakerFailures: CIRCUIT_BREAKER_FAILURES,
        circuitBreakerWindowMin: CIRCUIT_BREAKER_WINDOW_MS / 60_000,
        maxDailyFailedAttempts: MAX_DAILY_FAILED_ATTEMPTS,
      },
      'RiskManager initialized with hard-coded limits',
    );
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN GATE — SYNC, <1ms, no RPC calls
  // ─────────────────────────────────────────────────────────────

  /**
   * Synchronous trade gate. Called by BOTH hot path and warm path
   * before every execution. Returns immediately.
   *
   * Example trace:
   *   canTrade(0.1, 50000n) → checks 6 gates in order:
   *     1. emergencyStopped? no
   *     2. circuitBreaker? no (12 failures in window, < 50)
   *     3. dailyLoss 0.3 < 1.0? yes
   *     4. dailyFailedAttempts 45 < 200? yes
   *     5. openPositions 1 < 3? yes
   *     6. tradeSol 0.1 <= 0.5? yes
   *     → { allowed: true }
   */
  canTrade(tradeSol: number, expectedNetProfitLamports: bigint): RiskCheck {
    // Reset daily counters if new day
    this.maybeResetDaily();

    // 1. Emergency stop
    if (this.emergencyStopped) {
      return this.deny('Emergency stop active — all trading halted');
    }

    // 2. Circuit breaker
    if (this.circuitBreakerTriggered) {
      const cooldown = this.getCooldownRemaining();
      if (cooldown > 0) {
        return this.deny(
          `Circuit breaker active: ${this.countRecentFailures()} failures in 10min. ` +
          `Cooldown: ${Math.ceil(cooldown / 1000)}s remaining`,
        );
      }
      // Cooldown expired — auto-reset
      this.resetCircuitBreaker();
    }

    // 3. Daily loss limit
    if (this.dailyLossSol >= MAX_DAILY_LOSS_SOL) {
      return this.deny(
        `Daily loss limit reached: ${this.dailyLossSol.toFixed(4)} SOL >= ${MAX_DAILY_LOSS_SOL} SOL`,
      );
    }

    // 4. Daily failed attempts
    if (this.dailyFailedAttempts >= MAX_DAILY_FAILED_ATTEMPTS) {
      return this.deny(
        `Daily failed attempt limit: ${this.dailyFailedAttempts} >= ${MAX_DAILY_FAILED_ATTEMPTS}`,
      );
    }

    // 5. Open positions
    if (this.openPositions >= MAX_OPEN_POSITIONS) {
      return this.deny(
        `Max open positions: ${this.openPositions} >= ${MAX_OPEN_POSITIONS}`,
      );
    }

    // 6. Trade size
    if (tradeSol > MAX_SINGLE_TRADE_SOL) {
      return this.deny(
        `Trade size ${tradeSol.toFixed(4)} SOL > max ${MAX_SINGLE_TRADE_SOL} SOL`,
      );
    }

    // 7. Minimum profit threshold
    if (expectedNetProfitLamports < MIN_NET_PROFIT_LAMPORTS) {
      return this.deny(
        `Expected profit ${expectedNetProfitLamports} < min ${MIN_NET_PROFIT_LAMPORTS} lamports`,
      );
    }

    return { allowed: true };
  }

  // ─────────────────────────────────────────────────────────────
  // POSITION LIFECYCLE
  // Increment on SEND, decrement on confirmation (success OR failure).
  // ─────────────────────────────────────────────────────────────

  /**
   * Call immediately after sending a transaction (before confirmation).
   * Increments open positions so subsequent canTrade() checks see the in-flight TX.
   */
  recordSend(): void {
    this.openPositions++;
    riskLog.debug({ openPositions: this.openPositions }, 'Position opened (TX sent)');
  }

  /**
   * Call when a transaction is confirmed (success or failure/revert/drop).
   * Always decrements open positions. Records loss if applicable.
   *
   * @param success  true if TX confirmed profitably, false if reverted/dropped/unprofitable
   * @param profitSol  realized P&L in SOL (negative = loss). Only meaningful if success=true.
   */
  recordConfirmation(success: boolean, profitSol: number): void {
    // Always decrement — position is no longer in-flight
    this.openPositions = Math.max(0, this.openPositions - 1);

    if (success && profitSol >= 0) {
      // Profitable confirmation — no action needed for risk tracking
      riskLog.debug(
        { profitSol: profitSol.toFixed(6), openPositions: this.openPositions },
        'Position closed (confirmed profitable)',
      );
      return;
    }

    // Failed or unprofitable
    this.dailyFailedAttempts++;
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.lastFailureAt = now;

    // Accumulate realized loss (fees burned on reverted TXs, or negative P&L)
    if (profitSol < 0) {
      this.dailyLossSol += Math.abs(profitSol);
    } else {
      // Reverted TX costs ~0.000005 SOL in base fee
      this.dailyLossSol += 0.000005;
    }

    riskLog.debug(
      {
        dailyFailedAttempts: this.dailyFailedAttempts,
        dailyLossSol: this.dailyLossSol.toFixed(6),
        failuresInWindow: this.countRecentFailures(),
        openPositions: this.openPositions,
      },
      'Position closed (failed/reverted)',
    );

    // Check circuit breaker
    if (this.countRecentFailures() >= CIRCUIT_BREAKER_FAILURES) {
      this.tripCircuitBreaker();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // CIRCUIT BREAKER — sliding window (50 failures in 10 min)
  // ─────────────────────────────────────────────────────────────

  private countRecentFailures(): number {
    const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
    // Prune old entries while counting (keeps array bounded)
    this.failureTimestamps = this.failureTimestamps.filter(t => t > cutoff);
    return this.failureTimestamps.length;
  }

  private tripCircuitBreaker(): void {
    if (this.circuitBreakerTriggered) return; // already tripped
    this.circuitBreakerTriggered = true;
    this.circuitBreakerTriggeredAt = Date.now();

    riskLog.error(
      {
        failuresInWindow: this.countRecentFailures(),
        windowMin: CIRCUIT_BREAKER_WINDOW_MS / 60_000,
        cooldownMin: CIRCUIT_BREAKER_COOLDOWN_MS / 60_000,
      },
      `CIRCUIT BREAKER TRIPPED: ${this.countRecentFailures()} failures in 10min. Pausing for 5min.`,
    );
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerTriggered = false;
    this.circuitBreakerTriggeredAt = 0;
    this.lastResetAt = Date.now();
    riskLog.info('Circuit breaker reset — trading resumed');
  }

  private getCooldownRemaining(): number {
    if (!this.circuitBreakerTriggered) return 0;
    const elapsed = Date.now() - this.circuitBreakerTriggeredAt;
    return Math.max(0, CIRCUIT_BREAKER_COOLDOWN_MS - elapsed);
  }

  getCircuitBreakerStatus(): CircuitBreakerState {
    return {
      triggered: this.circuitBreakerTriggered,
      failuresInWindow: this.countRecentFailures(),
      cooldownRemaining: this.getCooldownRemaining(),
      lastFailureAt: this.lastFailureAt,
      lastResetAt: this.lastResetAt,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // EMERGENCY STOP
  // ─────────────────────────────────────────────────────────────

  activateEmergencyStop(reason: string): void {
    this.emergencyStopped = true;
    riskLog.error({ reason }, 'EMERGENCY STOP ACTIVATED — all trading halted');
  }

  clearEmergencyStop(): void {
    this.emergencyStopped = false;
    riskLog.info('Emergency stop cleared — trading may resume');
  }

  isEmergencyStopped(): boolean {
    return this.emergencyStopped;
  }

  // ─────────────────────────────────────────────────────────────
  // DAILY RESET
  // ─────────────────────────────────────────────────────────────

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10); // "2026-04-03"
  }

  private maybeResetDaily(): void {
    const today = this.todayKey();
    if (today !== this.dailyResetDate) {
      riskLog.info(
        {
          previousDay: this.dailyResetDate,
          dailyLossSol: this.dailyLossSol.toFixed(6),
          dailyFailedAttempts: this.dailyFailedAttempts,
        },
        'Daily risk counters reset',
      );
      this.dailyLossSol = 0;
      this.dailyFailedAttempts = 0;
      this.dailyResetDate = today;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // STATUS (for API / dashboard)
  // ─────────────────────────────────────────────────────────────

  getStatus(): RiskStatus {
    return {
      openPositions: this.openPositions,
      maxPositions: MAX_OPEN_POSITIONS,
      dailyLossSol: this.dailyLossSol,
      dailyLossLimitSol: MAX_DAILY_LOSS_SOL,
      dailyFailedAttempts: this.dailyFailedAttempts,
      maxDailyFailedAttempts: MAX_DAILY_FAILED_ATTEMPTS,
      circuitBreaker: this.getCircuitBreakerStatus(),
      emergencyStopped: this.emergencyStopped,
    };
  }

  /** Get stats for logging */
  getStats() {
    return {
      openPositions: this.openPositions,
      dailyLossSol: this.dailyLossSol,
      dailyFailedAttempts: this.dailyFailedAttempts,
      circuitBreakerTriggered: this.circuitBreakerTriggered,
      failuresInWindow: this.countRecentFailures(),
      emergencyStopped: this.emergencyStopped,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  private deny(reason: string): RiskCheck {
    riskLog.debug({ reason }, 'Trade denied');
    return { allowed: false, reason };
  }
}

// ── Exported constants for use by other modules ────────────────
export {
  MAX_SINGLE_TRADE_SOL,
  MAX_OPEN_POSITIONS,
  MAX_DAILY_LOSS_SOL,
  MIN_NET_PROFIT_LAMPORTS,
  CIRCUIT_BREAKER_FAILURES,
  MAX_DAILY_FAILED_ATTEMPTS,
};
