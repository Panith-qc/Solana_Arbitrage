// BACK-RUN STRATEGY
// Monitors recently confirmed large swaps and captures the price dislocation
// that follows. When a whale sells a large amount of a token, the price drops;
// we buy cheap and sell once the price rebounds.
//
// Can operate in two modes:
//   1. Poll-based: scan() queries recent confirmed signatures on major pools
//   2. Event-driven: onConfirmedTransaction() called by WebSocket subscription
// Both paths end up in the same analysis pipeline.

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

// ── Constants ──────────────────────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 100_000;
// Jupiter URL loaded from config via this.botConfig.jupiterApiUrl
const QUOTE_LIFETIME_MS = 15_000;
const MIN_SWAP_SIZE_SOL = 5.0;              // only backrun swaps >= 5 SOL
const EXPECTED_REVERSION_BPS = 20;          // expect ~0.2% mean-reversion
const MAX_LOOKBACK_SIGNATURES = 20;         // how many recent sigs to check per pool

// Known AMM program IDs for signature scanning
const AMM_PROGRAMS = [
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter V6
];

// Parsed swap from a confirmed transaction
interface ConfirmedSwap {
  signature: string;
  tokenMint: string;
  tokenSymbol: string;
  direction: 'buy' | 'sell';  // from the original trader's perspective
  amountSol: number;
  timestamp: number;
}

// For event-driven mode
interface ConfirmedTransactionData {
  signature: string;
  logs: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: Array<{ mint: string; uiTokenAmount: { amount: string; decimals: number } }>;
  postTokenBalances: Array<{ mint: string; uiTokenAmount: { amount: string; decimals: number } }>;
  blockTime: number;
  raw: any;
}

