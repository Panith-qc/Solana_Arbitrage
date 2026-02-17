// JITO BUNDLE EXECUTOR
// Submits transaction bundles to Jito block engines for MEV-protected atomic execution.
// Supports failover across multiple Jito endpoints and bundle status polling.

import { executionLog } from './logger.js';
import { JITO_BLOCK_ENGINES } from './config.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type BundleStatus =
  | 'pending'
  | 'landed'
  | 'failed'
  | 'dropped'
  | 'invalid'
  | 'unknown';

export interface JitoBundleResult {
  bundleId: string | null;
  status: BundleStatus;
  landedSlot: number | null;
  error: string | null;
  /** Which block engine endpoint successfully accepted the bundle */
  endpoint: string | null;
  /** Round-trip latency for the submission call in ms */
  submissionLatencyMs: number;
}

export interface BundleStatusResponse {
  bundleId: string;
  status: BundleStatus;
  landedSlot: number | null;
  error: string | null;
}

interface JitoJsonRpcResponse<T = any> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

/** Timeout for a single Jito HTTP request */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long to poll for bundle status before giving up */
const STATUS_POLL_TIMEOUT_MS = 30_000;

/** Interval between status poll attempts */
const STATUS_POLL_INTERVAL_MS = 2_000;

// ═══════════════════════════════════════════════════════════════════
// BUNDLE SUBMISSION
// ═══════════════════════════════════════════════════════════════════

/**
 * Submit a bundle of base64-encoded signed transactions to a Jito block engine.
 * Tries each configured block engine in order until one accepts the bundle.
 *
 * @param transactions   Array of base64-encoded serialized VersionedTransactions
 * @param tipLamports    The tip amount embedded in the last transaction (for logging)
 * @returns              JitoBundleResult with the bundle ID and submission status
 */
