// CROSS-DEX ARBITRAGE — Two-Phase Smart Scanner
//
// Phase 1 (Quick): Aggregator round-trip check per token (2 API calls each).
//   Buy via aggregator, sell via aggregator. If round-trip loss > 3 bps, skip.
//   This eliminates 80%+ of tokens in ~40 seconds.
//
// Phase 2 (Deep): For surviving tokens, get DEX-specific BUY quotes to find
//   a cheaper entry point than the aggregator. Sell via aggregator (best exit).
//   If DEX-specific buy + aggregator sell > input SOL, we have profit.
//
// Key insight: The sell side should ALWAYS use the aggregator (no dexes
// restriction) because the aggregator finds multi-hop routes that give
// more SOL back than any single-DEX route.

import crypto from 'crypto';
import { BaseStrategy, Opportunity, StrategyConfig } from './baseStrategy.js';
import { strategyLog } from '../logger.js';
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  TokenInfo,
  BotConfig,
  RiskProfile,
  USDC_MINT,
  BASE_GAS_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  JITO_TIP_LAMPORTS,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

const ALL_TOKENS = SCAN_TOKENS.filter(t => t.mint !== SOL_MINT && t.mint !== USDC_MINT);
const QUOTE_LIFETIME_MS = 10_000;
const EXECUTION_SAFETY_BUFFER_BPS = 1;

// DEX groups for Phase 2 deep scan — only the 3 biggest with real liquidity
const DEX_GROUPS = [
  { name: 'raydium', dexes: 'Raydium,Raydium CLMM' },
  { name: 'orca', dexes: 'Orca,Whirlpool' },
  { name: 'meteora', dexes: 'Meteora,Meteora DLMM' },
];

const SCAN_AMOUNTS_SOL = [5, 10];

// Phase 1 filter: skip tokens with worse than this round-trip loss
const PHASE1_ROUND_TRIP_THRESHOLD_BPS = -5;

interface DexQuote {
  source: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  pricePerToken: number;
  raw: any;
}