export class BackrunStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private pendingOpportunities: Opportunity[] = [];
  private processedSignatures: Set<string> = new Set();
  private readonly maxProcessedCache = 2_000;

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'backrun',
      enabled: riskProfile.strategies.backrun,
      scanIntervalMs: 5_000,
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
    return 'Back-Run';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SCAN (poll-based: check recent confirmed large swaps)
  // ────────────────────────────────────────────────────────────────────────────

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;

    // Collect any event-driven opportunities first
    const eventDriven = [...this.pendingOpportunities];
    this.pendingOpportunities = [];

    // Now do poll-based scan
    const polled = await this.pollRecentSwaps();
    const all = [...eventDriven, ...polled];

    all.sort((a, b) => b.expectedProfitUsd - a.expectedProfitUsd);

    strategyLog.debug(
      { eventDriven: eventDriven.length, polled: polled.length, scanCount: this.scanCount },
      'Backrun scan complete',
    );

    return all;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // POLL: query recent confirmed signatures on AMM programs
  // ────────────────────────────────────────────────────────────────────────────

  private async pollRecentSwaps(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];
    const connection = this.connectionManager.getConnection();

    for (const tokenInfo of SCAN_TOKENS) {
      try {
        await this.rateLimit();

        // Check if there's a recent price dislocation by comparing buy vs sell quotes
        const scanAmountLamports = BigInt(
          Math.round(this.botConfig.scanAmountSol * LAMPORTS_PER_SOL),
        );

        // Get current buy price (SOL -> Token)
        const buyQuote = await this.getQuote(
          SOL_MINT,
          tokenInfo.mint,
          scanAmountLamports.toString(),
          this.config.slippageBps,
        );
        if (!buyQuote?.outAmount) continue;

        await this.rateLimit();

        // Get current sell price (Token -> SOL) for the amount we would get
        const sellQuote = await this.getQuote(
          tokenInfo.mint,
          SOL_MINT,
          buyQuote.outAmount,
          this.config.slippageBps,
        );
        if (!sellQuote?.outAmount) continue;

        // Calculate round-trip cost
        const outputLamports = BigInt(sellQuote.outAmount);
        const inputSol = Number(scanAmountLamports) / LAMPORTS_PER_SOL;
        const outputSol = Number(outputLamports) / LAMPORTS_PER_SOL;
        const roundTripLoss = inputSol - outputSol;

        // If the round-trip loss is unusually low or negative (meaning buy price
        // is temporarily depressed), that's a sign of a recent large sell.
        // We check if buying now and holding briefly could be profitable.
        const expectedReversionSol = inputSol * (EXPECTED_REVERSION_BPS / 10_000);
        const fees = this.calculateFees(inputSol);
        const netProfitSol = expectedReversionSol - roundTripLoss - fees.total;
        const solPriceUsd = this.botConfig.solPriceUsd || 150;
        const netProfitUsd = netProfitSol * solPriceUsd;

        if (netProfitUsd >= this.config.minProfitUsd) {
          const now = Date.now();
          const opportunity: Opportunity = {
            id: crypto.randomUUID(),
            strategy: this.name,
            tokenPath: ['SOL', tokenInfo.symbol, 'SOL'],
            mintPath: [SOL_MINT, tokenInfo.mint, SOL_MINT],
            inputAmountLamports: scanAmountLamports,
            expectedOutputLamports: scanAmountLamports + BigInt(Math.round(netProfitSol * LAMPORTS_PER_SOL)),
            expectedProfitSol: netProfitSol,
            expectedProfitUsd: netProfitUsd,
            confidence: this.estimateConfidence(netProfitSol, fees.total),
            quotes: [buyQuote, sellQuote],
            metadata: {
              type: 'backrun-poll',
              token: tokenInfo.symbol,
              roundTripLoss,
              expectedReversion: expectedReversionSol,
              feeBreakdown: fees,
            },
            timestamp: now,
            expiresAt: now + QUOTE_LIFETIME_MS,
          };

          opportunities.push(opportunity);
          this.opportunitiesFound++;

          strategyLog.info(
            {
              token: tokenInfo.symbol,
              roundTripLoss: roundTripLoss.toFixed(6),
              expectedReversion: expectedReversionSol.toFixed(6),
              netProfitUsd: netProfitUsd.toFixed(4),
            },
            'Backrun opportunity found (poll)',
          );
        }
      } catch (err) {
        strategyLog.error({ err, token: tokenInfo.symbol }, 'Error polling backrun for token');
      }
    }

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // EVENT HANDLER: called by WebSocket subscription on confirmed swaps
  // ────────────────────────────────────────────────────────────────────────────

  async onConfirmedTransaction(tx: ConfirmedTransactionData): Promise<Opportunity | null> {
    if (!this.isActive()) return null;

    // Deduplicate
    if (this.processedSignatures.has(tx.signature)) return null;
    this.addProcessedSignature(tx.signature);

    try {
      // ── Detect the swap direction and size from balance changes ─────────
      const swap = this.detectSwapFromBalances(tx);
      if (!swap) return null;

      // ── Filter: only backrun large swaps ───────────────────────────────
      if (swap.amountSol < MIN_SWAP_SIZE_SOL) return null;

      const tokenInfo = SCAN_TOKENS.find(t => t.mint === swap.tokenMint);
      if (!tokenInfo) return null;

      // ── The opportunity: trade in the OPPOSITE direction ───────────────
      // If someone just sold a lot of Token for SOL (price dropped),
      // we buy Token cheap and sell when price reverts.
      if (swap.direction !== 'sell') return null;  // only buy on dips for now

      const backrunAmountSol = Math.min(
        swap.amountSol * 0.1,  // 10% of the whale's trade
        this.riskProfile.maxTradeAmountSol,
      );
      const backrunLamports = BigInt(Math.round(backrunAmountSol * LAMPORTS_PER_SOL));

      // Get buy quote at the (hopefully depressed) price
      const buyQuote = await this.getQuote(
        SOL_MINT,
        tokenInfo.mint,
        backrunLamports.toString(),
        this.config.slippageBps,
      );
      if (!buyQuote?.outAmount) return null;

      // Estimate profit from reversion
      const expectedReversionSol = backrunAmountSol * (EXPECTED_REVERSION_BPS / 10_000);
      const fees = this.calculateFees(backrunAmountSol);
      const netProfitSol = expectedReversionSol - fees.total;
      const solPriceUsd = this.botConfig.solPriceUsd || 150;
      const netProfitUsd = netProfitSol * solPriceUsd;

      if (netProfitUsd < this.config.minProfitUsd) return null;

      const now = Date.now();
      const opportunity: Opportunity = {
        id: crypto.randomUUID(),
        strategy: this.name,
        tokenPath: ['SOL', tokenInfo.symbol, 'SOL'],
        mintPath: [SOL_MINT, tokenInfo.mint, SOL_MINT],
        inputAmountLamports: backrunLamports,
        expectedOutputLamports: backrunLamports + BigInt(Math.round(netProfitSol * LAMPORTS_PER_SOL)),
        expectedProfitSol: netProfitSol,
        expectedProfitUsd: netProfitUsd,
        confidence: this.estimateConfidence(netProfitSol, fees.total),
        quotes: [buyQuote],
        metadata: {
          type: 'backrun-event',
          triggerSignature: tx.signature,
          whaleDirection: swap.direction,
          whaleAmountSol: swap.amountSol,
          backrunAmountSol,
          expectedReversionBps: EXPECTED_REVERSION_BPS,
          token: tokenInfo.symbol,
          feeBreakdown: fees,
        },
        timestamp: now,
        expiresAt: now + QUOTE_LIFETIME_MS,
      };

      this.pendingOpportunities.push(opportunity);
      this.opportunitiesFound++;

      strategyLog.info(
        {
          token: tokenInfo.symbol,
          whaleAmountSol: swap.amountSol.toFixed(2),
          backrunAmountSol: backrunAmountSol.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
          triggerSig: tx.signature.slice(0, 16) + '...',
        },
        'Backrun opportunity detected (event)',
      );

      return opportunity;
    } catch (err) {
      strategyLog.error({ err, signature: tx.signature }, 'Error processing confirmed TX for backrun');
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SWAP DETECTION from balance changes
  // ────────────────────────────────────────────────────────────────────────────

  private detectSwapFromBalances(tx: ConfirmedTransactionData): ConfirmedSwap | null {
    try {
      if (!tx.preTokenBalances || !tx.postTokenBalances) return null;

      // Find token balance changes
      for (const postBal of tx.postTokenBalances) {
        const preBal = tx.preTokenBalances.find(p => p.mint === postBal.mint);
        if (!preBal) continue;

        const preAmount = BigInt(preBal.uiTokenAmount.amount);
        const postAmount = BigInt(postBal.uiTokenAmount.amount);
        const diff = postAmount - preAmount;

        if (diff === 0n) continue;

        const tokenInfo = SCAN_TOKENS.find(t => t.mint === postBal.mint);
        if (!tokenInfo) continue;

        // Detect SOL balance change for the fee payer (index 0)
        const solDiffLamports = (tx.postBalances[0] || 0) - (tx.preBalances[0] || 0);
        const solDiff = Math.abs(solDiffLamports) / LAMPORTS_PER_SOL;

        if (solDiff < MIN_SWAP_SIZE_SOL) continue;

        // If SOL decreased and token increased -> buy
        // If SOL increased and token decreased -> sell
        const direction: 'buy' | 'sell' = solDiffLamports < 0 ? 'buy' : 'sell';

        return {
          signature: tx.signature,
          tokenMint: postBal.mint,
          tokenSymbol: tokenInfo.symbol,
          direction,
          amountSol: solDiff,
          timestamp: tx.blockTime * 1000,
        };
      }
    } catch (err) {
      strategyLog.debug({ err }, 'Failed to detect swap from balances');
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────────────────────────

  private calculateFees(inputSol: number): { gas: number; priority: number; dex: number; slippage: number; total: number } {
    const gas = (BASE_GAS_LAMPORTS * 2) / LAMPORTS_PER_SOL;
    const priority = PRIORITY_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const dex = inputSol * 0.0025 * 2;  // 0.25% each leg
    const slippage = inputSol * (this.config.slippageBps / 10_000) * 2;
    return { gas, priority, dex, slippage, total: gas + priority + dex + slippage };
  }

  private estimateConfidence(netProfitSol: number, totalCostSol: number): number {
    if (netProfitSol <= 0) return 0;
    // Back-running is safer than front-running (TX already confirmed)
    const marginRatio = netProfitSol / totalCostSol;
    const confidence = Math.min(0.80, Math.max(0.05, marginRatio / 3));
    return parseFloat(confidence.toFixed(4));
  }

  private addProcessedSignature(sig: string): void {
    this.processedSignatures.add(sig);
    // Prune cache if too large
    if (this.processedSignatures.size > this.maxProcessedCache) {
      const toDelete = this.processedSignatures.size - this.maxProcessedCache + 500;
      let deleted = 0;
      for (const s of this.processedSignatures) {
        if (deleted >= toDelete) break;
        this.processedSignatures.delete(s);
        deleted++;
      }
    }
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

  private async rateLimit(): Promise<void> {
    const delayMs = Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
