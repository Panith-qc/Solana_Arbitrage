// UNIFIED EXECUTION ENGINE
// Orchestrates the full lifecycle of MEV trades: quoting, simulation, sending,
// confirmation, and profit accounting. Supports both direct RPC sends and
// Jito bundle submission with automatic retry and rate limiting.

import {
  Connection,
  VersionedTransaction,
  TransactionConfirmationStrategy,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import { executionLog } from './logger.js';
import {
  BotConfig,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SINGLE_LEG_FEE_LAMPORTS,
  TWO_LEG_FEE_LAMPORTS,
} from './config.js';
import { ConnectionManager } from './connectionManager.js';
import {
  simulateTransaction,
  simulateSwapProfitability,
  SimulationResult,
} from './simulator.js';
import {
  buildSwapTransaction,
  serializeTransaction,
  getRandomTipAccount,
} from './transactionBuilder.js';
import {
  submitArbitrageBundle,
  waitForBundleLanding,
  JitoBundleResult,
} from './jitoBundleExecutor.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot?: number;
  timeTaken?: number;
}

export interface ExecutionResult {
  success: boolean;
  profitSol: number;
  profitUsd: number;
  signatures: string[];
  gasUsed: number;
  jitoTip: number;
  error: string | null;
  /** If tokens are stuck mid-cycle, provide info for recovery queue */
  stuckToken: StuckTokenInfo | null;
  /** Total wall-clock time for the execution in ms */
  executionTimeMs: number;
}

export interface StuckTokenInfo {
  tokenMint: string;
  tokenSymbol: string;
  estimatedBalanceLamports: number;
  reason: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

/** Confirmation timeout for sendRawTransaction */
const CONFIRM_TIMEOUT_MS = 30_000;

// ═══════════════════════════════════════════════════════════════════
// EXECUTOR CLASS
// ═══════════════════════════════════════════════════════════════════

export class Executor {
  private connManager: ConnectionManager;
  private config: BotConfig;
  private lastApiCallMs: number = 0;
  private minApiIntervalMs: number;

  constructor(connManager: ConnectionManager, config: BotConfig) {
    this.connManager = connManager;
    this.config = config;
    // Derive minimum interval from configured rate limit (requests per second)
    this.minApiIntervalMs = config.maxRequestsPerSecond > 0
      ? Math.ceil(1_000 / config.maxRequestsPerSecond)
      : 500;
  }

  // ═════════════════════════════════════════════════════════════════
  // PUBLIC: EXECUTE A QUOTED SWAP
  // ═════════════════════════════════════════════════════════════════

