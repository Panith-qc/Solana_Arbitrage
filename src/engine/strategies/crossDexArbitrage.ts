// CROSS-DEX ARBITRAGE STRATEGY
// Same token, different DEX pricing.
// Compares prices across Jupiter (aggregated best route) and Raydium direct,
// then captures the spread when buy on one < sell on the other, after fees.

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

// ── Fee Constants ──────────────────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 200_000;
const DEX_SWAP_FEE_BPS = 30;
const QUOTE_LIFETIME_MS = 10_000;

// Jupiter URL loaded from config via this.botConfig.jupiterApiUrl
const RAYDIUM_QUOTE_URL = 'https://api-v3.raydium.io/compute/swap-base-in';

interface DexQuote {
  source: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  pricePerToken: number;  // output per unit of input
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
  // SCAN
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];
    const scanAmountLamports = BigInt(
      Math.round(this.botConfig.scanAmountSol * LAMPORTS_PER_SOL),
    );
    const scanAmountStr = scanAmountLamports.toString();

    strategyLog.debug(
      { tokens: SCAN_TOKENS.length, scanAmountSol: this.botConfig.scanAmountSol },
      'Cross-DEX scan starting',
    );

    for (const token of SCAN_TOKENS) {
      try {
        // ── Get BUY quotes (SOL -> Token) from both DEXes ─────────────────
        await this.rateLimit();
        const [jupBuy, rayBuy] = await Promise.all([
          this.getJupiterQuote(SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps),
          this.getRaydiumQuote(SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps),
        ]);

        // ── Get SELL quotes (Token -> SOL) from both DEXes ────────────────
        // We need the token amounts from the buy quotes to get accurate sell quotes.
        // Use the best buy (most tokens received) for the sell leg.
        const buyQuotes = [jupBuy, rayBuy].filter((q): q is DexQuote => q !== null);
        if (buyQuotes.length < 2) {
          // Need at least two sources to compare
          continue;
        }

        await this.rateLimit();
        const [jupSell, raySell] = await Promise.all([
          this.getJupiterQuote(token.mint, SOL_MINT, buyQuotes[0].outputAmount, this.config.slippageBps),
          this.getRaydiumQuote(token.mint, SOL_MINT, buyQuotes[0].outputAmount, this.config.slippageBps),
        ]);

        const sellQuotes = [jupSell, raySell].filter((q): q is DexQuote => q !== null);
        if (sellQuotes.length === 0) continue;

        // ── Find the best cross-DEX combination ──────────────────────────
        // Buy on cheapest source, sell on most expensive source
        const allBuys = buyQuotes;
        const allSells = sellQuotes;

        for (const buy of allBuys) {
          for (const sell of allSells) {
            // Skip same-source arb (Jupiter will already aggregate)
            if (buy.source === sell.source) continue;

            // Get the sell quote using the actual buy output amount
            let actualSellQuote = sell;
            if (buy.outputAmount !== sell.inputAmount) {
              // Re-fetch sell quote with exact buy output
              await this.rateLimit();
              const refetched = sell.source === 'jupiter'
                ? await this.getJupiterQuote(token.mint, SOL_MINT, buy.outputAmount, this.config.slippageBps)
                : await this.getRaydiumQuote(token.mint, SOL_MINT, buy.outputAmount, this.config.slippageBps);
              if (!refetched) continue;
              actualSellQuote = refetched;
            }

            const profitAnalysis = this.calculateProfit(
              scanAmountLamports,
              BigInt(actualSellQuote.outputAmount),
            );

            if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
              const now = Date.now();
              const opportunity: Opportunity = {
                id: crypto.randomUUID(),
                strategy: this.name,
                tokenPath: ['SOL', token.symbol, 'SOL'],
                mintPath: [SOL_MINT, token.mint, SOL_MINT],
                inputAmountLamports: scanAmountLamports,
                expectedOutputLamports: BigInt(actualSellQuote.outputAmount),
                expectedProfitSol: profitAnalysis.netProfitSol,
                expectedProfitUsd: profitAnalysis.netProfitUsd,
                confidence: this.estimateConfidence(profitAnalysis),
                quotes: [buy.raw, actualSellQuote.raw],
                metadata: {
                  token: token.symbol,
                  buySource: buy.source,
                  sellSource: actualSellQuote.source,
                  buyAmount: buy.outputAmount,
                  sellAmount: actualSellQuote.outputAmount,
                  spreadBps: this.calculateSpreadBps(buy, actualSellQuote),
                  feeBreakdown: profitAnalysis.feeBreakdown,
                },
                timestamp: now,
                expiresAt: now + QUOTE_LIFETIME_MS,
              };

              opportunities.push(opportunity);
              this.opportunitiesFound++;

              strategyLog.info(
                {
                  token: token.symbol,
                  buyOn: buy.source,
                  sellOn: actualSellQuote.source,
                  netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
                  spreadBps: opportunity.metadata.spreadBps,
                },
                'Cross-DEX arbitrage opportunity found',
              );
            }
          }
        }
      } catch (err) {
        strategyLog.error({ err, token: token.symbol }, 'Error scanning cross-DEX for token');
      }
    }

    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.debug(
      { found: opportunities.length, scanCount: this.scanCount },
      'Cross-DEX scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER QUOTE
  // ────────────────────────────────────────────────────────────────────────────

  private async getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<DexQuote | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());

    try {
      const response = await fetch(url.toString());
      if (!response.ok) return null;

      const data = await response.json();
      if (!data.outAmount) return null;

      const inputNum = parseFloat(amount);
      const outputNum = parseFloat(data.outAmount);

      return {
        source: 'jupiter',
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: inputNum > 0 ? outputNum / inputNum : 0,
        raw: data,
      };
    } catch (err) {
      strategyLog.error({ err }, 'Jupiter quote fetch error');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RAYDIUM QUOTE
  // ────────────────────────────────────────────────────────────────────────────

  private async getRaydiumQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<DexQuote | null> {
    const url = new URL(RAYDIUM_QUOTE_URL);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());

    try {
      const response = await fetch(url.toString());
      if (!response.ok) return null;

      const data = await response.json();

      // Raydium V3 API response structure
      const outAmount = data?.data?.outputAmount || data?.outputAmount;
      if (!outAmount) return null;

      const inputNum = parseFloat(amount);
      const outputNum = parseFloat(outAmount);

      return {
        source: 'raydium',
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: String(outAmount),
        pricePerToken: inputNum > 0 ? outputNum / inputNum : 0,
        raw: data,
      };
    } catch (err) {
      strategyLog.debug({ err }, 'Raydium quote fetch error (non-critical)');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SPREAD CALCULATION
  // ────────────────────────────────────────────────────────────────────────────

  private calculateSpreadBps(buy: DexQuote, sell: DexQuote): number {
    const buyPrice = parseFloat(buy.inputAmount) / parseFloat(buy.outputAmount);
    const sellPrice = parseFloat(sell.outputAmount) / parseFloat(sell.inputAmount);
    if (buyPrice <= 0) return 0;
    const spread = (sellPrice - buyPrice) / buyPrice;
    return Math.round(spread * 10_000);
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
    const dexFee = inputSol * (DEX_SWAP_FEE_BPS / 10_000) * 2;
    const slippageCost = inputSol * (this.config.slippageBps / 10_000) * 2;

    const totalFeeSol = gasFee + priorityFee + dexFee + slippageCost;
    const netProfitSol = grossProfitSol - totalFeeSol;
    const solPriceUsd = this.botConfig.solPriceUsd || 150;
    const netProfitUsd = netProfitSol * solPriceUsd;

    return {
      grossProfitSol,
      netProfitSol,
      netProfitUsd,
      totalFeeSol,
      feeBreakdown: { gasFee, priorityFee, dexFee, slippageCost },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CONFIDENCE
  // ────────────────────────────────────────────────────────────────────────────

  private estimateConfidence(profitAnalysis: {
    netProfitSol: number;
    totalFeeSol: number;
  }): number {
    if (profitAnalysis.netProfitSol <= 0) return 0;
    const marginRatio = profitAnalysis.netProfitSol / profitAnalysis.totalFeeSol;
    // Cross-DEX arbs are moderately reliable
    const confidence = Math.min(0.90, Math.max(0.05, marginRatio / 3));
    return parseFloat(confidence.toFixed(4));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RATE LIMITER
  // ────────────────────────────────────────────────────────────────────────────

  private async rateLimit(): Promise<void> {
    const delayMs = Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
