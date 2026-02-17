// FRONT-RUN STRATEGY
// Detects large pending swaps (>10 SOL equivalent) via Geyser mempool stream
// and executes the same-direction trade ahead of them.
//
// Less aggressive than sandwich: only 1 TX before the victim, then waits for
// the natural price movement from the large swap before selling.

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

// ── Types for Geyser / instruction decoder ─────────────────────────────────────
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

// ── Constants ──────────────────────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 100_000;
const JITO_TIP_LAMPORTS = 100_000;
// Jupiter URL loaded from config via this.botConfig.jupiterApiUrl
const QUOTE_LIFETIME_MS = 8_000;
const MIN_VICTIM_AMOUNT_SOL = 10.0;         // only front-run genuinely large swaps
const MIN_EXPECTED_MOVEMENT_BPS = 30;       // minimum 0.3% expected price impact
const FRONTRUN_SIZE_FRACTION = 0.15;        // use 15% of victim's size
const PRICE_IMPACT_CONSTANT = 0.0008;       // simplified constant-product model factor

export class FrontrunStrategy extends BaseStrategy {
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
      name: 'frontrun',
      enabled: riskProfile.strategies.frontrun,
      scanIntervalMs: 0,  // event-driven
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
    return 'Front-Run';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN (event-driven -- returns buffered opportunities)
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    const batch = [...this.pendingOpportunities];
    this.pendingOpportunities = [];
    this.scanCount++;
    return batch;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // EVENT HANDLER: called by Geyser stream
  // ────────────────────────────────────────────────────────────────────────────

  async onPendingTransaction(tx: ParsedTransactionData): Promise<Opportunity | null> {
    if (!this.isActive()) return null;

    try {
      for (const swap of tx.instructions) {
        if (!swap || !swap.inputMint || !swap.outputMint) continue;

        // ── Filter: must involve SOL ─────────────────────────────────────
        const involvesSol = swap.inputMint === SOL_MINT || swap.outputMint === SOL_MINT;
        if (!involvesSol) continue;

        // ── Filter: must be a genuinely large swap ───────────────────────
        const victimAmountSol = this.estimateAmountSol(swap.amountIn, swap.inputMint);
        if (victimAmountSol < MIN_VICTIM_AMOUNT_SOL) continue;

        // ── Filter: expected price impact must be meaningful ─────────────
        const expectedImpactBps = this.estimatePriceImpactBps(victimAmountSol);
        if (expectedImpactBps < MIN_EXPECTED_MOVEMENT_BPS) continue;

        // ── Determine trade direction ────────────────────────────────────
        // We trade in the SAME direction as the victim (buy if they buy, sell if they sell).
        const victimIsBuying = swap.inputMint === SOL_MINT;
        const tokenMint = victimIsBuying ? swap.outputMint : swap.inputMint;

        const tokenInfo = SCAN_TOKENS.find(t => t.mint === tokenMint);
        if (!tokenInfo) continue;

        // ── Calculate our trade size ─────────────────────────────────────
        const frontrunAmountSol = Math.min(
          victimAmountSol * FRONTRUN_SIZE_FRACTION,
          this.riskProfile.maxTradeAmountSol,
        );
        const frontrunLamports = BigInt(Math.round(frontrunAmountSol * LAMPORTS_PER_SOL));

        // ── Estimate profit: price moves by expectedImpactBps, we sell ──
        // Our expected profit = frontrunAmount * (expectedImpact - slippage - fees)
        const expectedMovementFraction = expectedImpactBps / 10_000;
        const grossProfitSol = frontrunAmountSol * expectedMovementFraction;

        // Costs: 1 TX front-run + 1 TX back-run (sell after price move)
        const gasCost = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;
        const priorityCost = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
        const jitoTip = JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL;
        const slippageCost = frontrunAmountSol * (this.config.slippageBps / 10_000) * 2;

        const totalCostSol = gasCost + priorityCost + jitoTip + slippageCost;
        const netProfitSol = grossProfitSol - totalCostSol;
        const solPriceUsd = this.botConfig.solPriceUsd || 150;
        const netProfitUsd = netProfitSol * solPriceUsd;

        if (netProfitUsd < this.config.minProfitUsd) continue;

        // ── Get front-run quote ──────────────────────────────────────────
        let frontRunQuote: any = null;
        if (victimIsBuying) {
          // Buy token before victim
          frontRunQuote = await this.getQuote(
            SOL_MINT, tokenMint, frontrunLamports.toString(), this.config.slippageBps,
          );
        } else {
          // Victim is selling token -> price will drop -> we sell first, buy back cheaper
          // This case is rarer and riskier, skip for now
          continue;
        }

        if (!frontRunQuote?.outAmount) continue;

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
          quotes: [frontRunQuote],
          metadata: {
            type: 'frontrun',
            victimSignature: tx.signature,
            victimAmountSol,
            victimIsBuying,
            frontrunAmountSol,
            expectedImpactBps,
            tokenSymbol: tokenInfo.symbol,
            costBreakdown: {
              gas: gasCost,
              priority: priorityCost,
              jitoTip,
              slippage: slippageCost,
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
            victimSol: victimAmountSol.toFixed(2),
            frontrunSol: frontrunAmountSol.toFixed(4),
            impactBps: expectedImpactBps,
            netProfitUsd: netProfitUsd.toFixed(4),
          },
          'Front-run opportunity detected',
        );

        return opportunity;
      }
    } catch (err) {
      strategyLog.error({ err, signature: tx.signature }, 'Error processing pending TX for frontrun');
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PRICE IMPACT MODEL
  // ────────────────────────────────────────────────────────────────────────────

  private estimatePriceImpactBps(tradeSizeSol: number): number {
    // Simplified constant-product: impact ~ tradeSize * constant * 10000 bps
    const impact = tradeSizeSol * PRICE_IMPACT_CONSTANT * 10_000;
    return Math.round(Math.max(1, impact));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────────────────────────

  private estimateAmountSol(amount: string, mint: string): number {
    if (mint === SOL_MINT) {
      return parseInt(amount, 10) / LAMPORTS_PER_SOL;
    }
    const token = SCAN_TOKENS.find(t => t.mint === mint);
    if (!token) return 0;
    const rawAmount = parseInt(amount, 10) / Math.pow(10, token.decimals);
    // Very rough approximation for filtering only
    return rawAmount * 0.001;
  }

  private estimateConfidence(netProfitSol: number, totalCostSol: number): number {
    if (netProfitSol <= 0) return 0;
    // Front-running is moderately risky: depends on TX landing order
    const marginRatio = netProfitSol / totalCostSol;
    const confidence = Math.min(0.70, Math.max(0.05, marginRatio / 4));
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