  /**
   * Given a Jupiter quote, fetch the swap transaction, simulate it, send it,
   * and confirm it on-chain. Returns the signature on success.
   *
   * @param quote        A JupiterQuote obtained from the /quote API
   * @param slippageBps  Slippage tolerance in basis points
   * @returns            ExecutionResult with signature and profit details
   */
  async executeQuotedSwap(
    quote: JupiterQuote,
    slippageBps: number,
  ): Promise<ExecutionResult> {
    const startMs = Date.now();
    const connection = this.connManager.getConnection();
    const wallet = this.connManager.getWallet();

    try {
      // 1. Fetch the swap transaction from Jupiter
      const swapResponse = await this.fetchSwapTransaction(quote, slippageBps, wallet);
      if (!swapResponse) {
        return this.failResult('Failed to fetch swap transaction from Jupiter', startMs);
      }

      // 2. Build and sign the versioned transaction
      const transaction = buildSwapTransaction(swapResponse.swapTransaction, wallet);

      // 3. Simulate before sending
      const simResult = await simulateTransaction(connection, transaction);
      if (!simResult.success) {
        return this.failResult(`Simulation failed: ${simResult.error}`, startMs);
      }

      // 4. Send and confirm with retry
      const signature = await this.sendAndConfirmWithRetry(
        connection,
        transaction,
        swapResponse.lastValidBlockHeight,
      );

      if (!signature) {
        return this.failResult('Transaction failed to confirm after retries', startMs);
      }

      this.connManager.reportSuccess();

      const elapsed = Date.now() - startMs;
      executionLog.info(
        { signature, elapsedMs: elapsed, unitsConsumed: simResult.unitsConsumed },
        'Quoted swap executed successfully',
      );

      return {
        success: true,
        profitSol: 0, // Caller must compute profit by comparing balances
        profitUsd: 0,
        signatures: [signature],
        gasUsed: simResult.unitsConsumed,
        jitoTip: 0,
        error: null,
        stuckToken: null,
        executionTimeMs: elapsed,
      };
    } catch (err: any) {
      await this.connManager.reportFailure();
      return this.failResult(err.message || String(err), startMs);
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // PUBLIC: EXECUTE FULL ARBITRAGE CYCLE
  // ═════════════════════════════════════════════════════════════════

  /**
   * Execute a complete SOL -> Token -> SOL arbitrage cycle.
   *
   * Leg 1: Swap SOL for the target token using the forward quote.
   * Verify: Get a fresh reverse quote for the token amount received.
   * Leg 2: Swap the token back to SOL using the fresh reverse quote.
   *
   * If Leg 2 fails, the token is flagged for the recovery queue.
   *
   * @param forwardQuote  Quote for SOL -> Token
   * @param tokenMint     The intermediate token mint address
   * @param tokenSymbol   Human-readable token symbol (for logging)
   * @param solPrice      Current SOL/USD price for profit calculation
   * @returns             ExecutionResult with net profit
   */
  async executeArbitrageCycle(
    forwardQuote: JupiterQuote,
    tokenMint: string,
    tokenSymbol: string,
    solPrice: number,
  ): Promise<ExecutionResult> {
    const startMs = Date.now();
    const connection = this.connManager.getConnection();
    const wallet = this.connManager.getWallet();
    const inputLamports = parseInt(forwardQuote.inAmount, 10);
    const allSignatures: string[] = [];

    // ── CAPTURE PRE-TRADE SOL BALANCE ────────────────────────────
    // This is the REAL starting balance — used to calculate actual profit after both legs
    let preTradeBalanceLamports: number | null = null;
    try {
      const balanceSol = await this.connManager.getBalance();
      preTradeBalanceLamports = Math.round(balanceSol * LAMPORTS_PER_SOL);
      executionLog.info(
        { preTradeBalanceSol: balanceSol, tokenSymbol, inputSol: inputLamports / LAMPORTS_PER_SOL },
        'Pre-trade SOL balance captured',
      );
    } catch (err) {
      executionLog.warn({ err }, 'Could not capture pre-trade balance — will use quote-based profit');
    }

    executionLog.info(
      {
        tokenSymbol,
        tokenMint,
        inputSol: inputLamports / LAMPORTS_PER_SOL,
        expectedOutput: forwardQuote.outAmount,
        routeSteps: forwardQuote.routePlan.length,
      },
      'Starting arbitrage cycle: SOL -> Token -> SOL',
    );

    // ── FRESH FORWARD QUOTE VALIDATION ───────────────────────────
    // Re-fetch a fresh quote for Leg 1 to ensure the price hasn't moved
    // since the scan. If the fresh quote gives fewer tokens, abort.
    await this.rateLimit();
    const freshForwardQuote = await this.fetchQuote(
      forwardQuote.inputMint,
      forwardQuote.outputMint,
      forwardQuote.inAmount,
      forwardQuote.slippageBps,
    );

    if (!freshForwardQuote) {
      return this.failResult('Fresh forward quote unavailable — market may have moved', startMs);
    }

    const scanTokens = parseInt(forwardQuote.outAmount, 10);
    const freshTokens = parseInt(freshForwardQuote.outAmount, 10);
    const tokenDriftBps = ((freshTokens - scanTokens) / scanTokens) * 10_000;

    if (tokenDriftBps < -10) {
      // Price moved more than 10 bps against us since scan — abort
      executionLog.warn(
        { tokenSymbol, scanTokens, freshTokens, driftBps: tokenDriftBps.toFixed(1) },
        'Forward quote drifted >10bps against us — aborting',
      );
      return this.failResult(
        `Forward price drifted ${tokenDriftBps.toFixed(1)}bps (scan: ${scanTokens}, fresh: ${freshTokens})`,
        startMs,
      );
    }

    // Use the fresh quote for execution (most current price)
    const executionForwardQuote = freshForwardQuote;

    executionLog.info(
      {
        tokenSymbol,
        scanTokens,
        freshTokens,
        driftBps: tokenDriftBps.toFixed(1),
      },
      'Forward quote validated — price still favorable',
    );

    // ── LEG 1: SOL -> TOKEN ──────────────────────────────────────

    const leg1Result = await this.executeLeg(
      connection,
      wallet,
      executionForwardQuote,
      executionForwardQuote.slippageBps,
      'LEG1_SOL_TO_TOKEN',
    );

    if (!leg1Result.success) {
      return this.failResult(`Leg 1 (SOL->Token) failed: ${leg1Result.error}`, startMs);
    }
    allSignatures.push(...leg1Result.signatures);

    // ── INTER-LEG VERIFICATION ───────────────────────────────────
    // Query actual on-chain token balance after Leg 1 to handle slippage.

    let tokenAmountReceived = executionForwardQuote.outAmount;
    try {
      const actualBalance = await this.connManager.getTokenBalance(tokenMint);
      if (actualBalance > 0n) {
        tokenAmountReceived = actualBalance.toString();
        executionLog.info(
          { tokenMint, expected: executionForwardQuote.outAmount, actual: tokenAmountReceived },
          'Using actual on-chain token balance for reverse leg',
        );
      }
    } catch (err) {
      executionLog.warn(
        { err, tokenMint, usingExpected: executionForwardQuote.outAmount },
        'Could not fetch actual token balance, using expected from quote',
      );
    }

    await this.rateLimit();

    // ── FRESH REVERSE QUOTE ──────────────────────────────────────
    executionLog.debug(
      { tokenMint, tokenAmount: tokenAmountReceived },
      'Fetching fresh reverse quote for Token -> SOL',
    );

    const reverseQuote = await this.fetchQuote(
      tokenMint,
      SOL_MINT,
      tokenAmountReceived,
      executionForwardQuote.slippageBps,
    );

    if (!reverseQuote) {
      // Token stuck — try recovery: wait 2s and retry once
      executionLog.warn(
        { tokenSymbol, tokenMint, tokenAmount: tokenAmountReceived },
        'Reverse quote failed — retrying in 2s',
      );
      await new Promise(r => setTimeout(r, 2000));
      await this.rateLimit();

      const retryQuote = await this.fetchQuote(
        tokenMint, SOL_MINT, tokenAmountReceived, executionForwardQuote.slippageBps,
      );

      if (!retryQuote) {
        const elapsed = Date.now() - startMs;
        executionLog.error(
          { tokenSymbol, tokenMint, tokenAmount: tokenAmountReceived },
          'Reverse quote failed after retry; token is stuck',
        );
        return {
          success: false, profitSol: 0, profitUsd: 0, signatures: allSignatures,
          gasUsed: leg1Result.gasUsed, jitoTip: 0,
          error: 'Reverse quote failed after Leg 1; token stuck in wallet',
          stuckToken: {
            tokenMint, tokenSymbol,
            estimatedBalanceLamports: parseInt(tokenAmountReceived, 10),
            reason: 'Reverse quote unavailable after 2 attempts',
          },
          executionTimeMs: elapsed,
        };
      }

      // Use retry quote
      return this.executeReverseLeg(
        connection, wallet, retryQuote, inputLamports, tokenMint, tokenSymbol,
        tokenAmountReceived, solPrice, preTradeBalanceLamports, allSignatures,
        leg1Result.gasUsed, startMs,
      );
    }

    return this.executeReverseLeg(
      connection, wallet, reverseQuote, inputLamports, tokenMint, tokenSymbol,
      tokenAmountReceived, solPrice, preTradeBalanceLamports, allSignatures,
      leg1Result.gasUsed, startMs,
    );
  }

  /**
   * Execute the reverse leg (Token -> SOL) with profitability check,
   * retry on failure, and real balance-based profit calculation.
   */
  private async executeReverseLeg(
    connection: Connection,
    wallet: Keypair,
    reverseQuote: JupiterQuote,
    inputLamports: number,
    tokenMint: string,
    tokenSymbol: string,
    tokenAmountReceived: string,
    solPrice: number,
    preTradeBalanceLamports: number | null,
    allSignatures: string[],
    leg1GasUsed: number,
    startMs: number,
  ): Promise<ExecutionResult> {
    // ── PROFITABILITY RE-CHECK ───────────────────────────────────
    const reverseOutputLamports = parseInt(reverseQuote.outAmount, 10);
    const grossProfitLamports = reverseOutputLamports - inputLamports;
    // Only Leg 2 fees matter here (Leg 1 costs are sunk)
    const leg2FeeLamports = SINGLE_LEG_FEE_LAMPORTS;
    const netCheckLamports = grossProfitLamports - leg2FeeLamports;

    if (netCheckLamports < -50_000) {
      // Loss would exceed 0.00005 SOL — too risky, but we MUST sell the token
      // to recover capital. Log warning but proceed with sell anyway.
      executionLog.warn(
        {
          tokenSymbol, inputLamports, reverseOutputLamports,
          grossProfitLamports, netCheckLamports,
          note: 'Proceeding with sell to recover capital despite loss',
        },
        'Reverse swap shows loss — selling anyway to avoid stuck token',
      );
    } else {
      executionLog.info(
        { tokenSymbol, grossProfitLamports, netCheckLamports },
        'Reverse swap profitability confirmed',
      );
    }

    // ── LEG 2: TOKEN -> SOL ──────────────────────────────────────

    const leg2Result = await this.executeLeg(
      connection, wallet, reverseQuote, reverseQuote.slippageBps, 'LEG2_TOKEN_TO_SOL',
    );

    if (!leg2Result.success) {
      // Leg 2 failed — retry once with fresh quote
      executionLog.warn(
        { tokenSymbol, error: leg2Result.error },
        'Leg 2 failed — retrying with fresh quote in 3s',
      );
      await new Promise(r => setTimeout(r, 3000));
      await this.rateLimit();

      const retryQuote = await this.fetchQuote(
        tokenMint, SOL_MINT, tokenAmountReceived, reverseQuote.slippageBps,
      );

      if (retryQuote) {
        const retryResult = await this.executeLeg(
          connection, wallet, retryQuote, retryQuote.slippageBps, 'LEG2_RETRY_TOKEN_TO_SOL',
        );

        if (retryResult.success) {
          allSignatures.push(...retryResult.signatures);
          return this.calculateFinalResult(
            preTradeBalanceLamports, inputLamports, parseInt(retryQuote.outAmount, 10),
            solPrice, allSignatures, leg1GasUsed + retryResult.gasUsed, startMs, tokenSymbol,
          );
        }
      }

      // Both attempts failed — token is stuck
      const elapsed = Date.now() - startMs;
      executionLog.error(
        { tokenSymbol, error: leg2Result.error },
        'Leg 2 failed after retry; token stuck',
      );
      return {
        success: false, profitSol: 0, profitUsd: 0, signatures: allSignatures,
        gasUsed: leg1GasUsed + leg2Result.gasUsed, jitoTip: 0,
        error: `Leg 2 (Token->SOL) failed after retry: ${leg2Result.error}`,
        stuckToken: {
          tokenMint, tokenSymbol,
          estimatedBalanceLamports: parseInt(tokenAmountReceived, 10),
          reason: `Leg 2 failed twice: ${leg2Result.error}`,
        },
        executionTimeMs: elapsed,
      };
    }

    allSignatures.push(...leg2Result.signatures);

    return this.calculateFinalResult(
      preTradeBalanceLamports, inputLamports, reverseOutputLamports,
      solPrice, allSignatures, leg1GasUsed + leg2Result.gasUsed, startMs, tokenSymbol,
    );
  }

  /**
   * Calculate final profit using REAL on-chain balance delta.
   * Falls back to quote-based estimate only if balance check fails.
   */
  private async calculateFinalResult(
    preTradeBalanceLamports: number | null,
    inputLamports: number,
    reverseOutputLamports: number,
    solPrice: number,
    allSignatures: string[],
    totalGasUsed: number,
    startMs: number,
    tokenSymbol: string,
  ): Promise<ExecutionResult> {
    let actualProfitSol: number;

    if (preTradeBalanceLamports !== null) {
      // BEST: Use real on-chain balance delta — captures ALL fees, slippage, everything
      try {
        const postBalanceSol = await this.connManager.getBalance();
        const postBalanceLamports = Math.round(postBalanceSol * LAMPORTS_PER_SOL);
        const balanceDeltaLamports = postBalanceLamports - preTradeBalanceLamports;
        actualProfitSol = balanceDeltaLamports / LAMPORTS_PER_SOL;

        executionLog.info(
          {
            preTradeBalanceSol: preTradeBalanceLamports / LAMPORTS_PER_SOL,
            postTradeBalanceSol: postBalanceSol,
            balanceDeltaSol: actualProfitSol,
            tokenSymbol,
          },
          'REAL profit from on-chain balance delta',
        );
      } catch {
        // Balance check failed — use quote-based fallback
        const grossLamports = reverseOutputLamports - inputLamports;
        const feeLamports = TWO_LEG_FEE_LAMPORTS;
        actualProfitSol = (grossLamports - feeLamports) / LAMPORTS_PER_SOL;
      }
    } else {
      // No pre-trade balance — use quote-based estimate
      const grossLamports = reverseOutputLamports - inputLamports;
      const feeLamports = 25_000;
      actualProfitSol = (grossLamports - feeLamports) / LAMPORTS_PER_SOL;
    }

    const netProfitUsd = actualProfitSol * solPrice;
    const elapsed = Date.now() - startMs;

    executionLog.info(
      {
        tokenSymbol,
        netProfitSol: actualProfitSol.toFixed(6),
        netProfitUsd: netProfitUsd.toFixed(4),
        signatures: allSignatures,
        totalGasCU: totalGasUsed,
        elapsedMs: elapsed,
      },
      actualProfitSol > 0
        ? 'Arbitrage cycle COMPLETED — PROFIT'
        : 'Arbitrage cycle COMPLETED — LOSS',
    );

    return {
      success: true,
      profitSol: actualProfitSol,
      profitUsd: netProfitUsd,
      signatures: allSignatures,
      gasUsed: totalGasUsed,
      jitoTip: 0,
      error: null,
      stuckToken: null,
      executionTimeMs: elapsed,
    };
  }

  // ═════════════════════════════════════════════════════════════════
  // PUBLIC: EXECUTE VIA JITO BUNDLE
  // ═════════════════════════════════════════════════════════════════

  /**
   * Submit one or more base64-encoded signed transactions as an atomic Jito bundle.
   * Waits for the bundle to land (or fail) before returning.
   *
   * @param transactions  Array of base64-encoded serialized VersionedTransactions
   * @param tipLamports   Jito tip amount (must already be embedded in the last TX)
   * @returns             ExecutionResult
   */
  async executeViaJitoBundle(
    transactions: string[],
    tipLamports: number,
  ): Promise<ExecutionResult> {
    const startMs = Date.now();

    executionLog.info(
      { txCount: transactions.length, tipLamports },
      'Executing via Jito bundle',
    );

    const bundleResult: JitoBundleResult = await submitArbitrageBundle(transactions, tipLamports);

    if (!bundleResult.bundleId) {
      return this.failResult(
        `Bundle submission failed: ${bundleResult.error}`,
        startMs,
      );
    }

    // Wait for the bundle to land
    const finalStatus = await waitForBundleLanding(
      bundleResult.bundleId,
      bundleResult.endpoint || undefined,
    );

    const elapsed = Date.now() - startMs;

    if (finalStatus.status === 'landed') {
      executionLog.info(
        {
          bundleId: bundleResult.bundleId,
          landedSlot: finalStatus.landedSlot,
          tipLamports,
          elapsedMs: elapsed,
        },
        'Jito bundle landed successfully',
      );

      return {
        success: true,
        profitSol: 0, // Must be computed by caller
        profitUsd: 0,
        signatures: [], // Bundle does not directly return individual signatures
        gasUsed: 0,
        jitoTip: tipLamports / LAMPORTS_PER_SOL,
        error: null,
        stuckToken: null,
        executionTimeMs: elapsed,
      };
    }

    return {
      success: false,
      profitSol: 0,
      profitUsd: 0,
      signatures: [],
      gasUsed: 0,
      jitoTip: tipLamports / LAMPORTS_PER_SOL,
      error: `Bundle ${bundleResult.bundleId} status: ${finalStatus.status} - ${finalStatus.error || 'no details'}`,
      stuckToken: null,
      executionTimeMs: elapsed,
    };
  }

  // ═════════════════════════════════════════════════════════════════
  // PRIVATE: EXECUTE A SINGLE LEG
  // ═════════════════════════════════════════════════════════════════

  private async executeLeg(
    connection: Connection,
    wallet: Keypair,
    quote: JupiterQuote,
    slippageBps: number,
    label: string,
  ): Promise<{ success: boolean; signatures: string[]; gasUsed: number; error: string | null }> {
    try {
      // Fetch swap TX from Jupiter
      await this.rateLimit();
      const swapResponse = await this.fetchSwapTransaction(quote, slippageBps, wallet);
      if (!swapResponse) {
        return { success: false, signatures: [], gasUsed: 0, error: 'fetchSwapTransaction returned null' };
      }

      // Build and sign
      const transaction = buildSwapTransaction(swapResponse.swapTransaction, wallet);

      // Simulate
      const simResult = await simulateTransaction(connection, transaction);
      if (!simResult.success) {
        return {
          success: false,
          signatures: [],
          gasUsed: simResult.unitsConsumed,
          error: `Simulation failed: ${simResult.error}`,
        };
      }

      // Send and confirm
      const signature = await this.sendAndConfirmWithRetry(
        connection,
        transaction,
        swapResponse.lastValidBlockHeight,
      );

      if (!signature) {
        return { success: false, signatures: [], gasUsed: simResult.unitsConsumed, error: 'Confirmation failed' };
      }

      executionLog.debug(
        { label, signature, gasUsed: simResult.unitsConsumed },
        'Leg executed successfully',
      );

      return {
        success: true,
        signatures: [signature],
        gasUsed: simResult.unitsConsumed,
        error: null,
      };
    } catch (err: any) {
      return { success: false, signatures: [], gasUsed: 0, error: err.message || String(err) };
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // PRIVATE: JUPITER API
  // ═════════════════════════════════════════════════════════════════

  /**
   * Fetch a quote from Jupiter's /quote endpoint.
   */
  private async fetchQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<JupiterQuote | null> {
    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount,
        slippageBps: slippageBps.toString(),
        swapMode: 'ExactIn',
      });

      const response = await fetchWithTimeout(
        `${JUPITER_QUOTE_URL}?${params.toString()}`,
        {
          method: 'GET',
          headers: this.jupiterHeaders(),
        },
        10_000,
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        executionLog.warn(
          { status: response.status, body: body.slice(0, 200), inputMint, outputMint },
          'Jupiter quote request failed',
        );
        return null;
      }

      const quote = (await response.json()) as JupiterQuote;

      executionLog.debug(
        {
          inputMint: inputMint.slice(0, 8),
          outputMint: outputMint.slice(0, 8),
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          routes: quote.routePlan.length,
        },
        'Jupiter quote received',
      );

      return quote;
    } catch (err: any) {
      executionLog.error(
        { error: err.message, inputMint, outputMint },
        'Exception fetching Jupiter quote',
      );
      return null;
    }
  }

  /**
   * Fetch the serialized swap transaction from Jupiter's /swap endpoint.
   */
  private async fetchSwapTransaction(
    quote: JupiterQuote,
    slippageBps: number,
    wallet: Keypair,
  ): Promise<JupiterSwapResponse | null> {
    try {
      await this.rateLimit();

      const body = {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: 'auto',
      };

      const response = await fetchWithTimeout(
        JUPITER_SWAP_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.jupiterHeaders(),
          },
          body: JSON.stringify(body),
        },
        15_000,
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        executionLog.warn(
          { status: response.status, body: text.slice(0, 300) },
          'Jupiter swap request failed',
        );
        return null;
      }

      const swapResponse = (await response.json()) as JupiterSwapResponse;

      if (!swapResponse.swapTransaction) {
        executionLog.warn('Jupiter /swap returned no swapTransaction');
        return null;
      }

      executionLog.debug(
        {
          lastValidBlockHeight: swapResponse.lastValidBlockHeight,
          txLength: swapResponse.swapTransaction.length,
        },
        'Jupiter swap transaction fetched',
      );

      return swapResponse;
    } catch (err: any) {
      executionLog.error(
        { error: err.message },
        'Exception fetching Jupiter swap transaction',
      );
      return null;
    }
  }

