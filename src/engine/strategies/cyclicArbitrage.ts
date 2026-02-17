// CYCLIC ARBITRAGE STRATEGY
// SOL -> Token -> SOL round-trip arbitrage.
// The bread-and-butter MEV strategy: buy a token with SOL, immediately sell
// it back for SOL, and pocket the difference if profitable after fees.

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
const BASE_GAS_LAMPORTS = 5_000;              // base compute-unit fee
const PRIORITY_FEE_LAMPORTS = 200_000;        // realistic priority fee (Jupiter auto-sets)
const JUPITER_PLATFORM_FEE_BPS = 10;          // 0.10% Jupiter platform fee
const DEX_SWAP_FEE_BPS = 30;                  // ~0.30% average DEX pool fee (Orca/Raydium)
const QUOTE_LIFETIME_MS = 15_000;             // quotes expire after 15 s

export class CyclicArbitrageStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'cyclic-arbitrage',
      enabled: riskProfile.strategies.cyclicArbitrage,
      scanIntervalMs: 2_000,
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
    return 'Cyclic Arbitrage (SOL -> Token -> SOL)';
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

    strategyLog.debug(
      { scanAmountSol: this.botConfig.scanAmountSol, tokens: SCAN_TOKENS.length },
      'Cyclic arbitrage scan starting',
    );

    for (const token of SCAN_TOKENS) {
      try {
        // Rate-limit: sleep between API call pairs
        await this.rateLimit();

        // Leg 1: SOL -> Token
        const leg1Quote = await this.getQuote(
          SOL_MINT,
          token.mint,
          scanAmountLamports.toString(),
          this.config.slippageBps,
        );

        if (!leg1Quote || !leg1Quote.outAmount) {
          strategyLog.debug({ token: token.symbol }, 'No quote for leg 1');
          continue;
        }

        await this.rateLimit();

        // Leg 2: Token -> SOL
        const leg2Quote = await this.getQuote(
          token.mint,
          SOL_MINT,
          leg1Quote.outAmount,
          this.config.slippageBps,
        );

        if (!leg2Quote || !leg2Quote.outAmount) {
          strategyLog.debug({ token: token.symbol }, 'No quote for leg 2');
          continue;
        }

        // ── Profitability check ──────────────────────────────────────────────
        const outputLamports = BigInt(leg2Quote.outAmount);
        const profitAnalysis = this.calculateProfit(scanAmountLamports, outputLamports, token);

        if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
          const now = Date.now();
          const opportunity: Opportunity = {
            id: crypto.randomUUID(),
            strategy: this.name,
            tokenPath: ['SOL', token.symbol, 'SOL'],
            mintPath: [SOL_MINT, token.mint, SOL_MINT],
            inputAmountLamports: scanAmountLamports,
            expectedOutputLamports: outputLamports,
            expectedProfitSol: profitAnalysis.netProfitSol,
            expectedProfitUsd: profitAnalysis.netProfitUsd,
            confidence: this.estimateConfidence(profitAnalysis),
            quotes: [leg1Quote, leg2Quote],
            metadata: {
              token: token.symbol,
              tokenMint: token.mint,
              leg1OutAmount: leg1Quote.outAmount,
              leg2OutAmount: leg2Quote.outAmount,
              feeBreakdown: profitAnalysis.feeBreakdown,
              grossProfitSol: profitAnalysis.grossProfitSol,
              totalFeeSol: profitAnalysis.totalFeeSol,
            },
            timestamp: now,
            expiresAt: now + QUOTE_LIFETIME_MS,
          };

          opportunities.push(opportunity);
          this.opportunitiesFound++;

          strategyLog.info(
            {
              token: token.symbol,
              grossProfitSol: profitAnalysis.grossProfitSol.toFixed(6),
              netProfitSol: profitAnalysis.netProfitSol.toFixed(6),
              netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
              confidence: opportunity.confidence.toFixed(3),
            },
            'Cyclic arbitrage opportunity found',
          );
        }
      } catch (err) {
        strategyLog.error({ err, token: token.symbol }, 'Error scanning token for cyclic arb');
      }
    }

    // Sort best profit first
    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.debug(
      { found: opportunities.length, scanCount: this.scanCount },
      'Cyclic arbitrage scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER QUOTE HELPER
  // ────────────────────────────────────────────────────────────────────────────

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<any | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());

    try {
      const response = await fetch(url.toString());

      if (!response.ok) {
        strategyLog.warn(
          { status: response.status, inputMint, outputMint },
          'Jupiter quote request failed',
        );
        return null;
      }

      const data = await response.json();
      return data;
    } catch (err) {
      strategyLog.error({ err, inputMint, outputMint }, 'Jupiter quote fetch error');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROFIT CALCULATION
  // ────────────────────────────────────────────────────────────────────────────

  private calculateProfit(
    inputLamports: bigint,
    outputLamports: bigint,
    token: TokenInfo,
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

    // Fee breakdown (all in SOL)
    const gasFee = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;  // 2 swaps
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const jupiterFee = inputSol * (JUPITER_PLATFORM_FEE_BPS / 10_000) * 2;  // both legs
    const dexFee = inputSol * (DEX_SWAP_FEE_BPS / 10_000) * 2;             // both legs
    const slippageCost = inputSol * (this.config.slippageBps / 10_000) * 2;  // worst-case slippage both legs

    const totalFeeSol = gasFee + priorityFee + jupiterFee + dexFee + slippageCost;
    const netProfitSol = grossProfitSol - totalFeeSol;

    // Rough SOL price estimate (can be replaced with oracle)
    const solPriceUsd = this.botConfig.solPriceUsd || 150;
    const netProfitUsd = netProfitSol * solPriceUsd;

    return {
      grossProfitSol,
      netProfitSol,
      netProfitUsd,
      totalFeeSol,
      feeBreakdown: {
        gasFee,
        priorityFee,
        jupiterFee,
        dexFee,
        slippageCost,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CONFIDENCE ESTIMATOR
  // ────────────────────────────────────────────────────────────────────────────

  private estimateConfidence(profitAnalysis: {
    grossProfitSol: number;
    netProfitSol: number;
    totalFeeSol: number;
  }): number {
    // Higher margin relative to fees = higher confidence
    if (profitAnalysis.netProfitSol <= 0) return 0;

    const marginRatio = profitAnalysis.netProfitSol / profitAnalysis.totalFeeSol;

    // marginRatio < 0.5  -> low confidence (< 0.3)
    // marginRatio 0.5-2  -> medium (0.3-0.7)
    // marginRatio > 2    -> high (0.7-0.95)
    const confidence = Math.min(0.95, Math.max(0.05, marginRatio / 3));
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
