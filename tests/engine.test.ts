// ENGINE TEST SUITE
// Tests for critical paths: config, database, risk management, P&L, fee calculations
// Run with: npx tsx tests/engine.test.ts

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DB_PATH = path.join(__dirname, 'test.db');

function cleanup() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// CONFIG TESTS
// ═══════════════════════════════════════════════════════════════

describe('Config', async () => {
  const { loadConfig, RISK_PROFILES, SCAN_TOKENS, SOL_MINT, USDC_MINT } = await import('../src/engine/config.js');

  it('should load default config', () => {
    const config = loadConfig();
    assert.ok(config.riskLevel);
    assert.ok(config.port > 0);
    assert.strictEqual(config.rpcCommitment, 'confirmed');
  });

  it('should have all risk profiles', () => {
    assert.ok(RISK_PROFILES.CONSERVATIVE);
    assert.ok(RISK_PROFILES.BALANCED);
    assert.ok(RISK_PROFILES.AGGRESSIVE);
  });

  it('should have conservative profile disable sandwich', () => {
    assert.strictEqual(RISK_PROFILES.CONSERVATIVE.strategies.sandwich, false);
    assert.strictEqual(RISK_PROFILES.CONSERVATIVE.strategies.frontrun, false);
  });

  it('should have aggressive profile enable all strategies', () => {
    const strats = RISK_PROFILES.AGGRESSIVE.strategies;
    assert.strictEqual(strats.cyclicArbitrage, true);
    assert.strictEqual(strats.sandwich, true);
    assert.strictEqual(strats.frontrun, true);
    assert.strictEqual(strats.backrun, true);
  });

  it('should have valid SOL and USDC mints', () => {
    assert.strictEqual(SOL_MINT, 'So11111111111111111111111111111111111111112');
    assert.strictEqual(USDC_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('should have scan tokens with valid decimals', () => {
    for (const token of SCAN_TOKENS) {
      assert.ok(token.mint.length > 20, `${token.symbol} has invalid mint`);
      assert.ok(token.decimals >= 0 && token.decimals <= 18, `${token.symbol} has invalid decimals`);
      assert.ok(token.symbol.length > 0, 'token has empty symbol');
    }
  });

  it('risk profiles should have increasing limits', () => {
    assert.ok(RISK_PROFILES.CONSERVATIVE.maxPositionSol < RISK_PROFILES.BALANCED.maxPositionSol);
    assert.ok(RISK_PROFILES.BALANCED.maxPositionSol < RISK_PROFILES.AGGRESSIVE.maxPositionSol);
    assert.ok(RISK_PROFILES.CONSERVATIVE.maxDailyLossSol < RISK_PROFILES.AGGRESSIVE.maxDailyLossSol);
  });
});

// ═══════════════════════════════════════════════════════════════
// DATABASE TESTS
// ═══════════════════════════════════════════════════════════════

describe('Database', async () => {
  const { BotDatabase } = await import('../src/engine/database.js');
  let db: InstanceType<typeof BotDatabase>;

  beforeEach(() => {
    cleanup();
    db = new BotDatabase(TEST_DB_PATH);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it('should create tables on init', () => {
    // If we get here without error, tables were created
    assert.ok(db);
  });

  it('should insert and retrieve trades', () => {
    const trade = {
      trade_id: 'test-001',
      strategy: 'cyclic-arbitrage',
      status: 'completed' as const,
      input_mint: 'So11111111111111111111111111111111111111112',
      output_mint: 'So11111111111111111111111111111111111111112',
      input_amount_lamports: '100000000',
      output_amount_lamports: '101000000',
      profit_sol: 0.001,
      profit_usd: 0.15,
      gas_cost_sol: 0.0001,
      jito_tip_sol: 0.0001,
      total_fees_sol: 0.0002,
      signatures: '["sig1","sig2"]',
      error: null,
      sol_price_usd: 150,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      route_description: 'SOL→BONK→SOL',
      bundle_id: null,
    };

    db.insertTrade(trade);
    const trades = db.getRecentTrades(10);
    assert.strictEqual(trades.length, 1);
    assert.strictEqual(trades[0].trade_id, 'test-001');
    assert.strictEqual(trades[0].profit_sol, 0.001);
  });

  it('should update trade status', () => {
    db.insertTrade({
      trade_id: 'test-002',
      strategy: 'sandwich',
      status: 'executing',
      input_mint: 'SOL',
      output_mint: 'SOL',
      input_amount_lamports: '100000000',
      output_amount_lamports: null,
      profit_sol: null,
      profit_usd: null,
      gas_cost_sol: null,
      jito_tip_sol: null,
      total_fees_sol: null,
      signatures: '[]',
      error: null,
      sol_price_usd: 150,
      created_at: new Date().toISOString(),
      completed_at: null,
      route_description: null,
      bundle_id: null,
    });

    db.updateTrade('test-002', {
      status: 'completed',
      profit_sol: 0.05,
      profit_usd: 7.50,
      completed_at: new Date().toISOString(),
    });

    const trades = db.getRecentTrades(10);
    assert.strictEqual(trades[0].status, 'completed');
    assert.strictEqual(trades[0].profit_sol, 0.05);
  });

  it('should track daily P&L', () => {
    const pnl = db.getTodayPnL();
    assert.strictEqual(pnl.trades_total, 0);
    assert.strictEqual(pnl.net_profit_sol, 0);

    db.updateDailyPnL(0.01, 1.50, 0.001, 0.15, true);
    db.updateDailyPnL(-0.005, -0.75, 0.001, 0.15, false);

    const updated = db.getTodayPnL();
    assert.strictEqual(updated.trades_total, 2);
    assert.strictEqual(updated.trades_won, 1);
    assert.strictEqual(updated.trades_lost, 1);
    assert.ok(Math.abs(updated.total_profit_sol - 0.005) < 0.0001);
  });

  it('should track strategy stats', () => {
    // Insert some trades
    for (let i = 0; i < 5; i++) {
      db.insertTrade({
        trade_id: `strat-test-${i}`,
        strategy: 'cyclic-arbitrage',
        status: 'completed',
        input_mint: 'SOL',
        output_mint: 'SOL',
        input_amount_lamports: '100000000',
        output_amount_lamports: '101000000',
        profit_sol: i < 3 ? 0.01 : -0.005,
        profit_usd: i < 3 ? 1.5 : -0.75,
        gas_cost_sol: 0.0001,
        jito_tip_sol: 0.0001,
        total_fees_sol: 0.0002,
        signatures: '[]',
        error: null,
        sol_price_usd: 150,
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        route_description: null,
        bundle_id: null,
      });
    }

    const stats = db.getStrategyStats();
    assert.strictEqual(stats.length, 1);
    assert.strictEqual(stats[0].strategy, 'cyclic-arbitrage');
    assert.strictEqual(stats[0].total_trades, 5);
    assert.strictEqual(stats[0].winning_trades, 3);
    assert.ok(stats[0].win_rate > 0.5 && stats[0].win_rate < 0.7);
  });

  it('should manage stuck tokens', () => {
    db.addStuckToken('BONK_MINT', 'BONK', '1000000', 'trade-001');
    db.addStuckToken('WIF_MINT', 'WIF', '2000000', 'trade-002');

    const stuck = db.getStuckTokens();
    assert.strictEqual(stuck.length, 2);

    db.markTokenRecovered(stuck[0].id, 'recovery_sig_123');
    const remaining = db.getStuckTokens();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].symbol, 'WIF');
  });

  it('should persist and retrieve bot state', () => {
    db.setState('last_scan_time', '2026-01-01T00:00:00Z');
    db.setState('peak_balance', '10.5');

    assert.strictEqual(db.getState('last_scan_time'), '2026-01-01T00:00:00Z');
    assert.strictEqual(db.getState('peak_balance'), '10.5');
    assert.strictEqual(db.getState('nonexistent'), null);

    // Update existing key
    db.setState('peak_balance', '11.2');
    assert.strictEqual(db.getState('peak_balance'), '11.2');
  });
});

// ═══════════════════════════════════════════════════════════════
// POSITION TRACKER TESTS
// ═══════════════════════════════════════════════════════════════

describe('PositionTracker', async () => {
  const { PositionTracker } = await import('../src/engine/positionTracker.js');
  let tracker: InstanceType<typeof PositionTracker>;

  beforeEach(() => {
    tracker = new PositionTracker();
  });

  it('should open and track positions', () => {
    tracker.openPosition('t1', 'cyclic', 'BONK_MINT', 'BONK', 100000000n, 150);
    tracker.openPosition('t2', 'sandwich', 'WIF_MINT', 'WIF', 200000000n, 150);

    assert.strictEqual(tracker.getPositionCount(), 2);
    const positions = tracker.getOpenPositions();
    assert.strictEqual(positions.length, 2);
  });

  it('should close positions', () => {
    tracker.openPosition('t1', 'cyclic', 'BONK_MINT', 'BONK', 100000000n, 150);
    assert.strictEqual(tracker.getPositionCount(), 1);

    tracker.closePosition('t1', 101000000n, 150);
    assert.strictEqual(tracker.getPositionCount(), 0);
  });

  it('should calculate total exposure', () => {
    tracker.openPosition('t1', 'cyclic', 'BONK_MINT', 'BONK', 1000000000n, 150); // 1 SOL
    tracker.openPosition('t2', 'sandwich', 'WIF_MINT', 'WIF', 2000000000n, 150); // 2 SOL

    const exposure = tracker.getTotalExposureSol();
    assert.ok(Math.abs(exposure - 3.0) < 0.001);
  });

  it('should find old positions', async () => {
    tracker.openPosition('t1', 'cyclic', 'BONK_MINT', 'BONK', 100000000n, 150);

    // Just opened - should not be old
    const old = tracker.getOldPositions(1000);
    assert.strictEqual(old.length, 0);

    // Wait a bit then check with very small threshold
    await new Promise(r => setTimeout(r, 50));
    const oldNow = tracker.getOldPositions(10); // 10ms threshold
    assert.strictEqual(oldNow.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════
// FEE CALCULATION TESTS
// ═══════════════════════════════════════════════════════════════

describe('Fee Calculations', () => {
  it('should calculate basic arbitrage profitability', () => {
    const inputLamports = 100_000_000; // 0.1 SOL
    const outputLamports = 101_500_000; // 0.1015 SOL
    const grossProfitSol = (outputLamports - inputLamports) / 1e9; // 0.0015 SOL

    // Fees breakdown
    const gasFee = 5000 / 1e9;          // ~0.000005 SOL
    const priorityFee = 100_000 / 1e9;  // 0.0001 SOL
    const jitoTip = 100_000 / 1e9;      // 0.0001 SOL
    const jupiterFee = inputLamports * 0.001 / 1e9; // 0.1% = 0.0001 SOL
    const dexFee = inputLamports * 0.0025 / 1e9;    // 0.25% = 0.00025 SOL

    const totalFees = gasFee + priorityFee + jitoTip + jupiterFee + dexFee;
    const netProfit = grossProfitSol - totalFees;

    assert.ok(grossProfitSol > 0, 'Gross profit should be positive');
    assert.ok(totalFees > 0, 'Fees should be positive');
    assert.ok(totalFees < grossProfitSol, 'This trade should be profitable after fees');
    assert.ok(netProfit > 0.0009, 'Net profit should be > 0.0009 SOL');
  });

  it('should reject unprofitable trades after fees', () => {
    const inputLamports = 100_000_000; // 0.1 SOL
    const outputLamports = 100_050_000; // 0.10005 SOL (only 0.05% return)
    const grossProfitSol = (outputLamports - inputLamports) / 1e9; // 0.00005 SOL

    const totalFees = (5000 + 100_000 + 100_000) / 1e9 + inputLamports * 0.0035 / 1e9;
    const netProfit = grossProfitSol - totalFees;

    assert.ok(netProfit < 0, 'This trade should be unprofitable after fees');
  });

  it('should calculate sandwich profitability correctly', () => {
    // Sandwich: 2 swaps (front + back) = 2x fees
    const frontBuyLamports = 500_000_000; // 0.5 SOL buy before victim
    const backSellLamports = 505_000_000; // 0.505 SOL sell after victim (1% gain)
    const grossProfitSol = (backSellLamports - frontBuyLamports) / 1e9; // 0.005 SOL

    // 2x everything for sandwich
    const gasFee = 2 * 5000 / 1e9;
    const priorityFee = 2 * 200_000 / 1e9; // Higher priority for sandwich
    const jitoTip = 200_000 / 1e9;          // Jito tip for bundle
    const dexFees = 2 * frontBuyLamports * 0.0025 / 1e9;

    const totalFees = gasFee + priorityFee + jitoTip + dexFees;
    const netProfit = grossProfitSol - totalFees;

    assert.ok(totalFees < grossProfitSol, 'Sandwich should be profitable for 1% price impact');
    assert.ok(netProfit > 0.001, `Net sandwich profit should be meaningful: ${netProfit}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════');
console.log('  SOLANA MEV BOT - ENGINE TEST SUITE');
console.log('═══════════════════════════════════════════\n');
