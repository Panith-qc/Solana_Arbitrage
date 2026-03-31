// CROSS-DEX ARBITRAGE STRATEGY (MULTI-SOURCE)
// Compares prices across 3 DEX ecosystems using Jupiter dexes param + Raydium swap API.
// Key: Raydium swap-base-in endpoint (free, 300 req/min) gives accurate swap quotes.
// Jupiter dexes param used for Orca/Meteora. All quotes are REAL swap quotes, not pool info.

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
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// Expanded token list: DeFi + memes + LSTs (liquid staking tokens have consistent cross-DEX spreads)
const CROSSDEX_SYMBOLS = new Set([
  'JUP', 'RAY', 'BONK', 'WIF', 'ORCA', 'W', 'PYTH', 'RENDER',
  'mSOL', 'jitoSOL', 'bSOL',  // LSTs — known for cross-DEX price differences
]);
const CROSSDEX_TOKENS = SCAN_TOKENS.filter(t => CROSSDEX_SYMBOLS.has(t.symbol));

// ── Fee Constants (realistic for Jito bundle execution) ──────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 10_000;   // Reduced: Jito handles priority
const JITO_TIP_LAMPORTS = 25_000;       // Minimum viable Jito tip (~$0.004)
const QUOTE_LIFETIME_MS = 10_000;
const EXECUTION_SAFETY_BUFFER_BPS = 3;  // 3 bps safety, was 5

