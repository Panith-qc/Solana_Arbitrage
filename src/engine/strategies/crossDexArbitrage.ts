// MAXIMUM COVERAGE CROSS-DEX ARBITRAGE
// Every DEX. Every token. Every angle. Minimum overhead.
//
// Architecture:
// 1. Raydium swap-base-in API (300 req/min, free) for Raydium quotes
// 2. Jupiter dexes param for Orca, Meteora, Lifinity, Phoenix, OpenBook
// 3. ALL tokens scanned, not just a subset
// 4. Multiple scan amounts (5 SOL, 10 SOL) to find AMM curve sweet spots
// 5. Absolute minimum fee overhead — on-chain fees are 0.000045 SOL total

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
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// ALL tokens — don't filter, scan everything
const ALL_TOKENS = SCAN_TOKENS.filter(t => t.mint !== SOL_MINT && t.mint !== USDC_MINT);

// ── Real on-chain fees (verified from Solana docs) ──────────────────────────
const BASE_GAS_LAMPORTS = 5_000;        // 5000 lamports per signature (fixed by protocol)
const PRIORITY_FEE_LAMPORTS = 5_000;    // Minimal priority — Jito handles inclusion
const JITO_TIP_LAMPORTS = 10_000;       // 10k lamports minimum viable Jito tip
const QUOTE_LIFETIME_MS = 10_000;
const EXECUTION_SAFETY_BUFFER_BPS = 1;  // 1 bps — quotes are near-instant execution

// 6 DEX groups — maximum coverage
const DEX_GROUPS = [
  { name: 'raydium', dexes: 'Raydium,Raydium CLMM' },
  { name: 'orca', dexes: 'Orca,Whirlpool' },
  { name: 'meteora', dexes: 'Meteora,Meteora DLMM' },
  { name: 'lifinity', dexes: 'Lifinity,Lifinity V2' },
  { name: 'phoenix', dexes: 'Phoenix' },
  { name: 'openbook', dexes: 'OpenBook' },
];

