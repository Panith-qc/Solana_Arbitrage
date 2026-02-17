// SANDWICH STRATEGY
// Detects pending swaps via Geyser mempool stream, then:
//   1. Front-run: buy the token before the victim's swap executes
//   2. Victim's TX executes at a worse price
//   3. Back-run: sell the token at the inflated price
// Net position always returns to SOL.

import crypto from 'crypto';
import { BaseStrategy, Opportunity, StrategyConfig } from './baseStrategy.js';
import { strategyLog } from '../logger.js';
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  BotConfig,
  RiskProfile,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// ── Types for Geyser / instruction decoder (defined inline until modules exist) ─
interface GeyserClient {
  subscribe(filter: any): void;
  on(event: string, callback: (...args: any[]) => void): void;
}

interface ParsedSwapInstruction {
  programId: string;
  pool: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  minimumAmountOut: string;
  slippageBps: number;
}

interface ParsedTransactionData {
  signature: string;
  instructions: ParsedSwapInstruction[];
  feePayer: string;
  recentBlockhash: string;
  raw: any;
}

interface InstructionDecoder {
  decodeSwapInstruction(ix: any): ParsedSwapInstruction | null;
  decodeTransaction(tx: any): ParsedTransactionData | null;
}

// ── Fee & Threshold Constants ──────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 100_000;
const JITO_TIP_LAMPORTS = 100_000;
// Jupiter URL loaded from config via this.botConfig.jupiterApiUrl
const QUOTE_LIFETIME_MS = 5_000;           // sandwich bundles expire fast
const MIN_VICTIM_AMOUNT_SOL = 1.0;         // only sandwich swaps >= 1 SOL
const MIN_VICTIM_SLIPPAGE_BPS = 50;        // only target if slippage tolerance allows
const MAX_FRONTRUN_FRACTION = 0.5;         // use at most 50% of victim's size
const PRICE_IMPACT_MODEL_CONSTANT = 0.001; // simplified constant-product impact model

