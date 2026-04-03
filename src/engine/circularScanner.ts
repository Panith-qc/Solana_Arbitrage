// CIRCULAR SCANNER — Background Jupiter scanning process
// Runs IN PARALLEL with the WebSocket hot path.
// Uses 4 Jupiter API keys rotating round-robin to maximize throughput.
// Scans circular routes: SOL → Token → SOL across different DEXes.
// This is the WARM PATH (~450ms per cycle via Jupiter quote API).

import { executionLog } from './logger.js';
import {
  BotConfig,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  TokenInfo,
  TWO_LEG_FEE_LAMPORTS,
  JUPITER_MAX_ACCOUNTS,
} from './config.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CircularOpportunity {
  tokenSymbol: string;
  tokenMint: string;
  inputLamports: number;
  outputLamports: number;
  grossProfitLamports: number;
  netProfitLamports: number;
  spreadBps: number;
  buyRoute: string;
  sellRoute: string;
  timestamp: number;
}

export type CircularCallback = (opp: CircularOpportunity) => void;

// ═══════════════════════════════════════════════════════════════
// Circular Scanner
// ═══════════════════════════════════════════════════════════════

const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

export class CircularScanner {
  private config: BotConfig;
  private apiKeys: string[] = [];
  private keyIndex = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: CircularCallback[] = [];

  // Scan amounts in lamports — try multiple sizes per token
  private scanAmounts: bigint[];

  // Stats
  private totalScans = 0;
  private totalOpportunities = 0;
  private cycleCount = 0;
  private lastCycleMs = 0;

  // Scan interval — 250ms between individual quote pairs
  private readonly SCAN_INTERVAL_MS = 250;

  constructor(config: BotConfig) {
    this.config = config;

    // Collect all configured Jupiter API keys
    if (config.jupiterApiKey) this.apiKeys.push(config.jupiterApiKey);
    if (config.jupiterApiKey2) this.apiKeys.push(config.jupiterApiKey2);
    if (config.jupiterApiKey3) this.apiKeys.push(config.jupiterApiKey3);
    if (config.jupiterApiKey4) this.apiKeys.push(config.jupiterApiKey4);

    if (this.apiKeys.length === 0) {
      executionLog.warn('CircularScanner: No Jupiter API keys configured — scanner disabled');
    }

    // Scan at configured amount and half that amount
    const baseLamports = BigInt(Math.round(config.scanAmountSol * LAMPORTS_PER_SOL));
    this.scanAmounts = [baseLamports, baseLamports / 2n];

    executionLog.info(
      {
        apiKeys: this.apiKeys.length,
        tokens: SCAN_TOKENS.length,
        scanAmounts: this.scanAmounts.map(a => `${Number(a) / LAMPORTS_PER_SOL} SOL`),
      },
      'CircularScanner initialized',
    );
  }

  /** Register a callback for when profitable circular routes are found */
  onOpportunity(cb: CircularCallback): void {
    this.callbacks.push(cb);
  }

  /** Start the background scanning loop */
  start(): void {
    if (this.running || this.apiKeys.length === 0) return;
    this.running = true;
    executionLog.info('CircularScanner STARTED — background Jupiter scanning active');
    this.runCycle();
  }

