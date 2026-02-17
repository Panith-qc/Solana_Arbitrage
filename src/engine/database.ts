// DATABASE LAYER
// SQLite persistence for trades, P&L, strategy performance, and state recovery
// Uses better-sqlite3 for synchronous, fast operations

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { engineLog } from './logger.js';

export interface TradeRecord {
  id?: number;
  trade_id: string;
  strategy: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'partial';
  input_mint: string;
  output_mint: string;
  input_amount_lamports: string;
  output_amount_lamports: string | null;
  profit_sol: number | null;
  profit_usd: number | null;
  gas_cost_sol: number | null;
  jito_tip_sol: number | null;
  total_fees_sol: number | null;
  signatures: string;
  error: string | null;
  sol_price_usd: number;
  created_at: string;
  completed_at: string | null;
  route_description: string | null;
  bundle_id: string | null;
}

export interface DailyPnL {
  date: string;
  total_profit_sol: number;
  total_profit_usd: number;
  total_fees_sol: number;
  total_fees_usd: number;
  net_profit_sol: number;
  net_profit_usd: number;
  trades_total: number;
  trades_won: number;
  trades_lost: number;
  max_drawdown_sol: number;
  peak_balance_sol: number;
}

export interface StrategyStats {
  strategy: string;
  total_trades: number;
  winning_trades: number;
  total_profit_sol: number;
  total_profit_usd: number;
  avg_profit_per_trade_sol: number;
  best_trade_sol: number;
  worst_trade_sol: number;
  win_rate: number;
  last_trade_at: string | null;
}

