// TRADE JOURNAL
// Detailed trade recording, analysis, and performance reporting

import { BotDatabase, TradeRecord } from './database.js';
import { monitorLog } from './logger.js';

export interface TradeEntry {
  tradeId: string;
  strategy: string;
  status: 'executing' | 'completed' | 'failed';
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string | null;
  profitSol: number | null;
  profitUsd: number | null;
  gasCost: number | null;
  jitoTip: number | null;
  solPrice: number;
  signatures: string[];
  route: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PerformanceSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalProfitSol: number;
  totalProfitUsd: number;
  avgProfitPerTradeSol: number;
  avgProfitPerTradeUsd: number;
  bestTradeSol: number;
  worstTradeSol: number;
  totalVolumeSol: number;
  totalFeesSol: number;
  byStrategy: StrategyBreakdown[];
}

export interface StrategyBreakdown {
  strategy: string;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  totalProfitSol: number;
  totalProfitUsd: number;
  avgProfitSol: number;
  bestTradeSol: number;
  worstTradeSol: number;
}

export interface HourlyPerformance {
  hour: number;
  tradeCount: number;
  profitSol: number;
  profitUsd: number;
  winRate: number;
}

export class TradeJournal {
  private database: BotDatabase;

  constructor(database: BotDatabase) {
    this.database = database;
    monitorLog.info('TradeJournal initialized');
  }

  // ═══════════════════════════════════════════════
  // TRADE LIFECYCLE
  // ═══════════════════════════════════════════════

  startTrade(
    tradeId: string,
    strategy: string,
    inputMint: string,
    outputMint: string,
    inputAmount: string,
    solPrice: number
  ): void {
    try {
      this.database.insertTrade({
        trade_id: tradeId,
        strategy,
        status: 'executing',
        input_mint: inputMint,
        output_mint: outputMint,
        input_amount_lamports: inputAmount,
        output_amount_lamports: null,
        profit_sol: null,
        profit_usd: null,
        gas_cost_sol: null,
        jito_tip_sol: null,
        total_fees_sol: null,
        signatures: '[]',
        error: null,
        sol_price_usd: solPrice,
        created_at: new Date().toISOString(),
        completed_at: null,
        route_description: null,
        bundle_id: null,
      });

      monitorLog.info(
        { tradeId, strategy, inputMint: inputMint.slice(0, 8), outputMint: outputMint.slice(0, 8) },
        'Trade started'
      );
    } catch (error) {
      monitorLog.error({ error, tradeId }, 'Failed to record trade start');
    }
  }

  completeTrade(
    tradeId: string,
    outputAmount: string,
    profitSol: number,
    profitUsd: number,
    gasCost: number,
    jitoTip: number,
    signatures: string[],
    route?: string
  ): void {
    try {
      const totalFees = gasCost + jitoTip;

      this.database.updateTrade(tradeId, {
        status: 'completed',
        output_amount_lamports: outputAmount,
        profit_sol: profitSol,
        profit_usd: profitUsd,
        gas_cost_sol: gasCost,
        jito_tip_sol: jitoTip,
        total_fees_sol: totalFees,
        signatures: JSON.stringify(signatures),
        completed_at: new Date().toISOString(),
        route_description: route || null,
      });

      monitorLog.info(
        {
          tradeId,
          profitSol: profitSol.toFixed(6),
          profitUsd: profitUsd.toFixed(2),
          gasCost: gasCost.toFixed(6),
          jitoTip: jitoTip.toFixed(6),
        },
        'Trade completed'
      );
    } catch (error) {
      monitorLog.error({ error, tradeId }, 'Failed to record trade completion');
    }
  }

  failTrade(tradeId: string, error: string, signatures?: string[]): void {
    try {
      this.database.updateTrade(tradeId, {
        status: 'failed',
        error,
        signatures: JSON.stringify(signatures || []),
        completed_at: new Date().toISOString(),
      });

      monitorLog.warn({ tradeId, error }, 'Trade failed');
    } catch (err) {
      monitorLog.error({ error: err, tradeId }, 'Failed to record trade failure');
    }
  }

  // ═══════════════════════════════════════════════
  // TRADE QUERIES
  // ═══════════════════════════════════════════════