export class SandwichStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private geyserClient: GeyserClient;
  private instructionDecoder: InstructionDecoder;
  private pendingOpportunities: Opportunity[] = [];

  constructor(
    connectionManager: ConnectionManager,
    config: BotConfig,
    riskProfile: RiskProfile,
    geyserClient: GeyserClient,
    instructionDecoder: InstructionDecoder,
  ) {
    const strategyConfig: StrategyConfig = {
      name: 'sandwich',
      enabled: riskProfile.strategies.sandwich,
      scanIntervalMs: 0,  // event-driven, not polled
      minProfitUsd: riskProfile.minProfitUsd,
      maxPositionSol: riskProfile.maxPositionSol,
      slippageBps: riskProfile.slippageBps,
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.riskProfile = riskProfile;
    this.geyserClient = geyserClient;
    this.instructionDecoder = instructionDecoder;
  }

  getName(): string {
    return 'Sandwich Attack';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN (event-driven -- returns empty, opportunities come from onPendingTransaction)
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    // Drain and return any opportunities collected since last poll
    const batch = [...this.pendingOpportunities];
    this.pendingOpportunities = [];
    this.scanCount++;
    return batch;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // EVENT HANDLER: called by Geyser stream when a pending TX arrives
  // ────────────────────────────────────────────────────────────────────────────

  async onPendingTransaction(tx: ParsedTransactionData): Promise<Opportunity | null> {
    if (!this.isActive()) return null;

    try {
      for (const ix of tx.instructions) {
        const swap = ix;
        if (!swap || !swap.inputMint || !swap.outputMint) continue;

        // ── Filter: only sandwich swaps involving SOL on one side ─────────
        const involvesSol = swap.inputMint === SOL_MINT || swap.outputMint === SOL_MINT;
        if (!involvesSol) continue;

        // ── Filter: victim swap large enough ─────────────────────────────
        const victimAmountSol = this.amountToSol(swap.amountIn, swap.inputMint);
        if (victimAmountSol < MIN_VICTIM_AMOUNT_SOL) continue;

        // ── Filter: victim has enough slippage tolerance ─────────────────
        if (swap.slippageBps < MIN_VICTIM_SLIPPAGE_BPS) continue;

        // ── Determine the sandwich direction ─────────────────────────────
        // If victim buys Token with SOL, we front-run by buying Token first.
        // If victim sells Token for SOL, we front-run by selling Token first (less common).
        const isBuy = swap.inputMint === SOL_MINT;
        const tokenMint = isBuy ? swap.outputMint : swap.inputMint;

        // Only sandwich tokens we know about
        const tokenInfo = SCAN_TOKENS.find(t => t.mint === tokenMint);
        if (!tokenInfo) continue;

        // ── Calculate front-run size ─────────────────────────────────────
        const frontrunAmountSol = Math.min(
          victimAmountSol * MAX_FRONTRUN_FRACTION,
          this.riskProfile.maxTradeAmountSol,
        );
        const frontrunLamports = BigInt(Math.round(frontrunAmountSol * LAMPORTS_PER_SOL));

        // ── Estimate price impact of our front-run on the victim ─────────
        const ourImpactBps = this.estimatePriceImpactBps(frontrunAmountSol, victimAmountSol);

        // ── Estimate profit from the back-run ────────────────────────────
        // After victim's TX, the price has moved further. We sell into the
        // higher price. Profit = price difference * our position size.
        const totalImpactBps = ourImpactBps + this.estimatePriceImpactBps(victimAmountSol, victimAmountSol);
        const backrunProfitSol = frontrunAmountSol * (totalImpactBps / 10_000);

        // ── Costs: 2x gas, 2x priority, Jito tip ────────────────────────
        const totalCostSol =
          ((BASE_GAS_LAMPORTS * 2) + (PRIORITY_FEE_LAMPORTS * 2) + JITO_TIP_LAMPORTS) / LAMPORTS_PER_SOL;

        const netProfitSol = backrunProfitSol - totalCostSol;
        const solPriceUsd = this.botConfig.solPriceUsd || 150;
        const netProfitUsd = netProfitSol * solPriceUsd;

        if (netProfitUsd < this.config.minProfitUsd) continue;

        // ── Build opportunity ────────────────────────────────────────────
        const now = Date.now();
        const opportunity: Opportunity = {
          id: crypto.randomUUID(),
          strategy: this.name,
          tokenPath: ['SOL', tokenInfo.symbol, 'SOL'],
          mintPath: [SOL_MINT, tokenMint, SOL_MINT],
          inputAmountLamports: frontrunLamports,
          expectedOutputLamports: frontrunLamports + BigInt(Math.round(netProfitSol * LAMPORTS_PER_SOL)),
          expectedProfitSol: netProfitSol,
          expectedProfitUsd: netProfitUsd,
          confidence: this.estimateConfidence(netProfitSol, totalCostSol),
          quotes: [],  // will be filled by buildSandwichBundle
          metadata: {
            type: 'sandwich',
            victimSignature: tx.signature,
            victimAmountSol,
            victimSlippageBps: swap.slippageBps,
            frontrunAmountSol,
            priceImpactBps: totalImpactBps,
            tokenSymbol: tokenInfo.symbol,
            direction: isBuy ? 'buy' : 'sell',
            costBreakdown: {
              gas: (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL,
              priority: (PRIORITY_FEE_LAMPORTS * 2) / LAMPORTS_PER_SOL,
              jitoTip: JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL,
            },
          },
          timestamp: now,
          expiresAt: now + QUOTE_LIFETIME_MS,
        };

        this.pendingOpportunities.push(opportunity);
        this.opportunitiesFound++;

        strategyLog.info(
          {
            token: tokenInfo.symbol,
            victimSol: victimAmountSol.toFixed(4),
            frontrunSol: frontrunAmountSol.toFixed(4),
            netProfitUsd: netProfitUsd.toFixed(4),
            impactBps: totalImpactBps,
          },
          'Sandwich opportunity detected',
        );

        return opportunity;
      }
    } catch (err) {
      strategyLog.error({ err, signature: tx.signature }, 'Error processing pending TX for sandwich');
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // BUILD SANDWICH BUNDLE
  // ────────────────────────────────────────────────────────────────────────────

  async buildSandwichBundle(
    opportunity: Opportunity,
  ): Promise<{
    frontRunQuote: any;
    victimTxSignature: string;
    backRunQuote: any;
  } | null> {
    try {
      const tokenMint = opportunity.mintPath[1];
      const frontrunLamports = opportunity.inputAmountLamports.toString();

      // Front-run: buy the token
      const frontRunQuote = await this.getQuote(
        SOL_MINT,
        tokenMint,
        frontrunLamports,
        this.config.slippageBps,
      );
      if (!frontRunQuote?.outAmount) {
        strategyLog.warn({ id: opportunity.id }, 'Failed to get front-run quote');
        return null;
      }

      // Back-run: sell the token back for SOL
      const backRunQuote = await this.getQuote(
        tokenMint,
        SOL_MINT,
        frontRunQuote.outAmount,
        this.config.slippageBps,
      );
      if (!backRunQuote?.outAmount) {
        strategyLog.warn({ id: opportunity.id }, 'Failed to get back-run quote');
        return null;
      }

      return {
        frontRunQuote,
        victimTxSignature: opportunity.metadata.victimSignature,
        backRunQuote,
      };
    } catch (err) {
      strategyLog.error({ err, id: opportunity.id }, 'Error building sandwich bundle');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PRICE IMPACT ESTIMATION (simplified constant-product model)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Estimate the price impact in basis points for a given trade size.
   * Uses a simplified constant-product AMM model:
   *   impact = tradeSize / poolLiquidity
   * We approximate pool liquidity as a multiple of the trade.
   */
  private estimatePriceImpactBps(tradeSizeSol: number, referenceSizeSol: number): number {
    // Rough model: impact in BPS = tradeSizeSol * constant * 10000
    // This is deliberately conservative; real impact depends on pool depth.
    const impact = tradeSizeSol * PRICE_IMPACT_MODEL_CONSTANT * 10_000;
    return Math.round(Math.max(1, impact));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────────────────────────

  private amountToSol(amount: string, mint: string): number {
    if (mint === SOL_MINT) {
      return parseInt(amount, 10) / LAMPORTS_PER_SOL;
    }
    // For non-SOL tokens, we don't have a reliable price here.
    // Approximate using the token's decimals and a rough price.
    const token = SCAN_TOKENS.find(t => t.mint === mint);
    if (!token) return 0;
    // Very rough approximation -- actual price comes from quotes
    const rawAmount = parseInt(amount, 10) / Math.pow(10, token.decimals);
    // Conservative: assume 1 token ~ 0.001 SOL for filtering purposes
    return rawAmount * 0.001;
  }

  private estimateConfidence(netProfitSol: number, totalCostSol: number): number {
    if (netProfitSol <= 0) return 0;
    // Sandwiches have high execution risk (timing, bundle ordering)
    const marginRatio = netProfitSol / totalCostSol;
    const confidence = Math.min(0.75, Math.max(0.05, marginRatio / 5));
    return parseFloat(confidence.toFixed(4));
  }

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
      if (!response.ok) return null;
      return await response.json();
    } catch (err) {
      strategyLog.error({ err, inputMint, outputMint }, 'Quote fetch error');
      return null;
    }
  }
}
