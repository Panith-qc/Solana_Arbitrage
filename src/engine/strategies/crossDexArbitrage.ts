// CROSS-DEX ARBITRAGE STRATEGY (MULTI-SOURCE)
// Uses MULTIPLE free APIs to detect price differences between DEXes:
// 1. Raydium V3 API (300 req/min, free) — direct pool prices
// 2. Jupiter dexes param (1 RPS) — Orca/Meteora specific routing
// 3. Jupiter Price API v2 — batch token prices for quick screening
//
// The key insight: instead of burning 1 RPS on Jupiter for ALL detection,
// use Raydium's own API (much higher limits) for Raydium prices, and
// only use Jupiter for Orca/Meteora quotes. This 5x our effective scan rate.

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

// Tokens with deep liquidity across multiple DEXes
const CROSSDEX_SYMBOLS = new Set(['JUP', 'RAY', 'BONK', 'WIF', 'ORCA', 'W', 'PYTH', 'RENDER']);
const CROSSDEX_TOKENS = SCAN_TOKENS.filter(t => CROSSDEX_SYMBOLS.has(t.symbol));

// ── Fee Constants ──────────────────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 50_000;
const JITO_TIP_LAMPORTS = 50_000;
const QUOTE_LIFETIME_MS = 10_000;
const EXECUTION_SAFETY_BUFFER_BPS = 5;

