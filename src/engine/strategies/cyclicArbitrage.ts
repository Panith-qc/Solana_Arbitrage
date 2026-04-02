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
  BASE_GAS_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  JITO_TIP_LAMPORTS,
  JUPITER_MAX_ACCOUNTS,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// Only volatile tokens for cyclic — cross-dex already covers all 10 tokens
// via Raydium (FREE) → Jupiter. Cyclic uses 2 Jupiter calls/token so keep list small.
// Pick 4 from SCAN_TOKENS: 2 memes (volatile spreads) + 2 cross-chain (fewer MMs).
const CYCLIC_SYMBOLS = new Set(['BONK', 'WIF', 'wETH', 'wBTC']);
const CYCLIC_TOKENS = SCAN_TOKENS.filter(t => CYCLIC_SYMBOLS.has(t.symbol));

const QUOTE_LIFETIME_MS = 8_000;  // quotes stale after ~8s on free tier
const EXECUTION_SAFETY_BUFFER_BPS = 0; // Jito atomic bundles = no inter-leg risk

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
      { scanAmountSol: this.botConfig.scanAmountSol, tokens: CYCLIC_TOKENS.length },
      'Cyclic arbitrage scan starting',
    );

    for (const token of CYCLIC_TOKENS) {
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

        // Log ALL spreads (including negative) for visibility
        const spreadBpsNum = (Number(outputLamports) - Number(scanAmountLamports)) / Number(scanAmountLamports) * 10000;
        const spreadBps = spreadBpsNum.toFixed(1);
        strategyLog.info(
          {
            token: token.symbol,
            spreadBps,
            grossProfitSol: profitAnalysis.grossProfitSol.toFixed(6),
            netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
            fees: profitAnalysis.totalFeeSol.toFixed(6),
          },
          `Spread: ${token.symbol} ${spreadBps}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
        );

        // Push to dashboard scan log
        this.onScanResult?.({
          strategy: this.name,
          token: token.symbol,
          spreadBps: spreadBpsNum,
          grossProfitSol: profitAnalysis.grossProfitSol,
          netProfitUsd: profitAnalysis.netProfitUsd,
          fees: profitAnalysis.totalFeeSol,
          profitable: profitAnalysis.netProfitUsd >= this.config.minProfitUsd,
        });

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
    url.searchParams.set('maxAccounts', JUPITER_MAX_ACCOUNTS.toString());

    try {
      const response = await fetch(url.toString(), { headers: this.jupiterApiHeaders() });

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
    // grossProfitSol already reflects real DEX output (fees embedded in Jupiter quote)
    const grossProfitSol = outputSol - inputSol;

    // Only subtract costs NOT already in the Jupiter quote:
    // 1. Solana base transaction fees (2 swaps)
    const gasFee = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;
    // 2. Priority fee (Jupiter sets via 'auto', but we budget for it)
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    // 3. Jito tip for atomic bundle execution
    const jitoTip = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL;
    // 4. Safety buffer for execution variance (quote staleness, partial slippage)
    const safetyBuffer = inputSol * (EXECUTION_SAFETY_BUFFER_BPS / 10_000);

    const totalFeeSol = gasFee + priorityFee + jitoTip + safetyBuffer;
    const netProfitSol = grossProfitSol - totalFeeSol;

    // SOL price must come from live data - refuse to use stale fallback
    const solPriceUsd = this.botConfig.solPriceUsd;
    if (!solPriceUsd || solPriceUsd <= 0) {
      // No valid price - report as unprofitable to prevent blind trading
      return {
        grossProfitSol,
        netProfitSol: -1,
        netProfitUsd: -1,
        totalFeeSol,
        feeBreakdown: { gasFee, priorityFee, jitoTip, safetyBuffer },
      };
    }
    const netProfitUsd = netProfitSol * solPriceUsd;

    return {
      grossProfitSol,
      netProfitSol,
      netProfitUsd,
      totalFeeSol,
      feeBreakdown: {
        gasFee,
        priorityFee,
        jitoTip,
        safetyBuffer,
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

  private jupiterApiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.botConfig.jupiterApiKey) headers['x-api-key'] = this.botConfig.jupiterApiKey;
    return headers;
  }

  private async rateLimit(): Promise<void> {
    const delayMs = Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
