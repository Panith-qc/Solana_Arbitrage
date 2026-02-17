// P&L TRACKER
// Real-time profit & loss tracking with database persistence
// Tracks per-trade, per-strategy, and daily aggregate P&L metrics

import { riskLog } from './logger.js';
import { LAMPORTS_PER_SOL } from './config.js';
import type { BotDatabase, DailyPnL } from './database.js';

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface TradeResult {
  tradeId: string;
  strategy: string;
  profitSol: number;
  profitUsd: number;
  feesSol: number;
  feesUsd: number;
  timestamp: number;
}

export interface PnLSnapshot {
  totalProfit: number;
  totalLoss: number;
  netPnl: number;
  totalFees: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  bestTrade: number;
  worstTrade: number;
  currentStreak: number;       // positive = wins, negative = losses
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface StrategyPnL {
  strategy: string;
  totalProfit: number;
  totalLoss: number;
  netPnl: number;
  totalFees: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  bestTrade: number;
  worstTrade: number;
}

export interface DrawdownInfo {
  currentDrawdownSol: number;
  currentDrawdownPercent: number;
  peakBalanceSol: number;
  currentBalanceSol: number;
}

// ═══════════════════════════════════════════════════════════
// PnL TRACKER CLASS
// ═══════════════════════════════════════════════════════════

export class PnLTracker {
  private readonly database: BotDatabase;

  // In-memory session accumulators (since last restart)
  private sessionTrades: TradeResult[] = [];
  private strategyTrades: Map<string, TradeResult[]> = new Map();

  // Streak tracking
  private currentStreak = 0;
  private longestWinStreak = 0;
  private longestLossStreak = 0;

  // Session extremes
  private bestTradeSol = 0;
  private worstTradeSol = 0;

  constructor(database: BotDatabase) {
    this.database = database;
    riskLog.info('PnLTracker initialized');
  }

  // ─────────────────────────────────────────────────────────
  // RECORD TRADE
  // ─────────────────────────────────────────────────────────

  /**
   * Record a completed trade and persist to database.
   * profitSol/profitUsd are the gross profit BEFORE fees.
   * Net = profit - fees.
   */
  recordTrade(
    tradeId: string,
    strategy: string,
    profitSol: number,
    profitUsd: number,
    feesSol: number,
    feesUsd: number,
  ): void {
    const netSol = profitSol - feesSol;
    const won = netSol > 0;
    const timestamp = Date.now();

    const result: TradeResult = {
      tradeId,
      strategy,
      profitSol,
      profitUsd,
      feesSol,
      feesUsd,
      timestamp,
    };

    // Update in-memory session state
    this.sessionTrades.push(result);

    if (!this.strategyTrades.has(strategy)) {
      this.strategyTrades.set(strategy, []);
    }
    this.strategyTrades.get(strategy)!.push(result);

    // Track streaks
    if (won) {
      this.currentStreak = this.currentStreak > 0 ? this.currentStreak + 1 : 1;
      if (this.currentStreak > this.longestWinStreak) {
        this.longestWinStreak = this.currentStreak;
      }
    } else {
      this.currentStreak = this.currentStreak < 0 ? this.currentStreak - 1 : -1;
      if (Math.abs(this.currentStreak) > this.longestLossStreak) {
        this.longestLossStreak = Math.abs(this.currentStreak);
      }
    }

    // Track session extremes
    if (netSol > this.bestTradeSol) {
      this.bestTradeSol = netSol;
    }
    if (netSol < this.worstTradeSol) {
      this.worstTradeSol = netSol;
    }

    // Persist to database
    try {
      this.database.updateDailyPnL(profitSol, profitUsd, feesSol, feesUsd, won);
    } catch (err) {
      riskLog.error({ err, tradeId }, 'Failed to persist daily P&L update');
    }

    riskLog.info(
      {
        tradeId,
        strategy,
        profitSol: profitSol.toFixed(6),
        feesSol: feesSol.toFixed(6),
        netSol: netSol.toFixed(6),
        won,
        streak: this.currentStreak,
      },
      `Trade recorded: ${won ? 'WIN' : 'LOSS'} ${netSol >= 0 ? '+' : ''}${netSol.toFixed(6)} SOL`,
    );
  }

