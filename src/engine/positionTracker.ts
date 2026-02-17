// POSITION TRACKER
// In-memory tracking of all open positions with entry/exit P&L calculation
// Designed for low-latency reads during hot-path risk checks

import { riskLog } from './logger.js';
import { LAMPORTS_PER_SOL } from './config.js';

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface Position {
  tradeId: string;
  strategy: string;
  tokenMint: string;
  tokenSymbol: string;
  amountLamports: bigint;
  entrySolPrice: number;
  entryTimestamp: number;
  status: 'open' | 'closed';
}

export interface ClosedPosition extends Position {
  status: 'closed';
  exitAmountLamports: bigint;
  exitSolPrice: number;
  exitTimestamp: number;
  realizedPnlSol: number;
  holdTimeMs: number;
}

export interface PositionSummary {
  tradeId: string;
  strategy: string;
  tokenSymbol: string;
  tokenMint: string;
  amountSol: number;
  entrySolPrice: number;
  ageMs: number;
  status: 'open' | 'closed';
}

// ═══════════════════════════════════════════════════════════
// POSITION TRACKER CLASS
// ═══════════════════════════════════════════════════════════

export class PositionTracker {
  private readonly openPositions: Map<string, Position> = new Map();
  private readonly closedPositions: ClosedPosition[] = [];

  // Caps to prevent unbounded memory growth on long-running bots
  private static readonly MAX_CLOSED_HISTORY = 10_000;

  constructor() {
    riskLog.info('PositionTracker initialized');
  }

  // ─────────────────────────────────────────────────────────
  // OPEN / CLOSE
  // ─────────────────────────────────────────────────────────

  /**
   * Record a new position entry.
   * amountLamports is the SOL (or equivalent) committed to this position.
   */
  openPosition(
    tradeId: string,
    strategy: string,
    tokenMint: string,
    tokenSymbol: string,
    amountLamports: bigint,
    entrySolPrice: number,
  ): void {
    if (this.openPositions.has(tradeId)) {
      riskLog.warn({ tradeId }, 'Position already exists, skipping duplicate open');
      return;
    }

    const position: Position = {
      tradeId,
      strategy,
      tokenMint,
      tokenSymbol,
      amountLamports,
      entrySolPrice,
      entryTimestamp: Date.now(),
      status: 'open',
    };

    this.openPositions.set(tradeId, position);

    riskLog.info(
      {
        tradeId,
        strategy,
        tokenSymbol,
        amountSol: (Number(amountLamports) / LAMPORTS_PER_SOL).toFixed(6),
        entrySolPrice: entrySolPrice.toFixed(2),
        openPositions: this.openPositions.size,
      },
      `Position opened: ${tokenSymbol}`,
    );
  }

  /**
   * Close a position and calculate realized P&L.
   * Returns the closed position with P&L, or null if position was not found.
   */
  closePosition(
    tradeId: string,
    exitAmountLamports: bigint,
    exitSolPrice: number,
  ): ClosedPosition | null {
    const position = this.openPositions.get(tradeId);
    if (!position) {
      riskLog.warn({ tradeId }, 'Cannot close position: not found in open positions');
      return null;
    }

    const now = Date.now();
    const holdTimeMs = now - position.entryTimestamp;

    // P&L in SOL: difference between exit and entry amounts
    const entryAmountSol = Number(position.amountLamports) / LAMPORTS_PER_SOL;
    const exitAmountSol = Number(exitAmountLamports) / LAMPORTS_PER_SOL;
    const realizedPnlSol = exitAmountSol - entryAmountSol;

    const closed: ClosedPosition = {
      ...position,
      status: 'closed',
      exitAmountLamports,
      exitSolPrice,
      exitTimestamp: now,
      realizedPnlSol,
      holdTimeMs,
    };

    // Move from open to closed
    this.openPositions.delete(tradeId);
    this.closedPositions.push(closed);

    // Prune closed history if it grows too large
    if (this.closedPositions.length > PositionTracker.MAX_CLOSED_HISTORY) {
      const excess = this.closedPositions.length - PositionTracker.MAX_CLOSED_HISTORY;
      this.closedPositions.splice(0, excess);
    }

    riskLog.info(
      {
        tradeId,
        strategy: position.strategy,
        tokenSymbol: position.tokenSymbol,
        entryAmountSol: entryAmountSol.toFixed(6),
        exitAmountSol: exitAmountSol.toFixed(6),
        realizedPnlSol: realizedPnlSol.toFixed(6),
        holdTimeMs,
        openPositions: this.openPositions.size,
      },
      `Position closed: ${position.tokenSymbol} ${realizedPnlSol >= 0 ? '+' : ''}${realizedPnlSol.toFixed(6)} SOL`,
    );

    return closed;
  }