export async function submitBundle(
  transactions: string[],
  tipLamports: number,
): Promise<JitoBundleResult> {
  if (transactions.length === 0) {
    return {
      bundleId: null,
      status: 'invalid',
      landedSlot: null,
      error: 'Empty transaction array',
      endpoint: null,
      submissionLatencyMs: 0,
    };
  }

  if (transactions.length > 5) {
    return {
      bundleId: null,
      status: 'invalid',
      landedSlot: null,
      error: `Bundle contains ${transactions.length} transactions; Jito maximum is 5`,
      endpoint: null,
      submissionLatencyMs: 0,
    };
  }

  const errors: string[] = [];

  for (const engine of JITO_BLOCK_ENGINES) {
    const startMs = Date.now();
    try {
      const result = await sendBundleToEngine(engine, transactions);
      const latency = Date.now() - startMs;

      if (result.bundleId) {
        executionLog.info(
          {
            bundleId: result.bundleId,
            engine,
            txCount: transactions.length,
            tipLamports,
            latencyMs: latency,
          },
          'Bundle submitted successfully to Jito',
        );

        return {
          bundleId: result.bundleId,
          status: 'pending',
          landedSlot: null,
          error: null,
          endpoint: engine,
          submissionLatencyMs: latency,
        };
      }

      // Engine returned an error in the JSON-RPC response
      const errMsg = result.error || 'Unknown Jito error';
      errors.push(`${engine}: ${errMsg}`);
      executionLog.warn(
        { engine, error: errMsg, latencyMs: latency },
        'Jito block engine rejected bundle, trying next',
      );
    } catch (err: any) {
      const latency = Date.now() - startMs;
      const errMsg = err?.message || String(err);
      errors.push(`${engine}: ${errMsg}`);
      executionLog.warn(
        { engine, error: errMsg, latencyMs: latency },
        'Jito block engine request failed, trying next',
      );
    }
  }

  // All engines failed
  const combinedError = `All Jito block engines failed: ${errors.join(' | ')}`;
  executionLog.error({ errors }, 'Bundle submission failed on all Jito endpoints');

  return {
    bundleId: null,
    status: 'failed',
    landedSlot: null,
    error: combinedError,
    endpoint: null,
    submissionLatencyMs: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════
// BUNDLE STATUS
// ═══════════════════════════════════════════════════════════════════

/**
 * Poll the Jito block engine for the status of a previously submitted bundle.
 *
 * @param bundleId  The bundle ID returned from submitBundle
 * @param engine    The block engine endpoint that accepted the bundle
 * @returns         Current status of the bundle
 */
export async function getBundleStatus(
  bundleId: string,
  engine?: string,
): Promise<BundleStatusResponse> {
  const endpoint = engine || JITO_BLOCK_ENGINES[0];

  try {
    const response = await fetchWithTimeout(
      `${endpoint}/api/v1/bundles`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
      },
      REQUEST_TIMEOUT_MS,
    );

    const json = (await response.json()) as JitoJsonRpcResponse;

    if (json.error) {
      return {
        bundleId,
        status: 'unknown',
        landedSlot: null,
        error: json.error.message,
      };
    }

    // The result is an array of status objects; we care about the first one
    const statuses = json.result?.value || json.result || [];
    const bundleStatus = Array.isArray(statuses) ? statuses[0] : statuses;

    if (!bundleStatus) {
      return {
        bundleId,
        status: 'unknown',
        landedSlot: null,
        error: null,
      };
    }

    const normalizedStatus = normalizeBundleStatus(
      bundleStatus.confirmation_status || bundleStatus.status || 'unknown',
    );

    return {
      bundleId,
      status: normalizedStatus,
      landedSlot: bundleStatus.slot || bundleStatus.landed_slot || null,
      error: bundleStatus.err ? JSON.stringify(bundleStatus.err) : null,
    };
  } catch (err: any) {
    executionLog.warn(
      { bundleId, engine: endpoint, error: err.message },
      'Failed to fetch bundle status',
    );

    return {
      bundleId,
      status: 'unknown',
      landedSlot: null,
      error: err.message,
    };
  }
}

/**
 * Poll bundle status until it reaches a terminal state or times out.
 *
 * @param bundleId  The bundle ID to track
 * @param engine    The block engine that accepted the bundle
 * @returns         Final bundle status
 */
export async function waitForBundleLanding(
  bundleId: string,
  engine?: string,
): Promise<BundleStatusResponse> {
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

  executionLog.debug({ bundleId, timeoutMs: STATUS_POLL_TIMEOUT_MS }, 'Waiting for bundle to land');

  while (Date.now() < deadline) {
    const status = await getBundleStatus(bundleId, engine);

    if (status.status === 'landed') {
      executionLog.info(
        { bundleId, landedSlot: status.landedSlot },
        'Bundle landed on-chain',
      );
      return status;
    }

    if (status.status === 'failed' || status.status === 'dropped' || status.status === 'invalid') {
      executionLog.warn(
        { bundleId, status: status.status, error: status.error },
        'Bundle reached terminal failure state',
      );
      return status;
    }

    // Still pending -- wait before next poll
    await sleep(STATUS_POLL_INTERVAL_MS);
  }

  executionLog.warn(
    { bundleId, timeoutMs: STATUS_POLL_TIMEOUT_MS },
    'Bundle status polling timed out',
  );

  return {
    bundleId,
    status: 'unknown',
    landedSlot: null,
    error: `Status polling timed out after ${STATUS_POLL_TIMEOUT_MS}ms`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SPECIALIZED BUNDLE TYPES
// ═══════════════════════════════════════════════════════════════════

/**
 * Submit a sandwich bundle: front-run TX, victim TX, back-run TX.
 * All three must execute atomically in the same slot.
 *
 * @param frontRunTx  Base64-encoded front-run transaction
 * @param victimTx    Base64-encoded victim transaction
 * @param backRunTx   Base64-encoded back-run transaction
 * @param tipLamports Jito tip embedded in backRunTx
 * @returns           JitoBundleResult
 */
export async function submitSandwichBundle(
  frontRunTx: string,
  victimTx: string,
  backRunTx: string,
  tipLamports: number,
): Promise<JitoBundleResult> {
  executionLog.info(
    { tipLamports, txCount: 3 },
    'Submitting sandwich bundle (front-run + victim + back-run)',
  );

  return submitBundle([frontRunTx, victimTx, backRunTx], tipLamports);
}

/**
 * Submit an arbitrage bundle: one or more transactions that must execute atomically.
 * Commonly used for cyclic arb (SOL -> Token -> SOL) or cross-DEX arb.
 *
 * @param transactions  Array of base64-encoded signed transactions
 * @param tipLamports   Jito tip embedded in the last transaction
 * @returns             JitoBundleResult
 */
export async function submitArbitrageBundle(
  transactions: string[],
  tipLamports: number,
): Promise<JitoBundleResult> {
  executionLog.info(
    { tipLamports, txCount: transactions.length },
    'Submitting arbitrage bundle',
  );

  return submitBundle(transactions, tipLamports);
}

// ═══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Send a bundle to a specific Jito block engine via JSON-RPC.
 */
async function sendBundleToEngine(
  engine: string,
  transactions: string[],
): Promise<{ bundleId: string | null; error: string | null }> {
  const response = await fetchWithTimeout(
    `${engine}/api/v1/bundles`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [transactions],
      }),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unable to read response body');
    return {
      bundleId: null,
      error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  const json = (await response.json()) as JitoJsonRpcResponse<string>;

  if (json.error) {
    return {
      bundleId: null,
      error: `JSON-RPC error ${json.error.code}: ${json.error.message}`,
    };
  }

  // result is the bundle ID string
  return {
    bundleId: json.result || null,
    error: json.result ? null : 'No bundle ID in response',
  };
}

/**
 * Normalize various Jito status strings to our BundleStatus union.
 */
function normalizeBundleStatus(raw: string): BundleStatus {
  const lower = raw.toLowerCase();
  if (lower === 'landed' || lower === 'confirmed' || lower === 'finalized') return 'landed';
  if (lower === 'pending' || lower === 'processed') return 'pending';
  if (lower === 'failed') return 'failed';
  if (lower === 'dropped') return 'dropped';
  if (lower === 'invalid') return 'invalid';
  return 'unknown';
}

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
