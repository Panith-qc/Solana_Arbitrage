// JIT (JUST-IN-TIME) LIQUIDITY STRATEGY
// Detects large incoming swaps via Geyser, then:
//   1. Provide concentrated liquidity in the exact price range of the swap
//   2. Earn trading fees when the large swap executes against our position
//   3. Remove liquidity immediately after the swap
//
// Works with Orca Whirlpool concentrated liquidity positions.
// All operations: deploy SOL as liquidity -> earn fees -> withdraw back to SOL.

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

// ── Program IDs ────────────────────────────────────────────────────────────────
const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// ── Constants ──────────────────────────────────────────────────────────────────
const BASE_GAS_LAMPORTS = 5_000;
const PRIORITY_FEE_LAMPORTS = 150_000;      // higher priority for JIT timing
const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const QUOTE_LIFETIME_MS = 5_000;            // very short-lived JIT window
const MIN_SWAP_SIZE_SOL = 5.0;              // only JIT for swaps >= 5 SOL
const TICK_SPACING_64 = 64;                 // common Orca whirlpool tick spacing
const JIT_LIQUIDITY_RANGE_TICKS = 2;        // provide liquidity in +/- 2 ticks (very concentrated)
const WHIRLPOOL_FEE_RATE_BPS = 30;          // 0.30% fee tier (common for volatile pairs)

// ── Types ──────────────────────────────────────────────────────────────────────
interface GeyserClient {
  subscribe(filter: any): void;
  on(event: string, callback: (...args: any[]) => void): void;
}

interface PendingSwapInfo {
  signature: string;
  pool: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  estimatedAmountSol: number;
  direction: 'buy' | 'sell';
  currentTick: number;
  currentSqrtPrice: string;
}

/** Represents a Whirlpool position for JIT liquidity. */
interface JITPosition {
  whirlpoolAddress: string;
  tokenMintA: string;
  tokenMintB: string;
  tickLowerIndex: number;
  tickUpperIndex: number;
  liquidityAmount: bigint;
  depositAmountA: string;
  depositAmountB: string;
}

