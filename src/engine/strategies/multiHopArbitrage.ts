// MULTI-HOP ARBITRAGE STRATEGY
// SOL -> Token A -> Token B -> SOL three-leg arbitrage.
// Exploits pricing inefficiencies across intermediate token pairs that are not
// visible in a simple two-leg cyclic scan.

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
const PRIORITY_FEE_LAMPORTS = 100_000;
const JUPITER_PLATFORM_FEE_BPS = 10;
const DEX_SWAP_FEE_BPS = 25;
const QUOTE_LIFETIME_MS = 12_000;   // 3-leg paths stale faster
const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const MAX_PAIRS_TO_CHECK = 20;      // cap to stay within rate limits

// Stablecoin mints to skip pairing together (no arb between two stables)
const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
]);

// Liquid SOL derivatives that are likely to pair well
const SOL_DERIVATIVES = new Set([
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
]);

export class MultiHopArbitrageStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private tokenPairs: Array<[TokenInfo, TokenInfo]> = [];

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'multi-hop-arbitrage',
      enabled: riskProfile.strategies.multiHopArbitrage,
      scanIntervalMs: 5_000,
      minProfitUsd: riskProfile.minProfitUsd,
      maxPositionSol: riskProfile.maxPositionSol,
      slippageBps: riskProfile.slippageBps,
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.riskProfile = riskProfile;

    this.buildPairList();
  }

  getName(): string {
    return 'Multi-Hop Arbitrage (SOL -> A -> B -> SOL)';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // BUILD PAIR LIST
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Pre-compute the pairs we will actually scan. Skip obviously unproductive
   * pairs (two stablecoins) and limit to the top MAX_PAIRS_TO_CHECK.
   */
  private buildPairList(): void {
    const pairs: Array<[TokenInfo, TokenInfo]> = [];

    for (let i = 0; i < SCAN_TOKENS.length; i++) {
      for (let j = 0; j < SCAN_TOKENS.length; j++) {
        if (i === j) continue;

        const tokenA = SCAN_TOKENS[i];
        const tokenB = SCAN_TOKENS[j];

        // Skip two stablecoins paired together
        if (STABLECOIN_MINTS.has(tokenA.mint) && STABLECOIN_MINTS.has(tokenB.mint)) {
          continue;
        }

        // Skip two SOL derivatives paired together (low spread)
        if (SOL_DERIVATIVES.has(tokenA.mint) && SOL_DERIVATIVES.has(tokenB.mint)) {
          continue;
        }

        pairs.push([tokenA, tokenB]);
      }
    }

    // Prioritize pairs that mix categories (derivative + meme, governance + derivative, etc.)
    // For now just take the first MAX_PAIRS_TO_CHECK
    this.tokenPairs = pairs.slice(0, MAX_PAIRS_TO_CHECK);

    strategyLog.info(
      { totalPossible: pairs.length, selected: this.tokenPairs.length },
      'Multi-hop pair list built',
    );
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
      { pairs: this.tokenPairs.length, scanAmountSol: this.botConfig.scanAmountSol },
      'Multi-hop scan starting',
    );

    for (const [tokenA, tokenB] of this.tokenPairs) {
      try {
        // Leg 1: SOL -> Token A
        await this.rateLimit();
        const leg1 = await this.getQuote(
          SOL_MINT,
          tokenA.mint,
          scanAmountLamports.toString(),
          this.config.slippageBps,
        );
        if (!leg1?.outAmount) continue;

        // Leg 2: Token A -> Token B
        await this.rateLimit();
        const leg2 = await this.getQuote(
          tokenA.mint,
          tokenB.mint,
          leg1.outAmount,
          this.config.slippageBps,
        );
        if (!leg2?.outAmount) continue;

        // Leg 3: Token B -> SOL
        await this.rateLimit();
        const leg3 = await this.getQuote(
          tokenB.mint,
          SOL_MINT,
          leg2.outAmount,
          this.config.slippageBps,
        );
        if (!leg3?.outAmount) continue;

        // ── Profitability check ──────────────────────────────────────────────
        const outputLamports = BigInt(leg3.outAmount);
        const profitAnalysis = this.calculateProfit(scanAmountLamports, outputLamports);

        if (profitAnalysis.netProfitUsd >= this.config.minProfitUsd) {
          const now = Date.now();
          const opportunity: Opportunity = {
            id: crypto.randomUUID(),
            strategy: this.name,
            tokenPath: ['SOL', tokenA.symbol, tokenB.symbol, 'SOL'],
            mintPath: [SOL_MINT, tokenA.mint, tokenB.mint, SOL_MINT],
            inputAmountLamports: scanAmountLamports,
            expectedOutputLamports: outputLamports,
            expectedProfitSol: profitAnalysis.netProfitSol,
            expectedProfitUsd: profitAnalysis.netProfitUsd,
            confidence: this.estimateConfidence(profitAnalysis),
            quotes: [leg1, leg2, leg3],
            metadata: {
              tokenA: tokenA.symbol,
              tokenB: tokenB.symbol,
              leg1Out: leg1.outAmount,
              leg2Out: leg2.outAmount,
              leg3Out: leg3.outAmount,
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
              path: `SOL->${tokenA.symbol}->${tokenB.symbol}->SOL`,
              netProfitSol: profitAnalysis.netProfitSol.toFixed(6),
              netProfitUsd: profitAnalysis.netProfitUsd.toFixed(4),
            },
            'Multi-hop arbitrage opportunity found',
          );
        }
      } catch (err) {
        strategyLog.error(
          { err, tokenA: tokenA.symbol, tokenB: tokenB.symbol },
          'Error scanning multi-hop pair',
        );
      }
    }

    opportunities.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.debug(
      { found: opportunities.length, scanCount: this.scanCount },
      'Multi-hop scan complete',
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER QUOTE
  // ────────────────────────────────────────────────────────────────────────────

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<any | null> {
    const url = new URL(JUPITER_QUOTE_URL);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        strategyLog.warn({ status: response.status, inputMint, outputMint }, 'Quote failed');
        return null;
      }
      return await response.json();
    } catch (err) {
      strategyLog.error({ err, inputMint, outputMint }, 'Quote fetch error');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROFIT CALCULATION (3 legs)
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

    // 3 legs -> 3x swap fees
    const gasFee = (BASE_GAS_LAMPORTS * 3) / LAMPORTS_PER_SOL;
    const priorityFee = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const jupiterFee = inputSol * (JUPITER_PLATFORM_FEE_BPS / 10_000) * 3;
    const dexFee = inputSol * (DEX_SWAP_FEE_BPS / 10_000) * 3;
    const slippageCost = inputSol * (this.config.slippageBps / 10_000) * 3;

    const totalFeeSol = gasFee + priorityFee + jupiterFee + dexFee + slippageCost;
    const netProfitSol = grossProfitSol - totalFeeSol;
    const solPriceUsd = 150;
    const netProfitUsd = netProfitSol * solPriceUsd;

    return {
      grossProfitSol,
      netProfitSol,
      netProfitUsd,
      totalFeeSol,
      feeBreakdown: { gasFee, priorityFee, jupiterFee, dexFee, slippageCost },
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
    // 3-leg paths carry more execution risk -> lower base confidence
    const marginRatio = profitAnalysis.netProfitSol / profitAnalysis.totalFeeSol;
    const confidence = Math.min(0.85, Math.max(0.05, marginRatio / 4));
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