// Scan amounts — different amounts reveal different AMM curve spreads
const SCAN_AMOUNTS_SOL = [5, 10];

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
      minProfitUsd: 0.001, // Any profit counts — we're here to prove it works
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

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN — Maximum coverage: all tokens × all DEXes × multiple amounts
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];

    strategyLog.info(
      { tokens: ALL_TOKENS.length, dexGroups: DEX_GROUPS.length, amounts: SCAN_AMOUNTS_SOL },
      'Cross-DEX FULL scan starting — all tokens, all DEXes',
    );

    for (const token of ALL_TOKENS) {
      for (const scanSol of SCAN_AMOUNTS_SOL) {
        try {
          const result = await this.scanTokenAtAmount(token, scanSol);
          if (result) {
            opportunities.push(result);
          }
        } catch (err) {
          strategyLog.debug({ err, token: token.symbol, sol: scanSol }, 'Token scan error');
        }
      }
    }

    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.info(
      { found: opportunities.length, scanCount: this.scanCount, tokensScanned: ALL_TOKENS.length },
      `Cross-DEX scan complete — ${opportunities.length} profitable`,
    );

    return opportunities;
  }

  private async scanTokenAtAmount(token: TokenInfo, scanSol: number): Promise<Opportunity | null> {
    const scanAmountLamports = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL));
    const scanAmountStr = scanAmountLamports.toString();

    // ── Collect BUY quotes from all available DEXes ──
    const buyQuotes: DexQuote[] = [];

    // Source 1: Raydium direct API (free, 300/min, separate quota)
    const raydiumBuy = await this.getRaydiumSwapQuote(SOL_MINT, token.mint, scanAmountStr);
    if (raydiumBuy) buyQuotes.push(raydiumBuy);

    // Source 2: Jupiter with DEX filter for each non-Raydium group
    for (const dexGroup of DEX_GROUPS) {
      if (dexGroup.name === 'raydium' && raydiumBuy) continue; // Already have it
      await this.jupiterRateLimit();
      const quote = await this.getJupiterDexQuote(
        SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps, dexGroup.dexes,
      );
      if (quote) {
        buyQuotes.push({ ...quote, source: dexGroup.name });
      }
    }

    if (buyQuotes.length < 2) {
      // Still emit for dashboard
      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (${buyQuotes.length} DEX)`,
        spreadBps: 0, grossProfitSol: 0, netProfitUsd: 0, fees: 0, profitable: false,
      });
      return null;
    }

    // Sort: best buy = most tokens for our SOL
    buyQuotes.sort((a, b) => parseFloat(b.outputAmount) - parseFloat(a.outputAmount));
    const bestBuy = buyQuotes[0];
    const worstBuy = buyQuotes[buyQuotes.length - 1];

    const buySideDiffBps = (parseFloat(bestBuy.outputAmount) - parseFloat(worstBuy.outputAmount))
      / parseFloat(worstBuy.outputAmount) * 10_000;

    // Quick filter: if buy-side spread is < 2 bps, round-trip can't profit
    if (buySideDiffBps < 2) {
      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (${buySideDiffBps.toFixed(1)}bps)`,
        spreadBps: buySideDiffBps,
        grossProfitSol: 0, netProfitUsd: 0, fees: 0, profitable: false,
      });
      return null;
    }

    strategyLog.info(
      {
        token: token.symbol, sol: scanSol,
        best: `${bestBuy.source}=${bestBuy.outputAmount}`,
        worst: `${worstBuy.source}=${worstBuy.outputAmount}`,
        spreadBps: buySideDiffBps.toFixed(1),
        sources: buyQuotes.map(q => q.source).join(','),
      },
      `BUY SPREAD: ${token.symbol}@${scanSol}SOL ${buySideDiffBps.toFixed(1)}bps across ${buyQuotes.length} DEXes`,
    );

    // ── Collect SELL quotes from DEXes other than best buy ──
    const sellQuotes: DexQuote[] = [];

    // Raydium sell (if best buy wasn't raydium)
    if (bestBuy.source !== 'raydium') {
      const raydiumSell = await this.getRaydiumSwapQuote(token.mint, SOL_MINT, bestBuy.outputAmount);
      if (raydiumSell) sellQuotes.push(raydiumSell);
    }

    // Jupiter sell from each non-best-buy DEX
    for (const dexGroup of DEX_GROUPS) {
      if (dexGroup.name === bestBuy.source) continue;
      if (dexGroup.name === 'raydium' && sellQuotes.some(q => q.source === 'raydium')) continue;
      await this.jupiterRateLimit();
      const quote = await this.getJupiterDexQuote(
        token.mint, SOL_MINT, bestBuy.outputAmount, this.config.slippageBps, dexGroup.dexes,
      );
      if (quote) {
        sellQuotes.push({ ...quote, source: dexGroup.name });
      }
    }

    if (sellQuotes.length === 0) {
      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (no sell)`,
        spreadBps: buySideDiffBps, grossProfitSol: 0, netProfitUsd: 0, fees: 0, profitable: false,
      });
      return null;
    }

    // Best sell = most SOL back
    sellQuotes.sort((a, b) => parseFloat(b.outputAmount) - parseFloat(a.outputAmount));
    const bestSell = sellQuotes[0];

    const profitAnalysis = this.calculateProfit(scanAmountLamports, BigInt(bestSell.outputAmount));
    const spreadBps = (Number(BigInt(bestSell.outputAmount)) - Number(scanAmountLamports))
      / Number(scanAmountLamports) * 10_000;

    // Emit to dashboard
    this.onScanResult?.({
      strategy: this.name,
      token: `${token.symbol}@${scanSol} (${bestBuy.source}→${bestSell.source})`,
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
        buy: bestBuy.source, sell: bestSell.source,
        spreadBps: spreadBps.toFixed(1),
        grossSol: profitAnalysis.grossProfitSol.toFixed(6),
        netUsd: profitAnalysis.netProfitUsd.toFixed(4),
        fees: profitAnalysis.totalFeeSol.toFixed(6),
      },
      `${profitAnalysis.grossProfitSol > 0 ? '🟢' : '🔴'} ${token.symbol}@${scanSol} ${bestBuy.source}→${bestSell.source} ${spreadBps.toFixed(1)}bps | gross ${profitAnalysis.grossProfitSol.toFixed(6)} SOL | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
    );

    if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
      const now = Date.now();
      return {
        id: crypto.randomUUID(),
        strategy: this.name,
        tokenPath: ['SOL', token.symbol, 'SOL'],
        mintPath: [SOL_MINT, token.mint, SOL_MINT],
        inputAmountLamports: scanAmountLamports,
        expectedOutputLamports: BigInt(bestSell.outputAmount),
        expectedProfitSol: profitAnalysis.netProfitSol,
        expectedProfitUsd: profitAnalysis.netProfitUsd,
        confidence: this.estimateConfidence(profitAnalysis),
        quotes: [bestBuy.raw, bestSell.raw],
        metadata: {
          token: token.symbol,
          scanAmountSol: scanSol,
          buySource: bestBuy.source,
          sellSource: bestSell.source,
          buyAmount: bestBuy.outputAmount,
          sellAmount: bestSell.outputAmount,
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
  // RAYDIUM SWAP API — accurate quotes, 300 req/min, separate from Jupiter
  // ────────────────────────────────────────────────────────────────────────────

  private async getRaydiumSwapQuote(
    inputMint: string, outputMint: string, amount: string,
  ): Promise<DexQuote | null> {
    // Try transaction-v1 first (newer, often faster)
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
          source: 'raydium',
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
  // JUPITER DEX-SPECIFIC QUOTE
  // ────────────────────────────────────────────────────────────────────────────

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
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(4000) });

      if (!response.ok) {
        if (response.status === 429) {
          strategyLog.warn({ dexes }, 'Jupiter 429 — 3s backoff');
          await new Promise(r => setTimeout(r, 3000));
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
  // PROFIT CALCULATION — absolute minimum overhead
  // On-chain reality: 2 signatures (10k lamports) + Jito tip (10k) = 0.00002 SOL
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

    // Real on-chain costs (verified from Solana fee structure):
    const gasFee = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;     // 0.00001 SOL (2 signatures)
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;  // 0.000005 SOL
    const jitoTip = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL;          // 0.00001 SOL
    // Safety buffer: 1 bps accounts for quote-to-execution price drift
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

  // Jupiter: 1 RPS with precise tracking
  private async jupiterRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastJupiterCallMs;
    const minDelay = Math.max(1100, Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond));
    if (elapsed < minDelay) {
      await new Promise(r => setTimeout(r, minDelay - elapsed));
    }
    this.lastJupiterCallMs = Date.now();
  }
}
