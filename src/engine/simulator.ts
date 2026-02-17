// TRANSACTION SIMULATOR
// Pre-flight simulation to validate transactions before on-chain submission.
// Checks for errors, compute budget overruns, and insufficient funds.

import {
  Connection,
  VersionedTransaction,
  SimulatedTransactionResponse,
} from '@solana/web3.js';
import { executionLog } from './logger.js';
import { LAMPORTS_PER_SOL } from './config.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface SimulationResult {
  success: boolean;
  unitsConsumed: number;
  logs: string[];
  error: string | null;
  /** Raw Solana simulation response for downstream inspection */
  rawResponse: SimulatedTransactionResponse | null;
}

export interface ProfitabilityResult {
  profitable: boolean;
  expectedProfitLamports: number;
  expectedProfitSol: number;
  /** Estimated gas cost in lamports (derived from simulated CU) */
  estimatedGasCostLamports: number;
  netProfitLamports: number;
  netProfitSol: number;
  reason: string;
}

// Known simulation error patterns that indicate specific failure modes
const SIMULATION_ERROR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /insufficient funds/i, label: 'INSUFFICIENT_FUNDS' },
  { pattern: /insufficient lamports/i, label: 'INSUFFICIENT_LAMPORTS' },
  { pattern: /Compute budget exceeded/i, label: 'COMPUTE_BUDGET_EXCEEDED' },
  { pattern: /custom program error/i, label: 'CUSTOM_PROGRAM_ERROR' },
  { pattern: /Transaction too large/i, label: 'TRANSACTION_TOO_LARGE' },
  { pattern: /Blockhash not found/i, label: 'BLOCKHASH_NOT_FOUND' },
  { pattern: /AccountNotFound/i, label: 'ACCOUNT_NOT_FOUND' },
  { pattern: /invalid account data/i, label: 'INVALID_ACCOUNT_DATA' },
  { pattern: /Program failed to complete/i, label: 'PROGRAM_FAILED' },
  { pattern: /SlippageToleranceExceeded/i, label: 'SLIPPAGE_EXCEEDED' },
  { pattern: /0x1771/i, label: 'SLIPPAGE_EXCEEDED' }, // Jupiter slippage error code
  { pattern: /0x1786/i, label: 'SWAP_AMOUNT_MISMATCH' },
];

// ═══════════════════════════════════════════════════════════════════
// CORE SIMULATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Simulate a versioned transaction against the cluster to detect errors before sending.
 * Returns a structured result with compute units consumed, logs, and any error detail.
 */
