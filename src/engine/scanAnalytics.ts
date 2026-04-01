// SCAN ANALYTICS — Persistent logging for all scan results, opportunities, and errors
//
// Writes JSONL files to ./logs/ so every scan result is captured for offline analysis.
// Files rotate daily: scan_2026-04-01.jsonl, opportunities_2026-04-01.jsonl, etc.
//
// NO changes to strategy logic — this is purely additive observability.

import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.resolve(process.cwd(), 'logs');

// Ensure logs directory exists on import
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* exists */ }

// ── Helpers ─────────────────────────────────────────────────────────

function dateTag(): string {
  return new Date().toISOString().slice(0, 10); // "2026-04-01"
}

function appendLine(prefix: string, data: Record<string, any>): void {
  const file = path.join(LOGS_DIR, `${prefix}_${dateTag()}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n';
  fs.appendFile(file, line, (err) => {
    if (err) console.error(`[scanAnalytics] write error: ${err.message}`);
  });
}

// ── Scan Result (every token check, positive or negative) ───────────

export interface ScanEntry {
  strategy: string;
  token: string;
  spreadBps: number;
  grossProfitSol: number;
  netProfitUsd: number;
  fees: number;
  profitable: boolean;
}

export function logScan(entry: ScanEntry): void {
  appendLine('scans', entry);
}

// ── Opportunity (only when netProfitUsd > 0) ────────────────────────

export interface OpportunityEntry {
  strategy: string;
  tokenPath: string[];
  inputSol: number;
  expectedProfitSol: number;
  expectedProfitUsd: number;
  confidence: number;
  spreadBps?: number;
  metadata?: Record<string, any>;
  executed: boolean;
  executionResult?: 'success' | 'failed' | 'skipped' | 'expired';
  executionError?: string;
  signatures?: string[];
  verifiedProfitSol?: number;
  verifiedProfitUsd?: number;
  latencyMs?: number;
}

export function logOpportunity(entry: OpportunityEntry): void {
  appendLine('opportunities', entry);
}

// ── Strategy Cycle Timing ───────────────────────────────────────────

export interface CycleEntry {
  strategy: string;
  durationMs: number;
  tokensScanned: number;
  jupiterCalls: number;
  raydiumCalls: number;
  errors429: number;
  errorsOther: number;
  profitableFound: number;
}

export function logCycle(entry: CycleEntry): void {
  appendLine('cycles', entry);
}

// ── Full Scan Loop Timing ───────────────────────────────────────────

export interface LoopEntry {
  totalDurationMs: number;
  strategiesRun: number;
  totalOpportunities: number;
  totalProfitable: number;
  solPriceUsd: number;
  balanceSol: number;
  strategyCycleTimes: Record<string, number>; // strategy -> ms
}

export function logLoop(entry: LoopEntry): void {
  appendLine('loops', entry);
}

// ── API Errors (429s, timeouts, etc.) ───────────────────────────────

export interface ApiErrorEntry {
  strategy: string;
  api: 'jupiter' | 'raydium' | 'coingecko' | 'rpc';
  errorType: '429' | 'timeout' | 'network' | 'parse' | 'other';
  statusCode?: number;
  message?: string;
  endpoint?: string;
}

export function logApiError(entry: ApiErrorEntry): void {
  appendLine('api_errors', entry);
}

// ── Trade Execution Result ──────────────────────────────────────────

export interface TradeEntry {
  tradeId: string;
  strategy: string;
  tokenPath: string[];
  inputSol: number;
  expectedProfitUsd: number;
  result: 'success' | 'failed' | 'skipped' | 'expired';
  verifiedProfitSol?: number;
  verifiedProfitUsd?: number;
  signatures?: string[];
  error?: string;
  latencyMs: number;
  solPriceUsd: number;
}

export function logTrade(entry: TradeEntry): void {
  appendLine('trades', entry);
}

// ── Read logs for API/dashboard ─────────────────────────────────────

export function readLogFile(prefix: string, date?: string, tailLines: number = 200): string[] {
  const tag = date || dateTag();
  const file = path.join(LOGS_DIR, `${prefix}_${tag}.jsonl`);
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-tailLines);
  } catch {
    return [];
  }
}

export function listLogFiles(): string[] {
  try {
    return fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

// ── Summary stats from today's scan log ─────────────────────────────

export interface DailySummary {
  date: string;
  totalScans: number;
  profitableScans: number;
  bestSpread: { token: string; spreadBps: number; strategy: string } | null;
  worstSpread: { token: string; spreadBps: number; strategy: string } | null;
  averageSpreadBps: number;
  tokenBreakdown: Record<string, { count: number; avgSpreadBps: number; bestBps: number; profitableCount: number }>;
  strategyBreakdown: Record<string, { count: number; avgSpreadBps: number; profitableCount: number }>;
  totalOpportunities: number;
  totalTrades: number;
  totalErrors429: number;
}

export function getDailySummary(date?: string): DailySummary {
  const tag = date || dateTag();
  const scanLines = readLogFile('scans', tag, 100000);
  const oppLines = readLogFile('opportunities', tag, 100000);
  const errorLines = readLogFile('api_errors', tag, 100000);

  const summary: DailySummary = {
    date: tag,
    totalScans: scanLines.length,
    profitableScans: 0,
    bestSpread: null,
    worstSpread: null,
    averageSpreadBps: 0,
    tokenBreakdown: {},
    strategyBreakdown: {},
    totalOpportunities: oppLines.length,
    totalTrades: 0,
    totalErrors429: 0,
  };

  let totalSpread = 0;

  for (const line of scanLines) {
    try {
      const entry = JSON.parse(line) as ScanEntry & { ts: string };
      if (entry.profitable) summary.profitableScans++;
      totalSpread += entry.spreadBps;

      if (!summary.bestSpread || entry.spreadBps > summary.bestSpread.spreadBps) {
        summary.bestSpread = { token: entry.token, spreadBps: entry.spreadBps, strategy: entry.strategy };
      }
      if (!summary.worstSpread || entry.spreadBps < summary.worstSpread.spreadBps) {
        summary.worstSpread = { token: entry.token, spreadBps: entry.spreadBps, strategy: entry.strategy };
      }

      // Token breakdown
      const tokenKey = entry.token.split('@')[0].split(' ')[0]; // strip amount/suffix
      if (!summary.tokenBreakdown[tokenKey]) {
        summary.tokenBreakdown[tokenKey] = { count: 0, avgSpreadBps: 0, bestBps: -Infinity, profitableCount: 0 };
      }
      const tb = summary.tokenBreakdown[tokenKey];
      tb.count++;
      tb.avgSpreadBps = (tb.avgSpreadBps * (tb.count - 1) + entry.spreadBps) / tb.count;
      if (entry.spreadBps > tb.bestBps) tb.bestBps = entry.spreadBps;
      if (entry.profitable) tb.profitableCount++;

      // Strategy breakdown
      if (!summary.strategyBreakdown[entry.strategy]) {
        summary.strategyBreakdown[entry.strategy] = { count: 0, avgSpreadBps: 0, profitableCount: 0 };
      }
      const sb = summary.strategyBreakdown[entry.strategy];
      sb.count++;
      sb.avgSpreadBps = (sb.avgSpreadBps * (sb.count - 1) + entry.spreadBps) / sb.count;
      if (entry.profitable) sb.profitableCount++;
    } catch { /* skip malformed */ }
  }

  if (scanLines.length > 0) {
    summary.averageSpreadBps = totalSpread / scanLines.length;
  }

  for (const line of errorLines) {
    try {
      const entry = JSON.parse(line) as ApiErrorEntry & { ts: string };
      if (entry.errorType === '429') summary.totalErrors429++;
    } catch { /* skip */ }
  }

  return summary;
}
