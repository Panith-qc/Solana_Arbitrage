// CROSS-DEX ARBITRAGE STRATEGY
// Finds price differences BETWEEN specific DEXes (Raydium vs Orca vs Meteora).
// Uses Jupiter's `dexes` parameter to force routing through a single DEX per leg,
// then compares: buy on cheapest DEX, sell on most expensive DEX.
// This is the ONLY way to find real cross-pool arbitrage — generic Jupiter
// round-trips always lose because Jupiter already aggregates internally.

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

// DEXes to compare — these are Jupiter's dex identifiers
const DEX_SOURCES = ['Raydium', 'Raydium CLMM', 'Orca', 'Whirlpool', 'Meteora', 'Meteora DLMM'];

// Pair DEX sources into groups for comparison (buy on one group, sell on another)
const DEX_GROUPS = [
  { name: 'raydium', dexes: 'Raydium,Raydium CLMM' },
  { name: 'orca', dexes: 'Orca,Whirlpool' },
  { name: 'meteora', dexes: 'Meteora,Meteora DLMM' },
];

// ── Fee Constants ──────────────────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 50_000;
const JITO_TIP_LAMPORTS = 50_000;
const QUOTE_LIFETIME_MS = 10_000;
const EXECUTION_SAFETY_BUFFER_BPS = 5;

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
  // SCAN — Query each DEX individually via Jupiter's dexes parameter
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];
    const scanAmountLamports = BigInt(
      Math.round(this.botConfig.scanAmountSol * LAMPORTS_PER_SOL),
    );
    const scanAmountStr = scanAmountLamports.toString();

    strategyLog.info(
      { tokens: CROSSDEX_TOKENS.length, dexGroups: DEX_GROUPS.length, scanAmountSol: this.botConfig.scanAmountSol },
      'Cross-DEX scan starting (dex-specific routing)',
    );

    for (const token of CROSSDEX_TOKENS) {
      try {
        // Get BUY quotes (SOL→Token) from each DEX group
        const buyQuotes: DexQuote[] = [];
        for (const dexGroup of DEX_GROUPS) {
          await this.rateLimit();
          const quote = await this.getDexSpecificQuote(
            SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps, dexGroup.dexes,
          );
          if (quote) {
            buyQuotes.push({ ...quote, source: dexGroup.name });
          }
        }

        if (buyQuotes.length < 2) {
          strategyLog.debug({ token: token.symbol, gotQuotes: buyQuotes.length }, 'Not enough DEX quotes for comparison');
          continue;
        }

        // Sort: best buy = most tokens for our SOL (highest outputAmount)
        buyQuotes.sort((a, b) => parseFloat(b.outputAmount) - parseFloat(a.outputAmount));
        const bestBuy = buyQuotes[0];

        // Get SELL quotes (Token→SOL) from each DEX group using bestBuy output
        const sellQuotes: DexQuote[] = [];
        for (const dexGroup of DEX_GROUPS) {
          // Skip the same DEX we're buying on — that's not cross-DEX
          if (dexGroup.name === bestBuy.source) continue;

          await this.rateLimit();
          const quote = await this.getDexSpecificQuote(
            token.mint, SOL_MINT, bestBuy.outputAmount, this.config.slippageBps, dexGroup.dexes,
          );
          if (quote) {
            sellQuotes.push({ ...quote, source: dexGroup.name });
          }
        }

        if (sellQuotes.length === 0) continue;

        // Sort: best sell = most SOL back (highest outputAmount)
        sellQuotes.sort((a, b) => parseFloat(b.outputAmount) - parseFloat(a.outputAmount));
        const bestSell = sellQuotes[0];

        // Calculate profit for best combination
        const profitAnalysis = this.calculateProfit(
          scanAmountLamports,
          BigInt(bestSell.outputAmount),
        );

        const spreadBps = (Number(BigInt(bestSell.outputAmount)) - Number(scanAmountLamports))
          / Number(scanAmountLamports) * 10_000;

        // Always log to dashboard
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
      'Cross-DEX scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DEX-SPECIFIC JUPITER QUOTE
  // Uses the `dexes` parameter to force routing through specific DEXes only
  // ────────────────────────────────────────────────────────────────────────────

  private async getDexSpecificQuote(
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
    url.searchParams.set('onlyDirectRoutes', 'true'); // Single pool only — no aggregation

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        if (response.status !== 400) { // 400 = no route, expected for some token/dex combos
          strategyLog.debug({ status: response.status, dexes }, 'DEX-specific quote failed');
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
      strategyLog.debug({ err, dexes }, 'DEX-specific quote fetch error');
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

  private async rateLimit(): Promise<void> {
    const delayMs = Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
