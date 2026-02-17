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

    // ── LEG 1: SOL -> TOKEN ──────────────────────────────────────

    const leg1Result = await this.executeLeg(
      connection,
      wallet,
      forwardQuote,
      forwardQuote.slippageBps,
      'LEG1_SOL_TO_TOKEN',
    );

    if (!leg1Result.success) {
      return this.failResult(`Leg 1 (SOL->Token) failed: ${leg1Result.error}`, startMs);
    }
    allSignatures.push(...leg1Result.signatures);

    // ── INTER-LEG VERIFICATION ───────────────────────────────────
    // Get a fresh reverse quote based on the token amount we actually received.
    // The forward quote's outAmount is the expected amount; the actual amount
    // may differ due to slippage. We use the expected amount as a starting point.

    const tokenAmountReceived = forwardQuote.outAmount;

    await this.rateLimit();

    executionLog.debug(
      { tokenMint, tokenAmount: tokenAmountReceived },
      'Fetching fresh reverse quote for Token -> SOL',
    );

    const reverseQuote = await this.fetchQuote(
      tokenMint,
      SOL_MINT,
      tokenAmountReceived,
      forwardQuote.slippageBps,
    );

    if (!reverseQuote) {
      // Token is stuck: we bought it but cannot get a reverse quote
      const elapsed = Date.now() - startMs;
      executionLog.error(
        { tokenSymbol, tokenMint, tokenAmount: tokenAmountReceived },
        'Failed to get reverse quote; token is stuck',
      );

      return {
        success: false,
        profitSol: 0,
        profitUsd: 0,
        signatures: allSignatures,
        gasUsed: leg1Result.gasUsed,
        jitoTip: 0,
        error: 'Reverse quote failed after Leg 1; token stuck in wallet',
        stuckToken: {
          tokenMint,
          tokenSymbol,
          estimatedBalanceLamports: parseInt(tokenAmountReceived, 10),
          reason: 'Reverse quote unavailable',
        },
        executionTimeMs: elapsed,
      };
    }

    // ── PROFITABILITY RE-CHECK ───────────────────────────────────
    const reverseOutputLamports = parseInt(reverseQuote.outAmount, 10);
    const profitCheck = await simulateSwapProfitability(
      connection,
      inputLamports,
      reverseOutputLamports,
      reverseQuote as unknown as Record<string, any>,
    );

    if (!profitCheck.profitable) {
      // Reverse swap would result in a loss -- still stuck
      const elapsed = Date.now() - startMs;
      executionLog.warn(
        {
          tokenSymbol,
          inputLamports,
          reverseOutputLamports,
          netProfitSol: profitCheck.netProfitSol,
        },
        'Reverse swap not profitable; flagging token for recovery',
      );

      return {
        success: false,
        profitSol: profitCheck.netProfitSol,
        profitUsd: profitCheck.netProfitSol * solPrice,
        signatures: allSignatures,
        gasUsed: leg1Result.gasUsed,
        jitoTip: 0,
        error: `Reverse swap not profitable (net ${profitCheck.netProfitSol.toFixed(6)} SOL)`,
        stuckToken: {
          tokenMint,
          tokenSymbol,
          estimatedBalanceLamports: parseInt(tokenAmountReceived, 10),
          reason: `Reverse swap would net ${profitCheck.netProfitSol.toFixed(6)} SOL`,
        },
        executionTimeMs: elapsed,
      };
    }

    // ── LEG 2: TOKEN -> SOL ──────────────────────────────────────

    const leg2Result = await this.executeLeg(
      connection,
      wallet,
      reverseQuote,
      reverseQuote.slippageBps,
      'LEG2_TOKEN_TO_SOL',
    );

    if (!leg2Result.success) {
      // Leg 2 failed: token is stuck
      const elapsed = Date.now() - startMs;
      executionLog.error(
        { tokenSymbol, error: leg2Result.error },
        'Leg 2 (Token->SOL) failed; token stuck',
      );

      return {
        success: false,
        profitSol: 0,
        profitUsd: 0,
        signatures: allSignatures,
        gasUsed: leg1Result.gasUsed + leg2Result.gasUsed,
        jitoTip: 0,
        error: `Leg 2 (Token->SOL) failed: ${leg2Result.error}`,
        stuckToken: {
          tokenMint,
          tokenSymbol,
          estimatedBalanceLamports: parseInt(tokenAmountReceived, 10),
          reason: `Leg 2 send/confirm failed: ${leg2Result.error}`,
        },
        executionTimeMs: elapsed,
      };
    }

    allSignatures.push(...leg2Result.signatures);

    // ── PROFIT CALCULATION ───────────────────────────────────────
    const actualOutputLamports = reverseOutputLamports; // best approximation from quote
    const grossProfitLamports = actualOutputLamports - inputLamports;
    const grossProfitSol = grossProfitLamports / LAMPORTS_PER_SOL;
    const grossProfitUsd = grossProfitSol * solPrice;
    const totalGasUsed = leg1Result.gasUsed + leg2Result.gasUsed;
    const elapsed = Date.now() - startMs;

    executionLog.info(
      {
        tokenSymbol,
        profitSol: grossProfitSol.toFixed(6),
        profitUsd: grossProfitUsd.toFixed(2),
        signatures: allSignatures,
        totalGasCU: totalGasUsed,
        elapsedMs: elapsed,
      },
      'Arbitrage cycle COMPLETED',
    );

    return {
      success: true,
      profitSol: grossProfitSol,
      profitUsd: grossProfitUsd,
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
