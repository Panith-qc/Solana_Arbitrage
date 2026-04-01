// LONG TAIL ARBITRAGE — Less-liquid tokens with wider spreads
//
// Why this works: Popular tokens (mSOL, jitoSOL) are arbitraged by hundreds of
// professional bots — spreads are razor-thin. But mid-cap tokens with fewer
// market makers have wider bid-ask spreads (5-50 bps vs 0.1-0.5 bps).
//
// Strategy: Use Raydium FREE API to get buy quotes on long-tail tokens,
// then Jupiter sell to capture the cross-DEX spread. Wider spreads on less
// efficient markets = more profit opportunities.

import crypto from 'crypto';
import { BaseStrategy, Opportunity, StrategyConfig } from './baseStrategy.js';
import { strategyLog } from '../logger.js';
import { jupiterGate, jupiterBackoff } from '../jupiterGate.js';
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  BotConfig,
  RiskProfile,
  BASE_GAS_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  JITO_TIP_LAMPORTS,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

const QUOTE_LIFETIME_MS = 10_000;
const EXECUTION_SAFETY_BUFFER_BPS = 0;

// Long-tail tokens — mid-cap, fewer arb bots, wider spreads
// These are tokens NOT in the main SCAN_TOKENS list to avoid overlap
const LONG_TAIL_TOKENS = [
  { mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4', symbol: 'MYRO', decimals: 9 },
  { mint: 'SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y', symbol: 'SHDW', decimals: 9 },
  { mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', symbol: 'HNT', decimals: 8 },
  { mint: 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt', symbol: 'SRM', decimals: 6 },
  { mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9 },
  { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RENDER', decimals: 8 },
  { mint: 'nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7', symbol: 'NOS', decimals: 6 },
  { mint: 'METAewgxyPbgwsseH8T16a39CQ5VyVxLi9A7TMe2Ebi', symbol: 'MPLX', decimals: 6 },
  { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', symbol: 'KMNO', decimals: 6 },
  { mint: 'EPeUFDgHRxs9xxEPVaL6kfGQvCon7jmAWKVUHuux1Tpz', symbol: 'BAT', decimals: 8 },
];

// Scan with smaller amounts (2 SOL) — long tail tokens have less liquidity
const SCAN_AMOUNT_SOL = 2;
const RAYDIUM_BATCH_SIZE = 5;
const RAYDIUM_BATCH_DELAY_MS = 200;

interface DexQuote {
  source: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  pricePerToken: number;
  raw: any;
}

export class LongTailArbitrageStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;


  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'long-tail-arbitrage',
      enabled: true, // Always enabled when strategy is instantiated
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
    return 'Long-Tail Arbitrage';
  }

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];
    const scanAmountStr = BigInt(Math.round(SCAN_AMOUNT_SOL * LAMPORTS_PER_SOL)).toString();
    const scanAmountLamports = BigInt(scanAmountStr);
    const inputLamports = parseFloat(scanAmountStr);

    strategyLog.info(
      { tokens: LONG_TAIL_TOKENS.length, sol: SCAN_AMOUNT_SOL, scan: this.scanCount },
      'Long-tail scan starting',
    );

    // Step 1: Raydium buy ALL long-tail tokens (FREE, parallel)
    const raydiumBuys = await this.raydiumBulkBuy(scanAmountStr);

    // Step 2: Jupiter sell for tokens that got Raydium quotes
    for (const token of LONG_TAIL_TOKENS) {
      const buyQuote = raydiumBuys.get(token.mint);
      if (!buyQuote) continue;

      await jupiterGate();
      const jupSell = await this.getJupiterQuote(
        token.mint, SOL_MINT, buyQuote.outputAmount, this.config.slippageBps,
      );
      if (!jupSell) continue;

      const outputLamports = parseFloat(jupSell.outputAmount);
      const spreadBps = ((outputLamports - inputLamports) / inputLamports) * 10_000;
      const profitAnalysis = this.calculateProfit(scanAmountLamports, BigInt(jupSell.outputAmount));

      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${SCAN_AMOUNT_SOL} (long-tail)`,
        spreadBps,
        grossProfitSol: profitAnalysis.grossProfitSol,
        netProfitUsd: profitAnalysis.netProfitUsd,
        fees: profitAnalysis.totalFeeSol,
        profitable: profitAnalysis.netProfitUsd > 0,
      });

      const emoji = profitAnalysis.grossProfitSol > 0 ? '🟢' : '🔴';
      strategyLog.info(
        {
          token: token.symbol, sol: SCAN_AMOUNT_SOL,
          spreadBps: spreadBps.toFixed(1),
          grossSol: profitAnalysis.grossProfitSol.toFixed(6),
          netUsd: profitAnalysis.netProfitUsd.toFixed(4),
        },
        `${emoji} LONGTAIL ${token.symbol} ray→jup ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
      );

      if (profitAnalysis.netProfitUsd > 0) {
        // Get Jupiter buy quote for execution
        await jupiterGate();
        const jupBuy = await this.getJupiterQuote(
          SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps,
        );
        if (!jupBuy?.raw?.routePlan) continue;

        await jupiterGate();
        const jupSell2 = await this.getJupiterQuote(
          token.mint, SOL_MINT, jupBuy.outputAmount, this.config.slippageBps,
        );
        if (!jupSell2) continue;

        const p2 = this.calculateProfit(scanAmountLamports, BigInt(jupSell2.outputAmount));
        if (p2.netProfitUsd <= 0) continue;

        const now = Date.now();
        opportunities.push({
          id: crypto.randomUUID(),
          strategy: this.name,
          tokenPath: ['SOL', token.symbol, 'SOL'],
          mintPath: [SOL_MINT, token.mint, SOL_MINT],
          inputAmountLamports: scanAmountLamports,
          expectedOutputLamports: BigInt(jupSell2.outputAmount),
          expectedProfitSol: p2.netProfitSol,
          expectedProfitUsd: p2.netProfitUsd,
          confidence: this.estimateConfidence(p2),
          quotes: [jupBuy.raw, jupSell2.raw],
          metadata: {
            token: token.symbol,
            scanAmountSol: SCAN_AMOUNT_SOL,
            buySource: 'aggregator',
            sellSource: 'aggregator',
            spreadBps,
            feeBreakdown: p2.feeBreakdown,
          },
          timestamp: now,
          expiresAt: now + QUOTE_LIFETIME_MS,
        });

        strategyLog.warn(
          { token: token.symbol, netUsd: p2.netProfitUsd.toFixed(4) },
          `LONG-TAIL OPPORTUNITY: ${token.symbol}`,
        );
      }
    }

    strategyLog.info(
      { found: opportunities.length, scanCount: this.scanCount },
      `Long-tail scan complete — ${opportunities.length} profitable`,
    );

    return opportunities;
  }

  // Raydium bulk buy (FREE)
  private async raydiumBulkBuy(scanAmountStr: string): Promise<Map<string, DexQuote>> {
    const results = new Map<string, DexQuote>();

    for (let i = 0; i < LONG_TAIL_TOKENS.length; i += RAYDIUM_BATCH_SIZE) {
      const batch = LONG_TAIL_TOKENS.slice(i, i + RAYDIUM_BATCH_SIZE);
      const promises = batch.map(async (token) => {
        try {
          const quote = await this.getRaydiumSwapQuote(SOL_MINT, token.mint, scanAmountStr);
          if (quote) results.set(token.mint, quote);
        } catch { /* skip */ }
      });
      await Promise.all(promises);
      if (i + RAYDIUM_BATCH_SIZE < LONG_TAIL_TOKENS.length) {
        await new Promise(r => setTimeout(r, RAYDIUM_BATCH_DELAY_MS));
      }
    }

    return results;
  }

  private async getRaydiumSwapQuote(
    inputMint: string, outputMint: string, amount: string,
  ): Promise<DexQuote | null> {
    for (const baseUrl of ['https://transaction-v1.raydium.io', 'https://api-v3.raydium.io']) {
      try {
        const url = `${baseUrl}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&txVersion=V0`;
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) continue;
        const data = await response.json();
        const outAmount = data.data?.outputAmount || data.data?.outAmount;
        if (!outAmount) continue;
        return {
          source: 'raydium-direct', inputMint, outputMint, inputAmount: amount,
          outputAmount: String(outAmount),
          pricePerToken: parseFloat(String(outAmount)) / parseFloat(amount),
          raw: data,
        };
      } catch { continue; }
    }
    return null;
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