// DEX groups for Jupiter-specific routing (Orca + Meteora)
const JUPITER_DEX_GROUPS = [
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
    return 'Cross-DEX Arbitrage (Multi-Source)';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN — Multi-source price comparison
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];
    const scanSol = Math.max(5.0, this.botConfig.scanAmountSol);
    const scanAmountLamports = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL));
    const scanAmountStr = scanAmountLamports.toString();

    strategyLog.info(
      { tokens: CROSSDEX_TOKENS.length, scanAmountSol: scanSol },
      'Cross-DEX multi-source scan starting',
    );

    for (const token of CROSSDEX_TOKENS) {
      try {
        const buyQuotes: DexQuote[] = [];

        // ── Source 1: Raydium V3 API (300 req/min, no Jupiter quota) ──
        const raydiumQuote = await this.getRaydiumDirectQuote(
          SOL_MINT, token.mint, scanAmountStr, token,
        );
        if (raydiumQuote) {
          buyQuotes.push(raydiumQuote);
        }

        // ── Source 2: Jupiter with DEX filter (Orca, Meteora) ──
        for (const dexGroup of JUPITER_DEX_GROUPS) {
          await this.jupiterRateLimit();
          const quote = await this.getJupiterDexQuote(
            SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps, dexGroup.dexes,
          );
          if (quote) {
            buyQuotes.push({ ...quote, source: dexGroup.name });
          }
        }

        if (buyQuotes.length < 2) {
          this.onScanResult?.({
            strategy: this.name,
            token: `${token.symbol} (${buyQuotes.length} sources)`,
            spreadBps: 0,
            grossProfitSol: 0,
            netProfitUsd: 0,
            fees: 0,
            profitable: false,
          });
          strategyLog.debug({ token: token.symbol, sources: buyQuotes.length }, 'Not enough sources');
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

        // Get SELL quotes from DEXes other than the best buy source
        const sellQuotes: DexQuote[] = [];

        // If best buy is Raydium, get sell from Orca/Meteora via Jupiter
        // If best buy is Orca/Meteora, get sell from Raydium direct
        if (bestBuy.source === 'raydium') {
          for (const dexGroup of JUPITER_DEX_GROUPS) {
            await this.jupiterRateLimit();
            const quote = await this.getJupiterDexQuote(
              token.mint, SOL_MINT, bestBuy.outputAmount, this.config.slippageBps, dexGroup.dexes,
            );
            if (quote) {
              sellQuotes.push({ ...quote, source: dexGroup.name });
            }
          }
        } else {
          // Best buy is Orca or Meteora — get Raydium sell price
          const raydiumSell = await this.getRaydiumDirectQuote(
            token.mint, SOL_MINT, bestBuy.outputAmount, token,
          );
          if (raydiumSell) {
            sellQuotes.push(raydiumSell);
          }

          // Also check the other Jupiter DEX group
          for (const dexGroup of JUPITER_DEX_GROUPS) {
            if (dexGroup.name === bestBuy.source) continue;
            await this.jupiterRateLimit();
            const quote = await this.getJupiterDexQuote(
              token.mint, SOL_MINT, bestBuy.outputAmount, this.config.slippageBps, dexGroup.dexes,
            );
            if (quote) {
              sellQuotes.push({ ...quote, source: dexGroup.name });
            }
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

        // Calculate profit
        const profitAnalysis = this.calculateProfit(
          scanAmountLamports,
          BigInt(bestSell.outputAmount),
        );

        const spreadBps = (Number(BigInt(bestSell.outputAmount)) - Number(scanAmountLamports))
          / Number(scanAmountLamports) * 10_000;

        // Always emit to dashboard
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
            netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
          },
          `CrossDEX: ${token.symbol} buy@${bestBuy.source} sell@${bestSell.source} ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
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
      'Cross-DEX multi-source scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RAYDIUM V3 DIRECT API (300 req/min — separate from Jupiter quota)
  // ────────────────────────────────────────────────────────────────────────────

  private async getRaydiumDirectQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    token: TokenInfo,
  ): Promise<DexQuote | null> {
    try {
      // Raydium swap quote endpoint
      const url = `https://api-v3.raydium.io/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&txVersion=V0`;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        // Fallback: try pool info endpoint for price estimation
        return this.getRaydiumPoolPrice(inputMint, outputMint, amount, token);
      }

      const data = await response.json();
      if (!data.data?.outputAmount && !data.data?.outAmount) {
        return this.getRaydiumPoolPrice(inputMint, outputMint, amount, token);
      }

      const outAmount = String(data.data.outputAmount || data.data.outAmount);

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
      strategyLog.debug({ err, token: token.symbol }, 'Raydium direct quote failed, trying pool price');
      return this.getRaydiumPoolPrice(inputMint, outputMint, amount, token);
    }
  }

  // Fallback: use Raydium pool info API to estimate price
  private async getRaydiumPoolPrice(
    inputMint: string,
    outputMint: string,
    amount: string,
    token: TokenInfo,
  ): Promise<DexQuote | null> {
    try {
      const poolsUrl = `https://api-v3.raydium.io/pools/info/mint?mint1=${inputMint}&mint2=${outputMint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=1&page=1`;

      const response = await fetch(poolsUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return null;

      const poolsData = await response.json();
      const pools = poolsData?.data?.data;
      if (!pools || pools.length === 0) return null;

      const pool = pools[0];
      const price = parseFloat(pool.price || '0');
      if (price === 0 || isNaN(price)) return null;

      // Calculate output using pool price
      const isMintAInput = pool.mintA?.address === inputMint;
      const inputDecimals = isMintAInput ? (pool.mintA?.decimals ?? 9) : (pool.mintB?.decimals ?? 9);
      const outputDecimals = isMintAInput ? (pool.mintB?.decimals ?? 9) : (pool.mintA?.decimals ?? 9);

      const amountInFloat = parseFloat(amount) / Math.pow(10, inputDecimals);
      const amountOutFloat = isMintAInput ? amountInFloat * price : amountInFloat / price;

      // Apply 0.25% fee estimate for Raydium AMM
      const outputAfterFee = amountOutFloat * 0.9975;
      const outputAmount = Math.floor(outputAfterFee * Math.pow(10, outputDecimals));

      return {
        source: 'raydium',
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: String(outputAmount),
        pricePerToken: outputAmount / parseFloat(amount),
        raw: { poolId: pool.id, price, type: pool.type, source: 'raydium-pool-info' },
      };
    } catch (err) {
      strategyLog.debug({ err }, 'Raydium pool price fallback failed');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER DEX-SPECIFIC QUOTE (for Orca/Meteora)
  // Uses the `dexes` parameter to force routing through specific DEXes.
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
          strategyLog.warn({ dexes }, 'Jupiter 429 — backing off');
          // Extra backoff on 429
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        if (response.status !== 400) {
          strategyLog.debug({ status: response.status, dexes }, 'Jupiter DEX quote failed');
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
      strategyLog.debug({ err, dexes }, 'Jupiter DEX quote fetch error');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROFIT CALCULATION
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

  // Jupiter rate limit: 1 RPS with 1100ms spacing
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