export class JITLiquidityStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private geyserClient: GeyserClient;
  private pendingOpportunities: Opportunity[] = [];
  private activePositions: Map<string, JITPosition> = new Map();

  // Known Whirlpool addresses for our tracked tokens (token/SOL pairs)
  private whirlpoolCache: Map<string, string> = new Map();

  constructor(
    connectionManager: ConnectionManager,
    config: BotConfig,
    riskProfile: RiskProfile,
    geyserClient: GeyserClient,
  ) {
    const strategyConfig: StrategyConfig = {
      name: 'jit-liquidity',
      enabled: riskProfile.strategies.jitLiquidity,
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
  }

  getName(): string {
    return 'JIT Liquidity';
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
  // EVENT HANDLER: large incoming swap detected
  // ────────────────────────────────────────────────────────────────────────────

  async onPendingSwap(swap: PendingSwapInfo): Promise<Opportunity | null> {
    if (!this.isActive()) return null;

    try {
      // ── Filter: only process swaps large enough to generate meaningful fees ─
      if (swap.estimatedAmountSol < MIN_SWAP_SIZE_SOL) return null;

      // ── Identify the token ─────────────────────────────────────────────
      const tokenMint = swap.inputMint === SOL_MINT ? swap.outputMint : swap.inputMint;
      const tokenInfo = SCAN_TOKENS.find(t => t.mint === tokenMint);
      if (!tokenInfo) return null;

      // ── Calculate JIT position parameters ──────────────────────────────
      const jitPosition = this.calculateJITPosition(swap, tokenInfo);
      if (!jitPosition) return null;

      // ── Estimate fee income ────────────────────────────────────────────
      const feeIncome = this.estimateFeeIncome(swap, jitPosition);
      if (feeIncome <= 0) return null;

      // ── Costs: open position TX + close position TX + priority ─────────
      const gasCost = (BASE_GAS_LAMPORTS * 3) / LAMPORTS_PER_SOL;  // open + swap + close
      const priorityCost = (PRIORITY_FEE_LAMPORTS * 2) / LAMPORTS_PER_SOL;  // open + close
      const impermanentLoss = this.estimateImpermanentLoss(swap, jitPosition);

      const totalCostSol = gasCost + priorityCost + impermanentLoss;
      const netProfitSol = feeIncome - totalCostSol;
      const solPriceUsd = 150;
      const netProfitUsd = netProfitSol * solPriceUsd;

      if (netProfitUsd < this.config.minProfitUsd) return null;

      // ── Build the opportunity ──────────────────────────────────────────
      const depositSol = this.calculateDepositAmount(swap);
      const depositLamports = BigInt(Math.round(depositSol * LAMPORTS_PER_SOL));

      const now = Date.now();
      const opportunity: Opportunity = {
        id: crypto.randomUUID(),
        strategy: this.name,
        tokenPath: ['SOL', tokenInfo.symbol, 'SOL'],
        mintPath: [SOL_MINT, tokenMint, SOL_MINT],
        inputAmountLamports: depositLamports,
        expectedOutputLamports: depositLamports + BigInt(Math.round(netProfitSol * LAMPORTS_PER_SOL)),
        expectedProfitSol: netProfitSol,
        expectedProfitUsd: netProfitUsd,
        confidence: this.estimateConfidence(netProfitSol, totalCostSol, swap),
        quotes: [],
        metadata: {
          type: 'jit-liquidity',
          triggerSignature: swap.signature,
          whirlpoolProgram: ORCA_WHIRLPOOL_PROGRAM,
          whirlpoolAddress: jitPosition.whirlpoolAddress,
          tokenSymbol: tokenInfo.symbol,
          swapSizeSol: swap.estimatedAmountSol,
          depositSol,
          tickLower: jitPosition.tickLowerIndex,
          tickUpper: jitPosition.tickUpperIndex,
          currentTick: swap.currentTick,
          feeIncomeSol: feeIncome,
          impermanentLossSol: impermanentLoss,
          costBreakdown: {
            gas: gasCost,
            priority: priorityCost,
            impermanentLoss,
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
          swapSol: swap.estimatedAmountSol.toFixed(2),
          depositSol: depositSol.toFixed(4),
          feeIncome: feeIncome.toFixed(6),
          netProfitUsd: netProfitUsd.toFixed(4),
          tickRange: `[${jitPosition.tickLowerIndex}, ${jitPosition.tickUpperIndex}]`,
        },
        'JIT liquidity opportunity detected',
      );

      return opportunity;
    } catch (err) {
      strategyLog.error({ err, signature: swap.signature }, 'Error processing swap for JIT liquidity');
    }

    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JIT POSITION CALCULATION
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate the concentrated liquidity position parameters.
   * We provide liquidity in a very narrow range around the current price,
   * exactly where the incoming swap will execute.
   */
  private calculateJITPosition(swap: PendingSwapInfo, token: TokenInfo): JITPosition | null {
    try {
      const currentTick = swap.currentTick;

      // Align to tick spacing
      const alignedTick = Math.floor(currentTick / TICK_SPACING_64) * TICK_SPACING_64;

      // Very narrow range: +/- JIT_LIQUIDITY_RANGE_TICKS tick spacings
      const tickLower = alignedTick - (JIT_LIQUIDITY_RANGE_TICKS * TICK_SPACING_64);
      const tickUpper = alignedTick + (JIT_LIQUIDITY_RANGE_TICKS * TICK_SPACING_64);

      const whirlpoolAddress = swap.pool || this.whirlpoolCache.get(token.mint) || '';
      if (!whirlpoolAddress) {
        strategyLog.debug({ token: token.symbol }, 'No known whirlpool for token');
        return null;
      }

      // Calculate deposit amounts based on position range and current price
      const depositSol = this.calculateDepositAmount(swap);
      const depositLamports = BigInt(Math.round(depositSol * LAMPORTS_PER_SOL));

      // For a concentrated position around the current price, we need both tokens.
      // Approximate a 50/50 split in value at current price.
      const halfDepositLamports = depositLamports / 2n;

      return {
        whirlpoolAddress,
        tokenMintA: SOL_MINT,
        tokenMintB: token.mint,
        tickLowerIndex: tickLower,
        tickUpperIndex: tickUpper,
        liquidityAmount: depositLamports,  // simplified; real calc uses sqrt price
        depositAmountA: halfDepositLamports.toString(),
        depositAmountB: halfDepositLamports.toString(),  // would be token amount in practice
      };
    } catch (err) {
      strategyLog.error({ err }, 'Failed to calculate JIT position');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // FEE INCOME ESTIMATION
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Estimate the fee income from providing JIT liquidity for the incoming swap.
   * Fee = swapAmount * feeRate * (ourLiquidity / totalLiquidityInRange)
   *
   * Since we provide liquidity in a very narrow range, we capture a large share
   * of the fees if we are the dominant liquidity in that tick range.
   */
  private estimateFeeIncome(swap: PendingSwapInfo, position: JITPosition): number {
    const swapAmountSol = swap.estimatedAmountSol;
    const feeRate = WHIRLPOOL_FEE_RATE_BPS / 10_000;

    // Total fee generated by the swap
    const totalFee = swapAmountSol * feeRate;

    // Assume we capture 30-70% of the fee depending on existing liquidity.
    // In a narrow range with JIT, we often dominate, so use 50% as conservative estimate.
    const captureRate = 0.50;
    const ourFeeIncome = totalFee * captureRate;

    return ourFeeIncome;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // IMPERMANENT LOSS ESTIMATION
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Estimate impermanent loss for the brief period the position is open.
   * Since we open and close within the same block (or 1-2 blocks), IL is minimal
   * but non-zero if the swap moves the price significantly within our range.
   */
  private estimateImpermanentLoss(swap: PendingSwapInfo, position: JITPosition): number {
    // Price change from the swap within our narrow range
    const priceImpactFraction = swap.estimatedAmountSol * 0.0005;  // rough model
    const depositSol = this.calculateDepositAmount(swap);

    // IL for concentrated liquidity with narrow range is approximately:
    // IL ~ deposit * priceChange^2 / 8 (for narrow range, simplified)
    const il = depositSol * Math.pow(priceImpactFraction, 2) / 8;

    return Math.max(0, il);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DEPOSIT SIZING
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Determine how much SOL to deploy as JIT liquidity.
   * Scale with swap size but cap at risk limits.
   */
  private calculateDepositAmount(swap: PendingSwapInfo): number {
    // Deploy liquidity proportional to swap size (10-30% of swap amount)
    const idealDeposit = swap.estimatedAmountSol * 0.2;

    return Math.min(
      idealDeposit,
      this.riskProfile.maxTradeAmountSol,
      this.config.maxPositionSol,
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // WHIRLPOOL DISCOVERY
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Cache Orca Whirlpool addresses for our tracked tokens.
   * Called during initialization to pre-populate the cache.
   */
  async discoverWhirlpools(): Promise<void> {
    try {
      const connection = this.connectionManager.getConnection();

      // In production, query the Orca Whirlpool program for pools matching our token list.
      // For now, this is a placeholder that would be populated by:
      //   1. Querying getProgramAccounts with appropriate filters
      //   2. Or using Orca's API to look up pool addresses
      //   3. Or hardcoding known pool addresses for our token list

      strategyLog.info(
        { tokenCount: SCAN_TOKENS.length, program: ORCA_WHIRLPOOL_PROGRAM },
        'Whirlpool discovery (framework stub)',
      );

      // Example of how pool addresses would be cached:
      // this.whirlpoolCache.set(tokenMint, whirlpoolAddress);
    } catch (err) {
      strategyLog.error({ err }, 'Error discovering Whirlpools');
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // POSITION LIFECYCLE
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Build the JIT liquidity bundle:
   *   TX1: Open concentrated position (deposit tokens)
   *   TX2: (Victim's swap executes, we earn fees)
   *   TX3: Close position (withdraw tokens + fees)
   *
   * This needs to be submitted as a Jito bundle to guarantee atomic ordering.
   */
  async buildJITBundle(opportunity: Opportunity): Promise<{
    openPositionIx: any;
    closePositionIx: any;
    estimatedFeesSol: number;
  } | null> {
    try {
      const meta = opportunity.metadata;

      // Open position instruction (framework)
      const openPositionIx = {
        programId: ORCA_WHIRLPOOL_PROGRAM,
        type: 'openPosition',
        whirlpool: meta.whirlpoolAddress,
        tickLowerIndex: meta.tickLower,
        tickUpperIndex: meta.tickUpper,
        liquidity: opportunity.inputAmountLamports.toString(),
      };

      // Close position instruction (framework)
      const closePositionIx = {
        programId: ORCA_WHIRLPOOL_PROGRAM,
        type: 'closePosition',
        whirlpool: meta.whirlpoolAddress,
        collectFees: true,
      };

      return {
        openPositionIx,
        closePositionIx,
        estimatedFeesSol: meta.feeIncomeSol,
      };
    } catch (err) {
      strategyLog.error({ err, id: opportunity.id }, 'Error building JIT bundle');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ACTIVE POSITION TRACKING
  // ────────────────────────────────────────────────────────────────────────────

  /** Track an active JIT position for monitoring. */
  trackPosition(opportunityId: string, position: JITPosition): void {
    this.activePositions.set(opportunityId, position);
    strategyLog.debug(
      { id: opportunityId, whirlpool: position.whirlpoolAddress },
      'JIT position tracked',
    );
  }

  /** Remove a closed JIT position from tracking. */
  untrackPosition(opportunityId: string): void {
    this.activePositions.delete(opportunityId);
  }

  /** Get all currently active JIT positions. */
  getActivePositions(): Map<string, JITPosition> {
    return new Map(this.activePositions);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CONFIDENCE
  // ────────────────────────────────────────────────────────────────────────────

  private estimateConfidence(
    netProfitSol: number,
    totalCostSol: number,
    swap: PendingSwapInfo,
  ): number {
    if (netProfitSol <= 0) return 0;

    let confidence = 0.3;  // base: JIT is complex

    // Larger swaps are more predictable fee-wise
    if (swap.estimatedAmountSol > 20) confidence += 0.15;
    else if (swap.estimatedAmountSol > 10) confidence += 0.10;

    // Higher margin over costs
    const marginRatio = netProfitSol / totalCostSol;
    confidence += Math.min(0.25, marginRatio / 5);

    return parseFloat(Math.min(0.75, Math.max(0.05, confidence)).toFixed(4));
  }
}
