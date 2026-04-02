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
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  BotConfig,
  RiskProfile,
  BASE_GAS_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  TWO_LEG_FEE_LAMPORTS,
  JITO_TIP_LAMPORTS,
  MIN_VIABLE_PROFIT_USD,
  REVERSE_LEG_SLIPPAGE_BPS,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

const QUOTE_LIFETIME_MS = 5_000;   // with immediate await execution, quotes are used within 0-2s

// Micro trades: small amounts cycle fast
const MICRO_AMOUNTS_SOL = [0.5, 1];

// Removed MEW (-50bps), BOME (never showed), W (-36bps) — too far negative
// Only keep ORCA and PYTH which showed tighter spreads
const MICRO_EXTRA_TOKENS = [
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6 },
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
  private lastJupiterCallMs: number = 0;
  private tokenIndex: number = 0; // rotate through tokens each scan

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'micro-arbitrage',
      enabled: true,
      scanIntervalMs: 6_000,
      minProfitUsd: MIN_VIABLE_PROFIT_USD,
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
          await this.jupiterRateLimit();
          const leg1 = await this.getJupiterQuote(
            SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps,
          );
          if (!leg1) continue;

          // Leg 2: Token -> SOL — higher slippage for reverse leg in combined atomic TX
          await this.jupiterRateLimit();
          const leg2 = await this.getJupiterQuote(
            token.mint, SOL_MINT, leg1.outputAmount, REVERSE_LEG_SLIPPAGE_BPS,
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
            profitable: profitAnalysis.netProfitUsd >= this.config.minProfitUsd,
          });

          strategyLog.info(
            {
              token: token.symbol, sol: amountSol,
              spreadBps: spreadBps.toFixed(1),
              netUsd: profitAnalysis.netProfitUsd.toFixed(4),
            },
            `MICRO ${token.symbol}@${amountSol} ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
          );

          if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
            strategyLog.warn(
              { token: token.symbol, amountSol, netUsd: profitAnalysis.netProfitUsd.toFixed(4) },
              `MICRO OPPORTUNITY: ${token.symbol}@${amountSol} — fetching swap TXs`,
            );

            // FAST PATH: pre-fetch swap TXs while quotes are fresh
            const swapTxs = await this.fetchSwapTxPair(leg1.raw, leg2.raw);

            const now = Date.now();
            const opp: Opportunity = {
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
            };

            // Attach pre-fetched swap TXs for fast execution
            if (swapTxs) {
              opp.metadata.forwardSwapTx = swapTxs.forwardSwapTx;
              opp.metadata.reverseSwapTx = swapTxs.reverseSwapTx;
              opp.metadata.forwardQuote = leg1.raw;
              opp.metadata.reverseQuote = leg2.raw;
              opp.metadata.scanTimestamp = now;
              strategyLog.info({ token: token.symbol }, 'FAST PATH: Swap TXs pre-fetched');
            }

            // IMMEDIATE EXECUTE: Don't wait for scan to finish — quotes expire
            // while other tokens are still being scanned. Fire callback NOW.
            if (this.onImmediateExecute) {
              strategyLog.info({ token: token.symbol, netUsd: profitAnalysis.netProfitUsd.toFixed(4) },
                `⚡ IMMEDIATE: Executing ${token.symbol} NOW (not waiting for scan to finish)`);
              await this.onImmediateExecute(opp);
            }
            opportunities.push(opp);
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
      const response = await fetch(url.toString(), {
        headers: this.jupiterApiHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        if (response.status === 429) await new Promise(r => setTimeout(r, 5000));
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

  private async fetchSwapTxPair(
    forwardQuote: any, reverseQuote: any,
  ): Promise<{ forwardSwapTx: string; reverseSwapTx: string } | null> {
    try {
      const walletPubkey = this.connectionManager.getPublicKey().toString();
      const primaryUrl = `${this.botConfig.jupiterApiUrl}/swap/v1/swap`;
      const hasSecondKey = !!this.botConfig.jupiterApiKey2;

      const makeBody = (quote: any) => ({
        quoteResponse: quote,
        userPublicKey: walletPubkey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: { maxBps: 1000 },
        prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
      });

      let fwdData: any;
      let revData: any;

      const primaryHeaders = this.jupiterApiHeaders(true);
      const secondaryHeaders = hasSecondKey
        ? { 'Content-Type': 'application/json', 'x-api-key': this.botConfig.jupiterApiKey2 }
        : primaryHeaders;

      if (hasSecondKey) {
        // PARALLEL: Forward on key1, Reverse on key2
        await this.jupiterRateLimit();
        const [fwdResp, revResp] = await Promise.all([
          fetch(primaryUrl, {
            method: 'POST',
            headers: primaryHeaders,
            body: JSON.stringify(makeBody(forwardQuote)),
            signal: AbortSignal.timeout(10000),
          }),
          fetch(primaryUrl, {
            method: 'POST',
            headers: secondaryHeaders,
            body: JSON.stringify(makeBody(reverseQuote)),
            signal: AbortSignal.timeout(10000),
          }),
        ]);
        if (!fwdResp.ok || !revResp.ok) return null;
        [fwdData, revData] = await Promise.all([fwdResp.json(), revResp.json()]);
      } else {
        // SEQUENTIAL: Single key
        await this.jupiterRateLimit();
        const fwdResp = await fetch(primaryUrl, {
          method: 'POST',
          headers: primaryHeaders,
          body: JSON.stringify(makeBody(forwardQuote)),
          signal: AbortSignal.timeout(10000),
        });
        if (!fwdResp.ok) return null;
        fwdData = await fwdResp.json();

        await this.jupiterRateLimit();
        const revResp = await fetch(primaryUrl, {
          method: 'POST',
          headers: primaryHeaders,
          body: JSON.stringify(makeBody(reverseQuote)),
          signal: AbortSignal.timeout(10000),
        });
        if (!revResp.ok) return null;
        revData = await revResp.json();
      }

      if (!fwdData.swapTransaction || !revData.swapTransaction) return null;
      return { forwardSwapTx: fwdData.swapTransaction, reverseSwapTx: revData.swapTransaction };
    } catch {
      return null;
    }
  }

  private calculateProfit(inputLamports: bigint, outputLamports: bigint) {
    const inputSol = Number(inputLamports) / LAMPORTS_PER_SOL;
    const outputSol = Number(outputLamports) / LAMPORTS_PER_SOL;
    const grossProfitSol = outputSol - inputSol;

    // TX fees only — reverse leg's 300bps tolerance handles execution variance
    const totalFeeSol = TWO_LEG_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const netProfitSol = grossProfitSol - totalFeeSol;

    const solPriceUsd = this.botConfig.solPriceUsd || 0;
    return {
      grossProfitSol, netProfitSol,
      netProfitUsd: solPriceUsd > 0 ? netProfitSol * solPriceUsd : -1,
      totalFeeSol,
      feeBreakdown: { txFee: totalFeeSol },
    };
  }

  private estimateConfidence(p: { netProfitSol: number; totalFeeSol: number }): number {
    if (p.netProfitSol <= 0) return 0;
    return parseFloat(Math.min(0.90, Math.max(0.05, p.netProfitSol / p.totalFeeSol / 3)).toFixed(4));
  }

  private async jupiterRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastJupiterCallMs;
    const minDelay = Math.max(1000, Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond));
    if (elapsed < minDelay) await new Promise(r => setTimeout(r, minDelay - elapsed));
    this.lastJupiterCallMs = Date.now();
  }

  private jupiterApiHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (this.botConfig.jupiterApiKey) headers['x-api-key'] = this.botConfig.jupiterApiKey;
    return headers;
  }
}
