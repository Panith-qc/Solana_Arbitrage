// MICRO ARBITRAGE — High-frequency small trades across many tokens
//
// Why this works: Smaller trade sizes (0.5-1 SOL) experience less price impact
// and can exploit micro-inefficiencies that larger trades cannot. The strategy
// cycles rapidly through tokens looking for tiny spreads that add up over time.
//
// Strategy: Jupiter aggregator SOL→Token→SOL with small amounts, rapid cycling.
// Lower fees per trade = lower break-even threshold.

import crypto from 'crypto';
import { BaseStrategy, Opportunity, StrategyConfig } from './baseStrategy.js';
import { strategyLog } from '../logger.js';
import { jupiterGate, jupiterBackoff } from '../jupiterGate.js';
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  BotConfig,
  RiskProfile,
  BASE_GAS_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  JITO_TIP_LAMPORTS,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

const QUOTE_LIFETIME_MS = 8_000;

// Micro trades: small amounts cycle fast
const MICRO_AMOUNTS_SOL = [0.5, 1];

// Extra tokens specifically for micro arb — high-volume tokens with tight spreads
// that can still show micro-inefficiencies at small sizes
const MICRO_EXTRA_TOKENS = [
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6 },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', decimals: 5 },
  { mint: 'ukHH6c7mMyiWCf6b9w7Q1KhBPJnPo7UbGGfBsnQ5KRR', symbol: 'BOME', decimals: 6 },
  { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', symbol: 'W', decimals: 6 },
];

// Combine SCAN_TOKENS + extra for wider coverage
const ALL_MICRO_TOKENS = [...SCAN_TOKENS, ...MICRO_EXTRA_TOKENS];

interface DexQuote {
  source: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  pricePerToken: number;
  raw: any;
}

export class MicroArbitrageStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;

  private tokenIndex: number = 0; // rotate through tokens each scan

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'micro-arbitrage',
      enabled: true,
      scanIntervalMs: 30_000,  // Every 30s — saves rate budget for sniping
      minProfitUsd: 0,
      maxPositionSol: riskProfile.maxPositionSol,
      slippageBps: riskProfile.slippageBps,
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.riskProfile = riskProfile;
  }

  getName(): string {
    return 'Micro Arbitrage';
  }

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];

    // Scan 3 tokens per cycle (6 Jupiter calls = 3s at 2 RPS) to stay within rate limit
    const tokensPerCycle = 3;
    const tokensToScan = [];
    for (let i = 0; i < tokensPerCycle; i++) {
      tokensToScan.push(ALL_MICRO_TOKENS[this.tokenIndex % ALL_MICRO_TOKENS.length]);
      this.tokenIndex++;
    }

    strategyLog.info(
      { tokens: tokensToScan.map(t => t.symbol), scan: this.scanCount },
      'Micro arb scan starting',
    );

    for (const token of tokensToScan) {
      for (const amountSol of MICRO_AMOUNTS_SOL) {
        const scanAmountLamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
        const scanAmountStr = scanAmountLamports.toString();

        try {
          // Leg 1: SOL -> Token
          await jupiterGate();
          const leg1 = await this.getJupiterQuote(
            SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps,
          );
          if (!leg1) continue;

          // Leg 2: Token -> SOL
          await jupiterGate();
          const leg2 = await this.getJupiterQuote(
            token.mint, SOL_MINT, leg1.outputAmount, this.config.slippageBps,
          );
          if (!leg2) continue;

          const outputLamports = BigInt(leg2.outputAmount);
          const profitAnalysis = this.calculateProfit(scanAmountLamports, outputLamports);
          const spreadBps = (Number(outputLamports) - Number(scanAmountLamports)) / Number(scanAmountLamports) * 10_000;

          this.onScanResult?.({
            strategy: this.name,
            token: `${token.symbol}@${amountSol} (micro)`,
            spreadBps,
            grossProfitSol: profitAnalysis.grossProfitSol,
            netProfitUsd: profitAnalysis.netProfitUsd,
            fees: profitAnalysis.totalFeeSol,
            profitable: profitAnalysis.netProfitUsd > 0,
          });

          strategyLog.info(
            {
              token: token.symbol, sol: amountSol,
              spreadBps: spreadBps.toFixed(1),
              netUsd: profitAnalysis.netProfitUsd.toFixed(4),
            },
            `MICRO ${token.symbol}@${amountSol} ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
          );

          if (profitAnalysis.netProfitUsd > 0) {
            const now = Date.now();
            opportunities.push({
              id: crypto.randomUUID(),
              strategy: this.name,
              tokenPath: ['SOL', token.symbol, 'SOL'],
              mintPath: [SOL_MINT, token.mint, SOL_MINT],
              inputAmountLamports: scanAmountLamports,
              expectedOutputLamports: outputLamports,
              expectedProfitSol: profitAnalysis.netProfitSol,
              expectedProfitUsd: profitAnalysis.netProfitUsd,
              confidence: this.estimateConfidence(profitAnalysis),
              quotes: [leg1.raw, leg2.raw],
              metadata: {
                token: token.symbol,
                scanAmountSol: amountSol,
                spreadBps,
                feeBreakdown: profitAnalysis.feeBreakdown,
              },
              timestamp: now,
              expiresAt: now + QUOTE_LIFETIME_MS,
            });

            strategyLog.warn(
              { token: token.symbol, amountSol, netUsd: profitAnalysis.netProfitUsd.toFixed(4) },
              `MICRO OPPORTUNITY: ${token.symbol}@${amountSol}`,
            );
          }
        } catch (err) {
          strategyLog.error({ err, token: token.symbol }, 'Micro arb scan error');
        }
      }
    }

    strategyLog.info(
      { found: opportunities.length, scanCount: this.scanCount },
      `Micro arb scan complete — ${opportunities.length} profitable`,
    );

    return opportunities;
  }

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
        if (response.status === 429) await jupiterBackoff();
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
    } catch { return null; }
  }

  private calculateProfit(inputLamports: bigint, outputLamports: bigint) {
    const inputSol = Number(inputLamports) / LAMPORTS_PER_SOL;
    const outputSol = Number(outputLamports) / LAMPORTS_PER_SOL;
    const grossProfitSol = outputSol - inputSol;
    const gasFee = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const jitoTip = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL;
    const totalFeeSol = gasFee + priorityFee + jitoTip;
    const netProfitSol = grossProfitSol - totalFeeSol;
    const solPriceUsd = this.botConfig.solPriceUsd || 0;
    return {
      grossProfitSol, netProfitSol,
      netProfitUsd: solPriceUsd > 0 ? netProfitSol * solPriceUsd : -1,
      totalFeeSol,
      feeBreakdown: { gasFee, priorityFee, jitoTip },
    };
  }

  private estimateConfidence(p: { netProfitSol: number; totalFeeSol: number }): number {
    if (p.netProfitSol <= 0) return 0;
    return parseFloat(Math.min(0.90, Math.max(0.05, p.netProfitSol / p.totalFeeSol / 3)).toFixed(4));
  }

}