  // ─────────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────────

  /**
   * Get today's P&L from the database.
   */
  getDailyPnL(): DailyPnL {
    try {
      return this.database.getTodayPnL();
    } catch (err) {
      riskLog.error({ err }, 'Failed to fetch daily P&L from database');
      // Return a safe zero-value fallback so callers never get undefined
      return {
        date: new Date().toISOString().split('T')[0],
        total_profit_sol: 0,
        total_profit_usd: 0,
        total_fees_sol: 0,
        total_fees_usd: 0,
        net_profit_sol: 0,
        net_profit_usd: 0,
        trades_total: 0,
        trades_won: 0,
        trades_lost: 0,
        max_drawdown_sol: 0,
        peak_balance_sol: 0,
      };
    }
  }

  /**
   * Get cumulative all-time P&L by summing every daily_pnl row.
   */
  getCumulativePnL(): PnLSnapshot {
    try {
      const history = this.database.getDailyPnLHistory(36500); // ~100 years, effectively "all"

      let totalProfit = 0;
      let totalLoss = 0;
      let totalFees = 0;
      let totalTrades = 0;
      let winningTrades = 0;
      let losingTrades = 0;

      for (const day of history) {
        // Profits are gross profits; losses are reflected in the net when net < 0
        totalProfit += day.total_profit_sol;
        totalFees += day.total_fees_sol;
        totalTrades += day.trades_total;
        winningTrades += day.trades_won;
        losingTrades += day.trades_lost;

        // Accumulate loss days
        if (day.net_profit_sol < 0) {
          totalLoss += Math.abs(day.net_profit_sol);
        }
      }

      const netPnl = totalProfit - totalFees;
      const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

      return {
        totalProfit,
        totalLoss,
        netPnl,
        totalFees,
        winRate,
        totalTrades,
        winningTrades,
        losingTrades,
        bestTrade: this.bestTradeSol,
        worstTrade: this.worstTradeSol,
        currentStreak: this.currentStreak,
        longestWinStreak: this.longestWinStreak,
        longestLossStreak: this.longestLossStreak,
      };
    } catch (err) {
      riskLog.error({ err }, 'Failed to calculate cumulative P&L');
      return {
        totalProfit: 0,
        totalLoss: 0,
        netPnl: 0,
        totalFees: 0,
        winRate: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        bestTrade: 0,
        worstTrade: 0,
        currentStreak: 0,
        longestWinStreak: 0,
        longestLossStreak: 0,
      };
    }
  }

  /**
   * Get P&L for a specific strategy using database-backed strategy stats.
   */
  getStrategyPnL(strategy: string): StrategyPnL {
    try {
      const allStats = this.database.getStrategyStats();
      const stats = allStats.find((s) => s.strategy === strategy);

      if (!stats) {
        return {
          strategy,
          totalProfit: 0,
          totalLoss: 0,
          netPnl: 0,
          totalFees: 0,
          winRate: 0,
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          bestTrade: 0,
          worstTrade: 0,
        };
      }

      // Supplement with session data for fee breakdown
      const sessionTrades = this.strategyTrades.get(strategy) || [];
      const sessionFees = sessionTrades.reduce((sum, t) => sum + t.feesSol, 0);

      const totalLoss =
        stats.total_profit_sol < 0 ? Math.abs(stats.total_profit_sol) : 0;

      return {
        strategy,
        totalProfit: stats.total_profit_sol > 0 ? stats.total_profit_sol : 0,
        totalLoss,
        netPnl: stats.total_profit_sol,
        totalFees: sessionFees,
        winRate: stats.win_rate,
        totalTrades: stats.total_trades,
        winningTrades: stats.winning_trades,
        losingTrades: stats.total_trades - stats.winning_trades,
        bestTrade: stats.best_trade_sol,
        worstTrade: stats.worst_trade_sol,
      };
    } catch (err) {
      riskLog.error({ err, strategy }, 'Failed to get strategy P&L');
      return {
        strategy,
        totalProfit: 0,
        totalLoss: 0,
        netPnl: 0,
        totalFees: 0,
        winRate: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        bestTrade: 0,
        worstTrade: 0,
      };
    }
  }