export async function simulateTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<SimulationResult> {
  const startMs = Date.now();

  try {
    const response = await connection.simulateTransaction(transaction, {
      sigVerify: false, // Skip signature verification for speed
      replaceRecentBlockhash: true, // Use fresh blockhash to avoid stale-hash false negatives
      commitment: 'processed',
    });

    const elapsed = Date.now() - startMs;
    const sim = response.value;

    // Check for explicit simulation error
    if (sim.err) {
      const errorStr = typeof sim.err === 'string'
        ? sim.err
        : JSON.stringify(sim.err);

      const classifiedLabel = classifyError(errorStr, sim.logs || []);

      executionLog.warn(
        {
          error: errorStr,
          classification: classifiedLabel,
          unitsConsumed: sim.unitsConsumed ?? 0,
          elapsedMs: elapsed,
          logsTail: (sim.logs || []).slice(-5),
        },
        'Transaction simulation FAILED',
      );

      return {
        success: false,
        unitsConsumed: sim.unitsConsumed ?? 0,
        logs: sim.logs || [],
        error: `${classifiedLabel}: ${errorStr}`,
        rawResponse: sim,
      };
    }

    // Check for compute budget issues in logs even when err is null
    const logErrors = extractLogErrors(sim.logs || []);
    if (logErrors.length > 0) {
      executionLog.warn(
        { logErrors, elapsedMs: elapsed },
        'Simulation succeeded but logs contain warnings',
      );
    }

    executionLog.debug(
      {
        unitsConsumed: sim.unitsConsumed ?? 0,
        elapsedMs: elapsed,
        logCount: (sim.logs || []).length,
      },
      'Transaction simulation PASSED',
    );

    return {
      success: true,
      unitsConsumed: sim.unitsConsumed ?? 0,
      logs: sim.logs || [],
      error: null,
      rawResponse: sim,
    };
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    const message = err?.message || String(err);

    executionLog.error(
      { error: message, elapsedMs: elapsed },
      'Transaction simulation threw an exception',
    );

    return {
      success: false,
      unitsConsumed: 0,
      logs: [],
      error: `SIMULATION_EXCEPTION: ${message}`,
      rawResponse: null,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// PROFITABILITY CHECK
// ═══════════════════════════════════════════════════════════════════

/**
 * Estimate the micro-economics of a swap: whether the expected output minus
 * gas and fees leaves a positive net profit.
 *
 * @param connection   Active Solana RPC connection (unused for pure math but available for balance checks)
 * @param inputLamports         The SOL amount being sent into the swap (in lamports)
 * @param expectedOutputLamports The SOL amount the quote promises back (in lamports)
 * @param quote                  Arbitrary quote metadata for logging context
 */
export async function simulateSwapProfitability(
  connection: Connection,
  inputLamports: number,
  expectedOutputLamports: number,
  quote: Record<string, any> = {},
): Promise<ProfitabilityResult> {
  // Estimate gas cost: typical Jupiter swap uses 200k-400k CU.
  // At the current priority fee market we approximate 5000 lamports per 200k CU.
  // This is a conservative upper-bound estimate; the real cost is often lower.
  const ESTIMATED_CU = 400_000;
  const MICRO_LAMPORTS_PER_CU = 25; // ~25 micro-lamports per CU is a reasonable priority fee
  const estimatedGasCostLamports = Math.ceil((ESTIMATED_CU * MICRO_LAMPORTS_PER_CU) / 1_000_000) + 5_000; // base fee

  const grossProfitLamports = expectedOutputLamports - inputLamports;
  const netProfitLamports = grossProfitLamports - estimatedGasCostLamports;

  const profitable = netProfitLamports > 0;

  const result: ProfitabilityResult = {
    profitable,
    expectedProfitLamports: grossProfitLamports,
    expectedProfitSol: grossProfitLamports / LAMPORTS_PER_SOL,
    estimatedGasCostLamports,
    netProfitLamports,
    netProfitSol: netProfitLamports / LAMPORTS_PER_SOL,
    reason: profitable
      ? `Net profit ${(netProfitLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL after estimated gas`
      : netProfitLamports === 0
        ? 'Break-even after estimated gas'
        : `Net loss ${(Math.abs(netProfitLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL after estimated gas`,
  };

  executionLog.debug(
    {
      inputLamports,
      expectedOutputLamports,
      grossProfitLamports,
      estimatedGasCostLamports,
      netProfitLamports,
      profitable,
      quoteId: quote.id || quote.routePlan?.[0]?.ammKey || 'unknown',
    },
    profitable ? 'Swap profitability: PROFITABLE' : 'Swap profitability: NOT PROFITABLE',
  );

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Classify an error string against known patterns to give a human-readable label.
 */
function classifyError(errorStr: string, logs: string[]): string {
  // Check the error string itself
  for (const { pattern, label } of SIMULATION_ERROR_PATTERNS) {
    if (pattern.test(errorStr)) return label;
  }

  // Also scan logs for known patterns
  const combinedLogs = logs.join('\n');
  for (const { pattern, label } of SIMULATION_ERROR_PATTERNS) {
    if (pattern.test(combinedLogs)) return label;
  }

  return 'UNKNOWN_SIMULATION_ERROR';
}

/**
 * Extract warning / error lines from simulation logs.
 */
function extractLogErrors(logs: string[]): string[] {
  return logs.filter(
    (line) =>
      /error/i.test(line) ||
      /failed/i.test(line) ||
      /panicked/i.test(line) ||
      /exceeded/i.test(line),
  );
}