export class CrossDexArbitrageStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private lastJupiterCallMs: number = 0;

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'cross-dex-arbitrage',
      enabled: riskProfile.strategies.crossDexArbitrage,
      scanIntervalMs: 3_000,
      minProfitUsd: 0.001,
      maxPositionSol: riskProfile.maxPositionSol,
      slippageBps: riskProfile.slippageBps,
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.riskProfile = riskProfile;
  }

  getName(): string {
    return 'Cross-DEX Arbitrage';
  }

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];

    strategyLog.info(
      { tokens: ALL_TOKENS.length, amounts: SCAN_AMOUNTS_SOL, scan: this.scanCount },
      'Two-phase scan starting',
    );

    for (const scanSol of SCAN_AMOUNTS_SOL) {
      const scanAmountStr = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL)).toString();

      // ── PHASE 1: Quick aggregator round-trip filter ──
      const candidates: { token: TokenInfo; buyQuote: DexQuote; roundTripBps: number }[] = [];

      for (const token of ALL_TOKENS) {
        try {
          const result = await this.phase1QuickCheck(token, scanSol, scanAmountStr);
          if (result) {
            candidates.push(result);
          }
        } catch (err) {
          strategyLog.debug({ err, token: token.symbol }, 'Phase 1 error');
        }
      }

      if (candidates.length === 0) {
        strategyLog.info(
          { scanSol, tokensChecked: ALL_TOKENS.length },
          'Phase 1: no candidates passed round-trip filter',
        );
        continue;
      }

      // Sort: closest to profitable first
      candidates.sort((a, b) => b.roundTripBps - a.roundTripBps);

      strategyLog.info(
        {
          scanSol,
          candidates: candidates.map(c => `${c.token.symbol}(${c.roundTripBps.toFixed(1)}bps)`).join(', '),
        },
        `Phase 1: ${candidates.length} candidates for deep scan`,
      );

      // ── PHASE 2: DEX-specific buy quotes for candidates ──
      for (const candidate of candidates) {
        try {
          const opp = await this.phase2DeepScan(candidate.token, scanSol, scanAmountStr, candidate.buyQuote);
          if (opp) {
            opportunities.push(opp);
          }
        } catch (err) {
          strategyLog.debug({ err, token: candidate.token.symbol }, 'Phase 2 error');
        }
      }
    }

    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.info(
      { found: opportunities.length, scanCount: this.scanCount },
      `Scan complete — ${opportunities.length} profitable`,
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 1: Quick aggregator round-trip (2 API calls per token)
  // ────────────────────────────────────────────────────────────────────────────

  private async phase1QuickCheck(
    token: TokenInfo, scanSol: number, scanAmountStr: string,
  ): Promise<{ token: TokenInfo; buyQuote: DexQuote; roundTripBps: number } | null> {
    // Get aggregator buy quote (best route across ALL DEXes)
    await this.jupiterRateLimit();
    const buyQuote = await this.getJupiterQuote(SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps);

    if (!buyQuote) {
      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (no buy)`,
        spreadBps: 0, grossProfitSol: 0, netProfitUsd: 0, fees: 0, profitable: false,
      });
      return null;
    }

    // Get aggregator sell quote (best route to convert tokens back to SOL)
    await this.jupiterRateLimit();
    const sellQuote = await this.getJupiterQuote(token.mint, SOL_MINT, buyQuote.outputAmount, this.config.slippageBps);

    if (!sellQuote) {
      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (no sell)`,
        spreadBps: 0, grossProfitSol: 0, netProfitUsd: 0, fees: 0, profitable: false,
      });
      return null;
    }

    // Round-trip: how many bps do we lose/gain on buy+sell via aggregator?
    const inputLamports = parseFloat(scanAmountStr);
    const outputLamports = parseFloat(sellQuote.outputAmount);
    const roundTripBps = ((outputLamports - inputLamports) / inputLamports) * 10_000;

    this.onScanResult?.({
      strategy: this.name,
      token: `${token.symbol}@${scanSol} (agg)`,
      spreadBps: roundTripBps,
      grossProfitSol: (outputLamports - inputLamports) / LAMPORTS_PER_SOL,
      netProfitUsd: 0,
      fees: 0,
      profitable: false,
    });

    strategyLog.info(
      {
        token: token.symbol, scanSol,
        roundTripBps: roundTripBps.toFixed(1),
        buyRoute: buyQuote.raw?.routePlan?.[0]?.swapInfo?.label || 'unknown',
        sellRoute: sellQuote.raw?.routePlan?.[0]?.swapInfo?.label || 'unknown',
      },
      `Phase1: ${token.symbol}@${scanSol} aggregator round-trip ${roundTripBps.toFixed(1)}bps`,
    );

    // Filter: if round-trip is too bad, no DEX-specific route will help
    if (roundTripBps < PHASE1_ROUND_TRIP_THRESHOLD_BPS) {
      return null;
    }

    return { token, buyQuote, roundTripBps };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PHASE 2: DEX-specific buy + aggregator sell
  // ────────────────────────────────────────────────────────────────────────────

  private async phase2DeepScan(
    token: TokenInfo, scanSol: number, scanAmountStr: string, aggregatorBuy: DexQuote,
  ): Promise<Opportunity | null> {
    const scanAmountLamports = BigInt(scanAmountStr);

    // Get DEX-specific buy quotes to find a cheaper entry than the aggregator
    const buyQuotes: DexQuote[] = [
      { ...aggregatorBuy, source: 'aggregator' },
    ];

    for (const dexGroup of DEX_GROUPS) {
      await this.jupiterRateLimit();
      const quote = await this.getJupiterDexQuote(
        SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps, dexGroup.dexes,
      );
      if (quote) {
        buyQuotes.push({ ...quote, source: dexGroup.name });
      }
    }

    // Sort: most tokens first (cheapest entry)
    buyQuotes.sort((a, b) => parseFloat(b.outputAmount) - parseFloat(a.outputAmount));
    const bestBuy = buyQuotes[0];

    // If best buy is the aggregator, no cross-DEX advantage exists
    const bestBuyTokens = parseFloat(bestBuy.outputAmount);
    const aggTokens = parseFloat(aggregatorBuy.outputAmount);
    const buyAdvantageBps = ((bestBuyTokens - aggTokens) / aggTokens) * 10_000;

    strategyLog.info(
      {
        token: token.symbol, scanSol,
        bestBuySource: bestBuy.source,
        buyAdvantageBps: buyAdvantageBps.toFixed(1),
        quotes: buyQuotes.map(q => `${q.source}=${q.outputAmount}`).join(', '),
      },
      `Phase2: ${token.symbol} best buy: ${bestBuy.source} (${buyAdvantageBps.toFixed(1)}bps over aggregator)`,
    );

    // Now get aggregator sell for the best buy amount (no dexes restriction = best exit)
    await this.jupiterRateLimit();
    const sellQuote = await this.getJupiterQuote(
      token.mint, SOL_MINT, bestBuy.outputAmount, this.config.slippageBps,
    );

    if (!sellQuote) {
      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (no sell P2)`,
        spreadBps: 0, grossProfitSol: 0, netProfitUsd: 0, fees: 0, profitable: false,
      });
      return null;
    }

    // Calculate round-trip profit
    const profitAnalysis = this.calculateProfit(scanAmountLamports, BigInt(sellQuote.outputAmount));
    const spreadBps = (Number(BigInt(sellQuote.outputAmount)) - Number(scanAmountLamports))
      / Number(scanAmountLamports) * 10_000;

    this.onScanResult?.({
      strategy: this.name,
      token: `${token.symbol}@${scanSol} (${bestBuy.source}→agg)`,
      spreadBps,
      grossProfitSol: profitAnalysis.grossProfitSol,
      netProfitUsd: profitAnalysis.netProfitUsd,
      fees: profitAnalysis.totalFeeSol,
      profitable: profitAnalysis.netProfitUsd >= this.config.minProfitUsd,
    });

    const logLevel = profitAnalysis.grossProfitSol > 0 ? 'warn' : 'info';
    strategyLog[logLevel](
      {
        token: token.symbol, sol: scanSol,
        buy: bestBuy.source, sell: 'aggregator',
        spreadBps: spreadBps.toFixed(1),
        grossSol: profitAnalysis.grossProfitSol.toFixed(6),
        netUsd: profitAnalysis.netProfitUsd.toFixed(4),
        fees: profitAnalysis.totalFeeSol.toFixed(6),
      },
      `${profitAnalysis.grossProfitSol > 0 ? '🟢' : '🔴'} ${token.symbol}@${scanSol} ${bestBuy.source}→agg ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
    );

    if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
      // Verify buy quote is Jupiter-format
      if (!bestBuy.raw?.inAmount || !bestBuy.raw?.outAmount || !bestBuy.raw?.routePlan) {
        strategyLog.error(
          { token: token.symbol, buySource: bestBuy.source },
          'Best buy quote is not Jupiter-format — skipping',
        );
        return null;
      }

      const now = Date.now();
      return {
        id: crypto.randomUUID(),
        strategy: this.name,
        tokenPath: ['SOL', token.symbol, 'SOL'],
        mintPath: [SOL_MINT, token.mint, SOL_MINT],
        inputAmountLamports: scanAmountLamports,
        expectedOutputLamports: BigInt(sellQuote.outputAmount),
        expectedProfitSol: profitAnalysis.netProfitSol,
        expectedProfitUsd: profitAnalysis.netProfitUsd,
        confidence: this.estimateConfidence(profitAnalysis),
        // Leg 1: DEX-specific buy. Leg 2: executor gets fresh aggregator sell.
        quotes: [bestBuy.raw, sellQuote.raw],
        metadata: {
          token: token.symbol,
          scanAmountSol: scanSol,
          buySource: bestBuy.source,
          sellSource: 'aggregator',
          buyAmount: bestBuy.outputAmount,
          sellAmount: sellQuote.outputAmount,
          spreadBps,
          feeBreakdown: profitAnalysis.feeBreakdown,
        },
        timestamp: now,
        expiresAt: now + QUOTE_LIFETIME_MS,
      };
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER QUOTES
  // ────────────────────────────────────────────────────────────────────────────

  /** Aggregator quote — no dexes restriction, Jupiter finds best route */
  private async getJupiterQuote(
    inputMint: string, outputMint: string, amount: string, slippageBps: number,
  ): Promise<DexQuote | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());

    try {
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });

      if (!response.ok) {
        if (response.status === 429) {
          strategyLog.warn('Jupiter 429 — 5s backoff');
          await new Promise(r => setTimeout(r, 5000));
        }
        return null;
      }

      const data = await response.json();
      if (!data.outAmount) return null;

      return {
        source: 'aggregator', inputMint, outputMint, inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: parseFloat(data.outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch {
      return null;
    }
  }

  /** DEX-specific quote — forces routing through specific DEX */
  private async getJupiterDexQuote(
    inputMint: string, outputMint: string, amount: string,
    slippageBps: number, dexes: string,
  ): Promise<DexQuote | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('dexes', dexes);

    try {
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });

      if (!response.ok) {
        if (response.status === 429) {
          strategyLog.warn({ dexes }, 'Jupiter 429 — 5s backoff');
          await new Promise(r => setTimeout(r, 5000));
        }
        return null;
      }

      const data = await response.json();
      if (!data.outAmount) return null;

      return {
        source: dexes, inputMint, outputMint, inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: parseFloat(data.outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch {
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RAYDIUM DIRECT API — free, 300/min, separate quota
  // Used for price discovery only — not for execution
  // ────────────────────────────────────────────────────────────────────────────

  private async getRaydiumSwapQuote(
    inputMint: string, outputMint: string, amount: string,
  ): Promise<DexQuote | null> {
    for (const baseUrl of [
      'https://transaction-v1.raydium.io',
      'https://api-v3.raydium.io',
    ]) {
      try {
        const url = `${baseUrl}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&txVersion=V0`;
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });

        if (!response.ok) continue;

        const data = await response.json();
        const outAmount = data.data?.outputAmount || data.data?.outAmount;
        if (!outAmount) continue;

        return {
          source: 'raydium-direct',
          inputMint, outputMint, inputAmount: amount,
          outputAmount: String(outAmount),
          pricePerToken: parseFloat(String(outAmount)) / parseFloat(amount),
          raw: data,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROFIT CALCULATION
  // ────────────────────────────────────────────────────────────────────────────

  private calculateProfit(
    inputLamports: bigint, outputLamports: bigint,
  ): {
    grossProfitSol: number; netProfitSol: number; netProfitUsd: number;
    totalFeeSol: number; feeBreakdown: Record<string, number>;
  } {
    const inputSol = Number(inputLamports) / LAMPORTS_PER_SOL;
    const outputSol = Number(outputLamports) / LAMPORTS_PER_SOL;
    const grossProfitSol = outputSol - inputSol;

    const gasFee = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const jitoTip = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL;
    const safetyBuffer = inputSol * (EXECUTION_SAFETY_BUFFER_BPS / 10_000);

    const totalFeeSol = gasFee + priorityFee + jitoTip + safetyBuffer;
    const netProfitSol = grossProfitSol - totalFeeSol;

    const solPriceUsd = this.botConfig.solPriceUsd;
    if (!solPriceUsd || solPriceUsd <= 0) {
      return {
        grossProfitSol, netProfitSol: -1, netProfitUsd: -1, totalFeeSol,
        feeBreakdown: { gasFee, priorityFee, jitoTip, safetyBuffer },
      };
    }

    return {
      grossProfitSol,
      netProfitSol,
      netProfitUsd: netProfitSol * solPriceUsd,
      totalFeeSol,
      feeBreakdown: { gasFee, priorityFee, jitoTip, safetyBuffer },
    };
  }

  private estimateConfidence(p: { netProfitSol: number; totalFeeSol: number }): number {
    if (p.netProfitSol <= 0) return 0;
    return parseFloat(Math.min(0.90, Math.max(0.05, p.netProfitSol / p.totalFeeSol / 3)).toFixed(4));
  }

  // Enforce 1.5s minimum between Jupiter calls to avoid 429s
  private async jupiterRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastJupiterCallMs;
    const minDelay = Math.max(1500, Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond));
    if (elapsed < minDelay) {
      await new Promise(r => setTimeout(r, minDelay - elapsed));
    }
    this.lastJupiterCallMs = Date.now();
  }
}