export class BotDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || path.join(process.cwd(), 'data', 'bot.db');
    // Ensure directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL'); // Write-ahead logging for performance
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache
    this.initialize();
    engineLog.info({ path: resolvedPath }, 'Database initialized');
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT UNIQUE NOT NULL,
        strategy TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        input_amount_lamports TEXT NOT NULL,
        output_amount_lamports TEXT,
        profit_sol REAL,
        profit_usd REAL,
        gas_cost_sol REAL,
        jito_tip_sol REAL,
        total_fees_sol REAL,
        signatures TEXT DEFAULT '[]',
        error TEXT,
        sol_price_usd REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        route_description TEXT,
        bundle_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);

      CREATE TABLE IF NOT EXISTS daily_pnl (
        date TEXT PRIMARY KEY,
        total_profit_sol REAL DEFAULT 0,
        total_profit_usd REAL DEFAULT 0,
        total_fees_sol REAL DEFAULT 0,
        total_fees_usd REAL DEFAULT 0,
        net_profit_sol REAL DEFAULT 0,
        net_profit_usd REAL DEFAULT 0,
        trades_total INTEGER DEFAULT 0,
        trades_won INTEGER DEFAULT 0,
        trades_lost INTEGER DEFAULT 0,
        max_drawdown_sol REAL DEFAULT 0,
        peak_balance_sol REAL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS stuck_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        balance TEXT NOT NULL,
        original_trade_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        recovered_at TEXT,
        recovery_signature TEXT
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ═══════════════════════════════════════════════
  // TRADE OPERATIONS
  // ═══════════════════════════════════════════════

  insertTrade(trade: Omit<TradeRecord, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO trades (trade_id, strategy, status, input_mint, output_mint,
        input_amount_lamports, output_amount_lamports, profit_sol, profit_usd,
        gas_cost_sol, jito_tip_sol, total_fees_sol, signatures, error,
        sol_price_usd, created_at, completed_at, route_description, bundle_id)
      VALUES (@trade_id, @strategy, @status, @input_mint, @output_mint,
        @input_amount_lamports, @output_amount_lamports, @profit_sol, @profit_usd,
        @gas_cost_sol, @jito_tip_sol, @total_fees_sol, @signatures, @error,
        @sol_price_usd, @created_at, @completed_at, @route_description, @bundle_id)
    `);
    stmt.run(trade);
  }

  updateTrade(tradeId: string, updates: Partial<TradeRecord>): void {
    const fields = Object.keys(updates)
      .filter(k => k !== 'trade_id' && k !== 'id')
      .map(k => `${k} = @${k}`)
      .join(', ');
    if (!fields) return;

    const stmt = this.db.prepare(`UPDATE trades SET ${fields} WHERE trade_id = @trade_id`);
    stmt.run({ ...updates, trade_id: tradeId });
  }

  getRecentTrades(limit: number = 50): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as TradeRecord[];
  }

  getTradesByStrategy(strategy: string, limit: number = 50): TradeRecord[] {
    return this.db.prepare(
      'SELECT * FROM trades WHERE strategy = ? ORDER BY created_at DESC LIMIT ?'
    ).all(strategy, limit) as TradeRecord[];
  }

  // ═══════════════════════════════════════════════
  // DAILY P&L
  // ═══════════════════════════════════════════════

  getTodayPnL(): DailyPnL {
    const today = new Date().toISOString().split('T')[0];
    const existing = this.db.prepare('SELECT * FROM daily_pnl WHERE date = ?').get(today) as DailyPnL | undefined;
    if (existing) return existing;

    // Create today's entry
    this.db.prepare(`
      INSERT OR IGNORE INTO daily_pnl (date) VALUES (?)
    `).run(today);

    return this.db.prepare('SELECT * FROM daily_pnl WHERE date = ?').get(today) as DailyPnL;
  }

  updateDailyPnL(profitSol: number, profitUsd: number, feesSol: number, feesUsd: number, won: boolean): void {
    const today = new Date().toISOString().split('T')[0];

    // Ensure row exists
    this.db.prepare('INSERT OR IGNORE INTO daily_pnl (date) VALUES (?)').run(today);

    this.db.prepare(`
      UPDATE daily_pnl SET
        total_profit_sol = total_profit_sol + ?,
        total_profit_usd = total_profit_usd + ?,
        total_fees_sol = total_fees_sol + ?,
        total_fees_usd = total_fees_usd + ?,
        net_profit_sol = net_profit_sol + ? - ?,
        net_profit_usd = net_profit_usd + ? - ?,
        trades_total = trades_total + 1,
        trades_won = trades_won + ?,
        trades_lost = trades_lost + ?
      WHERE date = ?
    `).run(
      profitSol, profitUsd, feesSol, feesUsd,
      profitSol, feesSol, profitUsd, feesUsd,
      won ? 1 : 0, won ? 0 : 1, today
    );
  }

  updateDrawdown(drawdownSol: number, peakSol: number): void {
    const today = new Date().toISOString().split('T')[0];
    this.db.prepare(`
      UPDATE daily_pnl SET
        max_drawdown_sol = MAX(max_drawdown_sol, ?),
        peak_balance_sol = MAX(peak_balance_sol, ?)
      WHERE date = ?
    `).run(drawdownSol, peakSol, today);
  }

  getDailyPnLHistory(days: number = 30): DailyPnL[] {
    return this.db.prepare(
      'SELECT * FROM daily_pnl ORDER BY date DESC LIMIT ?'
    ).all(days) as DailyPnL[];
  }

  // ═══════════════════════════════════════════════
  // STRATEGY STATS
  // ═══════════════════════════════════════════════

  getStrategyStats(): StrategyStats[] {
    return this.db.prepare(`
      SELECT
        strategy,
        COUNT(*) as total_trades,
        SUM(CASE WHEN profit_sol > 0 THEN 1 ELSE 0 END) as winning_trades,
        COALESCE(SUM(profit_sol), 0) as total_profit_sol,
        COALESCE(SUM(profit_usd), 0) as total_profit_usd,
        COALESCE(AVG(profit_sol), 0) as avg_profit_per_trade_sol,
        COALESCE(MAX(profit_sol), 0) as best_trade_sol,
        COALESCE(MIN(profit_sol), 0) as worst_trade_sol,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN profit_sol > 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0
        END as win_rate,
        MAX(completed_at) as last_trade_at
      FROM trades
      WHERE status = 'completed'
      GROUP BY strategy
    `).all() as StrategyStats[];
  }

  // ═══════════════════════════════════════════════
  // STUCK TOKENS
  // ═══════════════════════════════════════════════

  addStuckToken(tokenMint: string, symbol: string, balance: string, tradeId?: string): void {
    this.db.prepare(`
      INSERT INTO stuck_tokens (token_mint, symbol, balance, original_trade_id)
      VALUES (?, ?, ?, ?)
    `).run(tokenMint, symbol, balance, tradeId || null);
  }

  getStuckTokens(): Array<{ id: number; token_mint: string; symbol: string; balance: string; created_at: string }> {
    return this.db.prepare(
      'SELECT * FROM stuck_tokens WHERE recovered_at IS NULL ORDER BY created_at'
    ).all() as any[];
  }

  markTokenRecovered(id: number, signature: string): void {
    this.db.prepare(`
      UPDATE stuck_tokens SET recovered_at = datetime('now'), recovery_signature = ? WHERE id = ?
    `).run(signature, id);
  }

  // ═══════════════════════════════════════════════
  // BOT STATE (key-value persistence)
  // ═══════════════════════════════════════════════

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  setState(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    `).run(key, value);
  }

  // ═══════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════

  close(): void {
    this.db.close();
    engineLog.info('Database closed');
  }
}