  getTradeById(tradeId: string): TradeEntry | null {
    try {
      const trades = this.database.getRecentTrades(1000);
      const record = trades.find(t => t.trade_id === tradeId);
      if (!record) return null;
      return this.mapRecordToEntry(record);
    } catch (error) {
      monitorLog.error({ error, tradeId }, 'Failed to get trade by ID');
      return null;
    }
  }

  getRecentTrades(limit: number = 50): TradeEntry[] {
    try {
      const records = this.database.getRecentTrades(limit);
      return records.map(r => this.mapRecordToEntry(r));
    } catch (error) {
      monitorLog.error({ error, limit }, 'Failed to get recent trades');
      return [];
    }
  }

  getTradesByStrategy(strategy: string, limit: number = 50): TradeEntry[] {
    try {
      const records = this.database.getTradesByStrategy(strategy, limit);
      return records.map(r => this.mapRecordToEntry(r));
    } catch (error) {
      monitorLog.error({ error, strategy, limit }, 'Failed to get trades by strategy');
      return [];
    }
  }

  // ═══════════════════════════════════════════════
  // PERFORMANCE ANALYSIS
  // ═══════════════════════════════════════════════

  getPerformanceSummary(): PerformanceSummary {
    try {
      const strategyStats = this.database.getStrategyStats();
      const allTrades = this.database.getRecentTrades(10000);
      const completedTrades = allTrades.filter(t => t.status === 'completed');

      const totalTrades = completedTrades.length;
      const winningTrades = completedTrades.filter(t => (t.profit_sol || 0) > 0).length;
      const losingTrades = totalTrades - winningTrades;
      const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

      const totalProfitSol = completedTrades.reduce((sum, t) => sum + (t.profit_sol || 0), 0);
      const totalProfitUsd = completedTrades.reduce((sum, t) => sum + (t.profit_usd || 0), 0);
      const totalFeesSol = completedTrades.reduce((sum, t) => sum + (t.total_fees_sol || 0), 0);

      const profits = completedTrades.map(t => t.profit_sol || 0);
      const bestTradeSol = profits.length > 0 ? Math.max(...profits) : 0;
      const worstTradeSol = profits.length > 0 ? Math.min(...profits) : 0;

      // Calculate total volume from input amounts (in lamports, convert to SOL)
      const totalVolumeSol = completedTrades.reduce((sum, t) => {
        const lamports = BigInt(t.input_amount_lamports || '0');
        return sum + Number(lamports) / 1e9;
      }, 0);

      const byStrategy: StrategyBreakdown[] = strategyStats.map(s => ({
        strategy: s.strategy,
        totalTrades: s.total_trades,
        winningTrades: s.winning_trades,
        winRate: s.win_rate,
        totalProfitSol: s.total_profit_sol,
        totalProfitUsd: s.total_profit_usd,
        avgProfitSol: s.avg_profit_per_trade_sol,
        bestTradeSol: s.best_trade_sol,
        worstTradeSol: s.worst_trade_sol,
      }));

      return {
        totalTrades,
        winningTrades,
        losingTrades,
        winRate,
        totalProfitSol,
        totalProfitUsd,
        avgProfitPerTradeSol: totalTrades > 0 ? totalProfitSol / totalTrades : 0,
        avgProfitPerTradeUsd: totalTrades > 0 ? totalProfitUsd / totalTrades : 0,
        bestTradeSol,
        worstTradeSol,
        totalVolumeSol,
        totalFeesSol,
        byStrategy,
      };
    } catch (error) {
      monitorLog.error({ error }, 'Failed to generate performance summary');
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalProfitSol: 0,
        totalProfitUsd: 0,
        avgProfitPerTradeSol: 0,
        avgProfitPerTradeUsd: 0,
        bestTradeSol: 0,
        worstTradeSol: 0,
        totalVolumeSol: 0,
        totalFeesSol: 0,
        byStrategy: [],
      };
    }
  }

  getHourlyPerformance(): HourlyPerformance[] {
    try {
      const allTrades = this.database.getRecentTrades(10000);
      const completedTrades = allTrades.filter(t => t.status === 'completed');

      // Group by hour (0-23)
      const hourlyMap = new Map<number, { trades: TradeRecord[] }>();
      for (let h = 0; h < 24; h++) {
        hourlyMap.set(h, { trades: [] });
      }

      for (const trade of completedTrades) {
        const hour = new Date(trade.created_at).getUTCHours();
        const bucket = hourlyMap.get(hour);
        if (bucket) {
          bucket.trades.push(trade);
        }
      }

      const results: HourlyPerformance[] = [];
      for (let hour = 0; hour < 24; hour++) {
        const bucket = hourlyMap.get(hour);
        if (!bucket) continue;
        const tradeCount = bucket.trades.length;
        const profitSol = bucket.trades.reduce((sum, t) => sum + (t.profit_sol || 0), 0);
        const profitUsd = bucket.trades.reduce((sum, t) => sum + (t.profit_usd || 0), 0);
        const wins = bucket.trades.filter(t => (t.profit_sol || 0) > 0).length;
        const winRate = tradeCount > 0 ? wins / tradeCount : 0;

        results.push({ hour, tradeCount, profitSol, profitUsd, winRate });
      }

      return results.sort((a, b) => a.hour - b.hour);
    } catch (error) {
      monitorLog.error({ error }, 'Failed to generate hourly performance');
      return [];
    }
  }

  // ═══════════════════════════════════════════════
  // CSV EXPORT
  // ═══════════════════════════════════════════════

  exportCSV(fromDate: string, toDate: string): string {
    try {
      const allTrades = this.database.getRecentTrades(100000);
      const filtered = allTrades.filter(t => {
        const created = t.created_at;
        return created >= fromDate && created <= toDate;
      });

      const headers = [
        'trade_id',
        'strategy',
        'status',
        'input_mint',
        'output_mint',
        'input_amount_lamports',
        'output_amount_lamports',
        'profit_sol',
        'profit_usd',
        'gas_cost_sol',
        'jito_tip_sol',
        'total_fees_sol',
        'sol_price_usd',
        'signatures',
        'error',
        'route_description',
        'created_at',
        'completed_at',
      ];

      const rows = filtered.map(t =>
        [
          this.csvEscape(t.trade_id),
          this.csvEscape(t.strategy),
          this.csvEscape(t.status),
          this.csvEscape(t.input_mint),
          this.csvEscape(t.output_mint),
          t.input_amount_lamports,
          t.output_amount_lamports || '',
          t.profit_sol?.toFixed(9) || '',
          t.profit_usd?.toFixed(4) || '',
          t.gas_cost_sol?.toFixed(9) || '',
          t.jito_tip_sol?.toFixed(9) || '',
          t.total_fees_sol?.toFixed(9) || '',
          t.sol_price_usd?.toFixed(2) || '',
          this.csvEscape(t.signatures),
          this.csvEscape(t.error || ''),
          this.csvEscape(t.route_description || ''),
          t.created_at,
          t.completed_at || '',
        ].join(',')
      );

      monitorLog.info(
        { fromDate, toDate, tradeCount: filtered.length },
        'Exported trade history to CSV'
      );

      return [headers.join(','), ...rows].join('\n');
    } catch (error) {
      monitorLog.error({ error, fromDate, toDate }, 'Failed to export CSV');
      return '';
    }
  }

  // ═══════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════

  private mapRecordToEntry(record: TradeRecord): TradeEntry {
    let signatures: string[] = [];
    try {
      signatures = JSON.parse(record.signatures || '[]');
    } catch {
      signatures = [];
    }

    return {
      tradeId: record.trade_id,
      strategy: record.strategy,
      status: record.status as TradeEntry['status'],
      inputMint: record.input_mint,
      outputMint: record.output_mint,
      inputAmount: record.input_amount_lamports,
      outputAmount: record.output_amount_lamports,
      profitSol: record.profit_sol,
      profitUsd: record.profit_usd,
      gasCost: record.gas_cost_sol,
      jitoTip: record.jito_tip_sol,
      solPrice: record.sol_price_usd,
      signatures,
      route: record.route_description,
      error: record.error,
      startedAt: record.created_at,
      completedAt: record.completed_at,
    };
  }

  private csvEscape(value: string): string {
    if (!value) return '';
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