  /**
   * Build common headers for Jupiter API requests.
   */
  private jupiterHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.jupiterApiKey) {
      headers['x-api-key'] = this.config.jupiterApiKey;
    }
    return headers;
  }

  // ═════════════════════════════════════════════════════════════════
  // PRIVATE: SEND + CONFIRM WITH RETRY
  // ═════════════════════════════════════════════════════════════════

  /**
   * Send a signed VersionedTransaction and wait for confirmation.
   * Retries with exponential backoff on transient failures.
   *
   * @returns The transaction signature on success, or null on failure.
   */
  private async sendAndConfirmWithRetry(
    connection: Connection,
    transaction: VersionedTransaction,
    lastValidBlockHeight: number,
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const rawTx = transaction.serialize();
        const signature = await connection.sendRawTransaction(rawTx, {
          skipPreflight: true, // We already simulated
          maxRetries: 2,
          preflightCommitment: 'processed',
        });

        executionLog.debug(
          { signature, attempt, lastValidBlockHeight },
          'Transaction sent, awaiting confirmation',
        );

        // Build the confirmation strategy
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const confirmStrategy: TransactionConfirmationStrategy = {
          signature,
          blockhash,
          lastValidBlockHeight,
        };

        const confirmResult = await Promise.race([
          connection.confirmTransaction(confirmStrategy, 'confirmed'),
          sleep(CONFIRM_TIMEOUT_MS).then(() => ({ value: { err: 'TIMEOUT' } })),
        ]);

        if (confirmResult.value?.err) {
          const errStr = typeof confirmResult.value.err === 'string'
            ? confirmResult.value.err
            : JSON.stringify(confirmResult.value.err);

          executionLog.warn(
            { signature, error: errStr, attempt },
            'Transaction confirmation returned error',
          );

          // If it's a timeout or non-fatal error, retry
          if (attempt < MAX_RETRIES) {
            const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            executionLog.debug({ delay, nextAttempt: attempt + 1 }, 'Retrying after delay');
            await sleep(delay);
            continue;
          }

          return null;
        }

        return signature;
      } catch (err: any) {
        executionLog.warn(
          { error: err.message, attempt },
          'sendAndConfirm threw exception',
        );

        if (attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
          continue;
        }

        return null;
      }
    }

    return null;
  }

  // ═════════════════════════════════════════════════════════════════
  // PRIVATE: RATE LIMITING
  // ═════════════════════════════════════════════════════════════════

  /**
   * Enforce a minimum interval between Jupiter API calls to stay within rate limits.
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastApiCallMs;
    if (elapsed < this.minApiIntervalMs) {
      const waitMs = this.minApiIntervalMs - elapsed;
      executionLog.trace?.({ waitMs }, 'Rate limiting: waiting before next API call');
      await sleep(waitMs);
    }
    this.lastApiCallMs = Date.now();
  }

  // ═════════════════════════════════════════════════════════════════
  // PRIVATE: HELPERS
  // ═════════════════════════════════════════════════════════════════

  /**
   * Construct a failure ExecutionResult.
   */
  private failResult(error: string, startMs: number): ExecutionResult {
    const elapsed = Date.now() - startMs;
    executionLog.warn({ error, elapsedMs: elapsed }, 'Execution failed');

    return {
      success: false,
      profitSol: 0,
      profitUsd: 0,
      signatures: [],
      gasUsed: 0,
      jitoTip: 0,
      error,
      stuckToken: null,
      executionTimeMs: elapsed,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// MODULE-LEVEL HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * fetch() wrapper with an AbortController-based timeout.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Promise-based sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