  /**
   * Get today's net loss (absolute value). Returns 0 if today is profitable.
   * This is the key metric for daily loss limit checking.
   */
  getDailyLoss(): number {
    const daily = this.getDailyPnL();
    return daily.net_profit_sol < 0 ? Math.abs(daily.net_profit_sol) : 0;
  }

  /**
   * Calculate current drawdown and persist to database.
   * Returns drawdown info for risk decisions.
   */
  getDrawdown(currentBalanceSol: number, peakBalanceSol: number): DrawdownInfo {
    // Ensure peak is at least the current balance (first run edge case)
    const effectivePeak = Math.max(peakBalanceSol, currentBalanceSol);
    const drawdownSol = Math.max(0, effectivePeak - currentBalanceSol);
    const drawdownPercent =
      effectivePeak > 0 ? (drawdownSol / effectivePeak) * 100 : 0;

    // Persist to database
    try {
      this.database.updateDrawdown(drawdownSol, effectivePeak);
    } catch (err) {
      riskLog.error({ err }, 'Failed to persist drawdown update');
    }

    if (drawdownPercent > 0) {
      riskLog.debug(
        {
          currentBalanceSol: currentBalanceSol.toFixed(4),
          peakBalanceSol: effectivePeak.toFixed(4),
          drawdownSol: drawdownSol.toFixed(4),
          drawdownPercent: drawdownPercent.toFixed(2),
        },
        'Drawdown calculated',
      );
    }

    return {
      currentDrawdownSol: drawdownSol,
      currentDrawdownPercent: drawdownPercent,
      peakBalanceSol: effectivePeak,
      currentBalanceSol,
    };
  }

  /**
   * Get historical daily P&L records from the database.
   */
  getPnLHistory(days: number = 30): DailyPnL[] {
    try {
      return this.database.getDailyPnLHistory(days);
    } catch (err) {
      riskLog.error({ err, days }, 'Failed to fetch P&L history');
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────
  // SESSION HELPERS
  // ─────────────────────────────────────────────────────────

  /**
   * Get the number of trades recorded this session (since last restart).
   */
  getSessionTradeCount(): number {
    return this.sessionTrades.length;
  }

  /**
   * Get full in-memory session snapshot (combines DB + session data).
   */
  getSessionSnapshot(): PnLSnapshot {
    const trades = this.sessionTrades;
    let totalProfit = 0;
    let totalLoss = 0;
    let totalFees = 0;
    let winningTrades = 0;

    for (const t of trades) {
      const net = t.profitSol - t.feesSol;
      totalFees += t.feesSol;
      if (net > 0) {
        totalProfit += net;
        winningTrades++;
      } else {
        totalLoss += Math.abs(net);
      }
    }

    const totalTrades = trades.length;
    const losingTrades = totalTrades - winningTrades;
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

    return {
      totalProfit,
      totalLoss,
      netPnl: totalProfit - totalLoss,
      totalFees,
      winRate,
      totalTrades,
      winningTrades,
      losingTrades,
      bestTrade: this.bestTradeSol,
      worstTrade: this.worstTradeSol,
      currentStreak: this.currentStreak,
      longestWinStreak: this.longestWinStreak,
      longestLossStreak: this.longestLossStreak,
    };
  }
}