// All 3 DEX groups — use Jupiter for all, Raydium swap API as bonus source
const DEX_GROUPS = [
  { name: 'raydium', dexes: 'Raydium,Raydium CLMM' },
  { name: 'orca', dexes: 'Orca,Whirlpool' },
  { name: 'meteora', dexes: 'Meteora,Meteora DLMM' },
];

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
      minProfitUsd: riskProfile.minProfitUsd,
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
  // SCAN — Get accurate swap quotes from each DEX and compare
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];
    // Use 10 SOL for scanning — matches user's actual capital
    const scanSol = Math.max(10.0, this.botConfig.scanAmountSol);
    const scanAmountLamports = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL));
    const scanAmountStr = scanAmountLamports.toString();

    strategyLog.info(
      { tokens: CROSSDEX_TOKENS.length, dexGroups: DEX_GROUPS.length, scanAmountSol: scanSol },
      'Cross-DEX scan starting',
    );

    for (const token of CROSSDEX_TOKENS) {
      try {
        // ── Get BUY quotes (SOL→Token) from all sources ──

        // Try Raydium swap API first (free, separate from Jupiter quota)
        const raydiumBuyQuote = await this.getRaydiumSwapQuote(
          SOL_MINT, token.mint, scanAmountStr,
        );

        // Get Jupiter quotes for all 3 DEX groups
        const jupiterBuyQuotes: DexQuote[] = [];
        for (const dexGroup of DEX_GROUPS) {
          // Skip Raydium via Jupiter if we already got it from Raydium API
          if (dexGroup.name === 'raydium' && raydiumBuyQuote) continue;

          await this.jupiterRateLimit();
          const quote = await this.getJupiterDexQuote(
            SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps, dexGroup.dexes,
          );
          if (quote) {
            jupiterBuyQuotes.push({ ...quote, source: dexGroup.name });
          }
        }

        // Combine all buy quotes
        const buyQuotes: DexQuote[] = [...jupiterBuyQuotes];
        if (raydiumBuyQuote) {
          buyQuotes.push(raydiumBuyQuote);
        }

        if (buyQuotes.length < 2) {
          this.onScanResult?.({
            strategy: this.name,
            token: `${token.symbol} (${buyQuotes.length} DEXes)`,
            spreadBps: 0,
            grossProfitSol: 0,
            netProfitUsd: 0,
            fees: 0,
            profitable: false,
          });
          continue;
        }

        // Sort: best buy = most tokens for our SOL
        buyQuotes.sort((a, b) => parseFloat(b.outputAmount) - parseFloat(a.outputAmount));
        const bestBuy = buyQuotes[0];
        const worstBuy = buyQuotes[buyQuotes.length - 1];

        const buySideDiffPct = (parseFloat(bestBuy.outputAmount) - parseFloat(worstBuy.outputAmount))
          / parseFloat(worstBuy.outputAmount) * 100;

        strategyLog.info(
          {
            token: token.symbol,
            best: `${bestBuy.source}=${bestBuy.outputAmount}`,
            worst: `${worstBuy.source}=${worstBuy.outputAmount}`,
            diffPct: buySideDiffPct.toFixed(3),
            sources: buyQuotes.map(q => q.source).join(','),
          },
          `Buy spread: ${token.symbol} ${buySideDiffPct.toFixed(3)}% across ${buyQuotes.length} DEXes`,
        );

        // ── Get SELL quotes (Token→SOL) from other DEXes ──
        const sellQuotes: DexQuote[] = [];

        // Try Raydium sell if best buy is NOT raydium
        if (bestBuy.source !== 'raydium') {
          const raydiumSell = await this.getRaydiumSwapQuote(
            token.mint, SOL_MINT, bestBuy.outputAmount,
          );
          if (raydiumSell) sellQuotes.push(raydiumSell);
        }

        // Jupiter sell from non-best-buy DEXes
        for (const dexGroup of DEX_GROUPS) {
          if (dexGroup.name === bestBuy.source) continue;
          // Skip Raydium via Jupiter if we already got it from Raydium API
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
            token: `${token.symbol} (no sell route)`,
            spreadBps: 0,
            grossProfitSol: 0,
            netProfitUsd: 0,
            fees: 0,
            profitable: false,
          });
          continue;
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
          token: `${token.symbol} (${bestBuy.source}→${bestSell.source})`,
          spreadBps,
          grossProfitSol: profitAnalysis.grossProfitSol,
          netProfitUsd: profitAnalysis.netProfitUsd,
          fees: profitAnalysis.totalFeeSol,
          profitable: profitAnalysis.netProfitUsd >= this.config.minProfitUsd,
        });

        strategyLog.info(
          {
            token: token.symbol,
            buy: bestBuy.source,
            sell: bestSell.source,
            spreadBps: spreadBps.toFixed(1),
            grossProfitSol: profitAnalysis.grossProfitSol.toFixed(6),
            netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
            fees: profitAnalysis.totalFeeSol.toFixed(6),
          },
          `CrossDEX: ${token.symbol} buy@${bestBuy.source} sell@${bestSell.source} ${spreadBps.toFixed(1)}bps | gross ${profitAnalysis.grossProfitSol.toFixed(6)} SOL | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
        );

        if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
          const now = Date.now();
          const opportunity: Opportunity = {
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

          opportunities.push(opportunity);
          this.opportunitiesFound++;

          strategyLog.warn(
            {
              token: token.symbol,
              buyOn: bestBuy.source,
              sellOn: bestSell.source,
              netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
              spreadBps: spreadBps.toFixed(1),
            },
            '*** PROFITABLE Cross-DEX opportunity found! ***',
          );
        }
      } catch (err) {
        strategyLog.error({ err, token: token.symbol }, 'Error scanning cross-DEX for token');
      }
    }

    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.info(
      { found: opportunities.length, scanCount: this.scanCount },
      'Cross-DEX scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RAYDIUM SWAP API (compute/swap-base-in) — accurate swap quotes, 300 req/min
  // ────────────────────────────────────────────────────────────────────────────

  private async getRaydiumSwapQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
  ): Promise<DexQuote | null> {
    try {
      const url = `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&txVersion=V0`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        // Try alternative endpoint
        return this.getRaydiumSwapQuoteV3(inputMint, outputMint, amount);
      }

      const data = await response.json();
      if (!data.data?.outputAmount) {
        return this.getRaydiumSwapQuoteV3(inputMint, outputMint, amount);
      }

      const outAmount = String(data.data.outputAmount);

      return {
        source: 'raydium',
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: outAmount,
        pricePerToken: parseFloat(outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch (err) {
      strategyLog.debug({ err }, 'Raydium swap quote failed, trying v3');
      return this.getRaydiumSwapQuoteV3(inputMint, outputMint, amount);
    }
  }

  // Fallback: Raydium V3 API compute endpoint
  private async getRaydiumSwapQuoteV3(
    inputMint: string,
    outputMint: string,
    amount: string,
  ): Promise<DexQuote | null> {
    try {
      const url = `https://api-v3.raydium.io/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&txVersion=V0`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const outAmount = data.data?.outputAmount || data.data?.outAmount;
      if (!outAmount) return null;

      return {
        source: 'raydium',
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: String(outAmount),
        pricePerToken: parseFloat(String(outAmount)) / parseFloat(amount),
        raw: data,
      };
    } catch (err) {
      strategyLog.debug({ err }, 'Raydium V3 swap quote also failed');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER DEX-SPECIFIC QUOTE
  // ────────────────────────────────────────────────────────────────────────────

  private async getJupiterDexQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    dexes: string,
  ): Promise<DexQuote | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('dexes', dexes);

    try {
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        if (response.status === 429) {
          strategyLog.warn({ dexes }, 'Jupiter 429 — extra backoff');
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        return null;
      }

      const data = await response.json();
      if (!data.outAmount) return null;

      return {
        source: dexes,
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: parseFloat(data.outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch (err) {
      strategyLog.debug({ err, dexes }, 'Jupiter DEX quote error');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROFIT CALCULATION (optimized fees for Jito bundle execution)
  // ────────────────────────────────────────────────────────────────────────────

  private calculateProfit(
    inputLamports: bigint,
    outputLamports: bigint,
  ): {
    grossProfitSol: number;
    netProfitSol: number;
    netProfitUsd: number;
    totalFeeSol: number;
    feeBreakdown: Record<string, number>;
  } {
    const inputSol = Number(inputLamports) / LAMPORTS_PER_SOL;
    const outputSol = Number(outputLamports) / LAMPORTS_PER_SOL;
    const grossProfitSol = outputSol - inputSol;

    const gasFee = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;   // ~0.00001 SOL
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL; // ~0.00001 SOL
    const jitoTip = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL;         // ~0.000025 SOL
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
    const netProfitUsd = netProfitSol * solPriceUsd;

    return {
      grossProfitSol, netProfitSol, netProfitUsd, totalFeeSol,
      feeBreakdown: { gasFee, priorityFee, jitoTip, safetyBuffer },
    };
  }

  private estimateConfidence(profitAnalysis: {
    netProfitSol: number;
    totalFeeSol: number;
  }): number {
    if (profitAnalysis.netProfitSol <= 0) return 0;
    const marginRatio = profitAnalysis.netProfitSol / profitAnalysis.totalFeeSol;
    const confidence = Math.min(0.90, Math.max(0.05, marginRatio / 3));
    return parseFloat(confidence.toFixed(4));
  }

  // Jupiter rate limit: 1 RPS with tracking
  private async jupiterRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastJupiterCallMs;
    const minDelay = Math.max(1100, Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond));
    if (elapsed < minDelay) {
      await new Promise(resolve => setTimeout(resolve, minDelay - elapsed));
    }
    this.lastJupiterCallMs = Date.now();
  }
}