  /** Stop the scanner */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    executionLog.info(
      { totalScans: this.totalScans, totalOpportunities: this.totalOpportunities, cycles: this.cycleCount },
      'CircularScanner STOPPED',
    );
  }

  /** Get the next API key (round-robin) */
  private nextKey(): string {
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length];
    this.keyIndex++;
    return key;
  }

  /** Build headers with the next API key */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const key = this.nextKey();
    if (key) headers['x-api-key'] = key;
    return headers;
  }

  /** Run one complete scan cycle through all tokens */
  private async runCycle(): Promise<void> {
    if (!this.running) return;

    const cycleStart = Date.now();
    this.cycleCount++;

    for (const token of SCAN_TOKENS) {
      if (!this.running) break;

      for (const amount of this.scanAmounts) {
        if (!this.running) break;

        try {
          await this.scanCircularRoute(token, amount);
        } catch (err: any) {
          executionLog.debug(
            { err: err?.message, token: token.symbol },
            'CircularScanner: scan error',
          );
        }

        // Wait between scans to respect rate limits across 4 keys
        await sleep(this.SCAN_INTERVAL_MS);
      }
    }

    this.lastCycleMs = Date.now() - cycleStart;

    if (this.cycleCount % 10 === 0) {
      executionLog.info(
        {
          cycle: this.cycleCount,
          cycleMs: this.lastCycleMs,
          scans: this.totalScans,
          opportunities: this.totalOpportunities,
        },
        'CircularScanner: cycle stats',
      );
    }

    // Schedule next cycle immediately
    if (this.running) {
      this.timer = setTimeout(() => this.runCycle(), 50);
    }
  }

  /**
   * Scan a single circular route: SOL → Token → SOL
   * Uses two Jupiter quotes: forward (buy) and reverse (sell).
   */
  private async scanCircularRoute(token: TokenInfo, inputLamports: bigint): Promise<void> {
    this.totalScans++;

    // Forward quote: SOL → Token
    const forwardParams = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: token.mint,
      amount: inputLamports.toString(),
      slippageBps: '50',
      maxAccounts: String(JUPITER_MAX_ACCOUNTS),
    });

    const forwardResp = await fetch(`${JUPITER_QUOTE_URL}?${forwardParams}`, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(5000),
    });

    if (!forwardResp.ok) return;
    const forwardQuote = await forwardResp.json() as any;
    if (!forwardQuote?.outAmount) return;

    const tokenAmount = forwardQuote.outAmount;

    // Reverse quote: Token → SOL
    const reverseParams = new URLSearchParams({
      inputMint: token.mint,
      outputMint: SOL_MINT,
      amount: tokenAmount,
      slippageBps: '50',
      maxAccounts: String(JUPITER_MAX_ACCOUNTS),
    });

    const reverseResp = await fetch(`${JUPITER_QUOTE_URL}?${reverseParams}`, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(5000),
    });

    if (!reverseResp.ok) return;
    const reverseQuote = await reverseResp.json() as any;
    if (!reverseQuote?.outAmount) return;

    const outputLamports = parseInt(reverseQuote.outAmount, 10);
    const inputNum = Number(inputLamports);
    const grossProfit = outputLamports - inputNum;
    const netProfit = grossProfit - TWO_LEG_FEE_LAMPORTS;
    const spreadBps = (grossProfit / inputNum) * 10_000;

    // Extract route labels
    const buyRoute = (forwardQuote.routePlan || [])
      .map((r: any) => r?.swapInfo?.label || '?')
      .join(' → ');
    const sellRoute = (reverseQuote.routePlan || [])
      .map((r: any) => r?.swapInfo?.label || '?')
      .join(' → ');

    if (netProfit > 0) {
      this.totalOpportunities++;

      const opp: CircularOpportunity = {
        tokenSymbol: token.symbol,
        tokenMint: token.mint,
        inputLamports: inputNum,
        outputLamports,
        grossProfitLamports: grossProfit,
        netProfitLamports: netProfit,
        spreadBps,
        buyRoute,
        sellRoute,
        timestamp: Date.now(),
      };

      executionLog.info(
        {
          token: token.symbol,
          inputSol: (inputNum / LAMPORTS_PER_SOL).toFixed(3),
          grossProfitSol: (grossProfit / LAMPORTS_PER_SOL).toFixed(6),
          netProfitSol: (netProfit / LAMPORTS_PER_SOL).toFixed(6),
          spreadBps: spreadBps.toFixed(1),
          buy: buyRoute,
          sell: sellRoute,
        },
        `CIRCULAR: ${token.symbol} +${spreadBps.toFixed(1)}bps — PROFITABLE`,
      );

      for (const cb of this.callbacks) {
        try { cb(opp); } catch {}
      }
    }
  }

  /** Get scanner stats */
  getStats() {
    return {
      running: this.running,
      apiKeys: this.apiKeys.length,
      totalScans: this.totalScans,
      totalOpportunities: this.totalOpportunities,
      cycleCount: this.cycleCount,
      lastCycleMs: this.lastCycleMs,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