  // ─────────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────────

  /**
   * Get all currently open positions as an array.
   */
  getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get the number of currently open positions.
   * O(1) lookup for hot-path risk checks.
   */
  getPositionCount(): number {
    return this.openPositions.size;
  }

  /**
   * Get how long a specific position has been open (milliseconds).
   * Returns -1 if position is not found.
   */
  getPositionAge(tradeId: string): number {
    const position = this.openPositions.get(tradeId);
    if (!position) {
      return -1;
    }
    return Date.now() - position.entryTimestamp;
  }

  /**
   * Get all positions older than the given threshold.
   * Useful for detecting stuck or stale positions that should be force-closed.
   */
  getOldPositions(maxAgeMs: number): Position[] {
    const now = Date.now();
    const old: Position[] = [];

    const positions = Array.from(this.openPositions.values());
    for (const position of positions) {
      if (now - position.entryTimestamp > maxAgeMs) {
        old.push(position);
      }
    }

    if (old.length > 0) {
      riskLog.debug(
        {
          count: old.length,
          maxAgeMs,
          tradeIds: old.map((p) => p.tradeId),
        },
        'Stale positions detected',
      );
    }

    return old;
  }

  /**
   * Get total SOL currently deployed across all open positions.
   * This is the aggregate exposure the bot currently holds.
   */
  getTotalExposureSol(): number {
    let totalLamports = BigInt(0);
    const positions = Array.from(this.openPositions.values());
    for (const position of positions) {
      totalLamports += position.amountLamports;
    }
    return Number(totalLamports) / LAMPORTS_PER_SOL;
  }

  /**
   * Get a lightweight summary of all open positions (useful for API/logging).
   */
  getOpenPositionSummaries(): PositionSummary[] {
    const now = Date.now();
    const summaries: PositionSummary[] = [];

    const allPositions = Array.from(this.openPositions.values());
    for (const pos of allPositions) {
      summaries.push({
        tradeId: pos.tradeId,
        strategy: pos.strategy,
        tokenSymbol: pos.tokenSymbol,
        tokenMint: pos.tokenMint,
        amountSol: Number(pos.amountLamports) / LAMPORTS_PER_SOL,
        entrySolPrice: pos.entrySolPrice,
        ageMs: now - pos.entryTimestamp,
        status: 'open',
      });
    }

    return summaries;
  }

  /**
   * Check if a position exists for the given trade ID.
   */
  hasPosition(tradeId: string): boolean {
    return this.openPositions.has(tradeId);
  }

  /**
   * Get a specific open position by trade ID, or undefined if not found.
   */
  getPosition(tradeId: string): Position | undefined {
    return this.openPositions.get(tradeId);
  }

  /**
   * Force-remove a position without recording a close (e.g. for cleanup on error).
   * Use sparingly -- prefer closePosition() for normal flow.
   */
  removePosition(tradeId: string): boolean {
    const existed = this.openPositions.delete(tradeId);
    if (existed) {
      riskLog.warn({ tradeId }, 'Position force-removed without close');
    }
    return existed;
  }

  /**
   * Get recent closed positions for review.
   */
  getRecentClosedPositions(limit: number = 50): ClosedPosition[] {
    const start = Math.max(0, this.closedPositions.length - limit);
    return this.closedPositions.slice(start);
  }
}
