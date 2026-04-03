// BACKGROUND KEEPERS — Phase 2
// Four always-on background processes that feed the hot path with fresh data.
// Module-level state: hot path reads these variables directly, zero async overhead.
//
// Process 1: Blockhash Keeper — getLatestBlockhash every 2s
// Process 2: Priority Fee Keeper — getPriorityFeeEstimate every 10s
// Process 3: WebSocket Health Monitor — ping every 30s, reconnect if dead, pause if >3 disconnects in 5 min
// Process 4: Confirmation Tracker — queue of sent sigs, batch getSignatureStatuses every 500ms
//
// CODING STANDARDS:
// - All on-chain amounts are BigInt
// - Every async function has try/catch with context
// - Hot path NEVER awaits these — reads module-level variables only
// - Confirmation tracker NEVER blocks the caller (enqueue returns void)

import { Connection } from '@solana/web3.js';
import { engineLog, executionLog } from './logger.js';
import { LAMPORTS_PER_SOL } from './config.js';

// ═══════════════════════════════════════════════════════════════
// MODULE-LEVEL STATE — read by hot path with zero overhead
// ═══════════════════════════════════════════════════════════════

/** Latest blockhash, refreshed every 2s. Hot path reads this directly. */
let cachedBlockhash: string = '';

/** Unix ms when cachedBlockhash was last refreshed. */
let cachedBlockhashTs: number = 0;

/** Priority fee in micro-lamports, refreshed every 10s. Hot path reads this directly. */
let cachedPriorityFee: number = 10_000;

/** Unix ms when cachedPriorityFee was last refreshed. */
let cachedPriorityFeeTs: number = 0;

// ═══════════════════════════════════════════════════════════════
// PUBLIC GETTERS — hot path uses these, zero async overhead
// ═══════════════════════════════════════════════════════════════

/**
 * Get the cached blockhash for transaction building.
 * // Example trace:
 * //   hot path calls getCachedBlockhash()
 * //   returns "5Wjf3K...abc" (string, never empty after keeper starts)
 * //   age = Date.now() - getCachedBlockhashAge() → ~800ms
 */
export function getCachedBlockhash(): string {
  return cachedBlockhash;
}

/** Age in ms since last blockhash refresh. Stale if > 4000ms. */
export function getCachedBlockhashAge(): number {
  return cachedBlockhashTs > 0 ? Date.now() - cachedBlockhashTs : Infinity;
}

/**
 * Get the cached priority fee in micro-lamports.
 * // Example trace:
 * //   hot path calls getCachedPriorityFee()
 * //   returns 25000 (number, micro-lamports)
 * //   used directly in ComputeBudgetProgram.setComputeUnitPrice
 */
export function getCachedPriorityFee(): number {
  return cachedPriorityFee;
}

/** Age in ms since last priority fee refresh. Stale if > 20000ms. */
export function getCachedPriorityFeeAge(): number {
  return cachedPriorityFeeTs > 0 ? Date.now() - cachedPriorityFeeTs : Infinity;
}

// ═══════════════════════════════════════════════════════════════
// CONFIRMATION TRACKER — queue + batch poll
// ═══════════════════════════════════════════════════════════════

/** Metadata attached to a pending signature for callback reporting */
export interface PendingSignature {
  signature: string;
  enqueuedAt: number;
  expectedProfitLamports: bigint;
  tipLamports: bigint;
  buyPool: string;
  sellPool: string;
  solPrice: number;
  preBalanceLamports: bigint | null;
}

/** Result reported via callback after confirmation or timeout */
export interface ConfirmationResult {
  signature: string;
  status: 'confirmed' | 'reverted' | 'dropped';
  /** Actual profit from balance delta, or expected if balance unavailable */
  profitSol: number;
  profitUsd: number;
  errorCode: number | null;
  errorLabel: string | null;
  latencyMs: number;
  buyPool: string;
  sellPool: string;
}

export type ConfirmationCallback = (result: ConfirmationResult) => void;

/** Queue of signatures waiting for confirmation */
const pendingQueue: PendingSignature[] = [];

/** Registered callbacks for confirmation results */
const confirmCallbacks: ConfirmationCallback[] = [];

/** Max time to wait for confirmation before marking as dropped (30s) */
const CONFIRM_DEADLINE_MS = 30_000;

/** Batch poll interval — 500ms as specified */
const CONFIRM_POLL_INTERVAL_MS = 500;

/** Max signatures per batch (RPC supports up to 256) */
const MAX_BATCH_SIZE = 20;

/**
 * Enqueue a sent signature for background confirmation tracking.
 * Returns immediately — NEVER blocks the hot path.
 *
 * // Example trace:
 * //   hot path sends TX → gets signature "4xYz..."
 * //   calls enqueueSignature({ signature: "4xYz...", ... })
 * //   returns void immediately
 * //   confirmation tracker picks it up in next 500ms poll
 * //   callback fires with { status: 'confirmed', profitSol: 0.0012 }
 */
export function enqueueSignature(pending: PendingSignature): void {
  pendingQueue.push(pending);
  executionLog.debug(
    { signature: pending.signature, queueSize: pendingQueue.length },
    'Confirmation tracker: signature enqueued',
  );
}

/**
 * Register a callback for confirmation results.
 * Called from botEngine at startup.
 */
export function onConfirmation(cb: ConfirmationCallback): void {
  confirmCallbacks.push(cb);
}

/** Get current queue depth (for metrics) */
export function getPendingCount(): number {
  return pendingQueue.length;
}

// ═══════════════════════════════════════════════════════════════
// WS HEALTH MONITOR STATE
// ═══════════════════════════════════════════════════════════════

/** Timestamps of recent WS disconnections (for pause logic) */
let wsDisconnectTimestamps: number[] = [];

/** Whether WS monitoring is paused due to repeated failures */
let wsPaused = false;

/** Unix ms when WS was paused — used for auto-recovery after cooldown */
let wsPausedAt: number = 0;

/** Auto-recovery cooldown: 5 min after pause, attempt reconnect */
const WS_PAUSE_COOLDOWN_MS = 5 * 60 * 1000;

/** Public: check if WS is paused */
export function isWsPaused(): boolean {
  return wsPaused;
}

/** Public: reset WS pause (called after manual restart or auto-recovery) */
export function resetWsPause(): void {
  wsPaused = false;
  wsPausedAt = 0;
  wsDisconnectTimestamps = [];
}

// ═══════════════════════════════════════════════════════════════
// KEEPER TIMERS
// ═══════════════════════════════════════════════════════════════

let blockhashTimer: ReturnType<typeof setInterval> | null = null;
let priorityFeeTimer: ReturnType<typeof setInterval> | null = null;
let confirmTimer: ReturnType<typeof setInterval> | null = null;
let wsHealthTimer: ReturnType<typeof setInterval> | null = null;

/** Shared connection ref, set by startKeepers */
let keeperConnection: Connection | null = null;

/** RPC URL for priority fee API (separate fetch, not via Connection) */
let keeperRpcUrl: string = '';

/** Pool monitor ref for WS health checks */
let poolMonitorRef: {
  isWsAlive: () => boolean;
  reconnectSubscriptions?: () => Promise<void>;
} | null = null;

// ═══════════════════════════════════════════════════════════════
// PROCESS 1: BLOCKHASH KEEPER
// ═══════════════════════════════════════════════════════════════

/**
 * Refresh cached blockhash from RPC.
 * Called every 2s by setInterval. First call awaited at startup.
 * On error: keeps the old value (don't clear — stale blockhash is
 * better than no blockhash, TX will just fail with BlockhashNotFound).
 *
 * // Example trace:
 * //   refreshBlockhash() called at T=0
 * //   RPC returns { blockhash: "5Wjf3K..." }
 * //   cachedBlockhash = "5Wjf3K...", cachedBlockhashTs = 1712000000000
 * //   next call at T=2000
 * //   RPC error → cachedBlockhash stays "5Wjf3K..." (age now 2s)
 */
async function refreshBlockhash(): Promise<void> {
  if (!keeperConnection) return;
  try {
    const { blockhash } = await keeperConnection.getLatestBlockhash('confirmed');
    cachedBlockhash = blockhash;
    cachedBlockhashTs = Date.now();
  } catch (err: any) {
    // Don't clear — stale blockhash is better than no blockhash
    engineLog.debug({ err: err?.message }, 'Blockhash keeper: refresh failed — keeping stale value');
  }
}

// ═══════════════════════════════════════════════════════════════
// PROCESS 2: PRIORITY FEE KEEPER
// ═══════════════════════════════════════════════════════════════

/**
 * Refresh cached priority fee from Helius getPriorityFeeEstimate.
 * Called every 10s. Uses Raydium AMM V4 program key as account hint
 * for more accurate fee estimation.
 *
 * // Example trace:
 * //   refreshPriorityFee() called
 * //   POST to Helius RPC: { method: "getPriorityFeeEstimate", params: [{ ... }] }
 * //   response: { result: { priorityFeeEstimate: 32000 } }
 * //   cachedPriorityFee = clamp(32000, 1000, 500000) = 32000
 * //   on error → cachedPriorityFee stays at previous value
 */
async function refreshPriorityFee(): Promise<void> {
  if (!keeperRpcUrl) return;
  try {
    const response = await fetch(keeperRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'keeper-priority-fee',
        method: 'getPriorityFeeEstimate',
        params: [{
          // Use Raydium AMM V4 program as account hint for DEX-relevant fee estimate
          accountKeys: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
          options: { priorityLevel: 'High' },
        }],
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await response.json() as any;
    if (data?.result?.priorityFeeEstimate) {
      const raw = Math.ceil(data.result.priorityFeeEstimate);
      // Clamp between 1,000 and 500,000 micro-lamports
      cachedPriorityFee = Math.max(1_000, Math.min(500_000, raw));
      cachedPriorityFeeTs = Date.now();
      engineLog.debug(
        { priorityFeeMicroLamports: cachedPriorityFee },
        'Priority fee keeper: refreshed',
      );
    }
  } catch (err: any) {
    // Keep stale value — better than no value
    engineLog.debug({ err: err?.message }, 'Priority fee keeper: refresh failed — keeping stale value');
  }
}

// ═══════════════════════════════════════════════════════════════
// PROCESS 3: WEBSOCKET HEALTH MONITOR
// ═══════════════════════════════════════════════════════════════

/**
 * Check WebSocket health every 30s.
 * If dead (no events in 60s), the poolMonitor handles its own reconnection.
 * This keeper tracks disconnect frequency: if >3 disconnects in 5 min, pause WS.
 * Pausing prevents reconnection storms that burn RPC credits.
 * Auto-recovery: after 5 min cooldown, unpause and clear disconnect history
 * so poolMonitor can attempt reconnection with a clean slate.
 *
 * // Example trace:
 * //   checkWsHealth() at T=0 — poolMonitor.isWsAlive() → true → no action
 * //   checkWsHealth() at T=30s — isWsAlive() → false → record disconnect at T=30
 * //   checkWsHealth() at T=60s — isWsAlive() → false → record disconnect at T=60
 * //   checkWsHealth() at T=90s — isWsAlive() → false → record disconnect at T=90
 * //   3 disconnects in 5 min → wsPaused = true, wsPausedAt = T=90
 * //   checkWsHealth() at T=390s (5 min later) — wsPaused && cooldown expired
 * //     → resetWsPause(), log "auto-recovery, unpausing WS"
 * //   poolMonitor resumes normal reconnection attempts
 * //   if WS comes back alive → next check sees alive=true, no action
 * //   if WS fails again → 3 more disconnects → re-pause for another 5 min
 */
function checkWsHealth(): void {
  if (!poolMonitorRef) return;

  const now = Date.now();
  const alive = poolMonitorRef.isWsAlive();

  // If currently paused, check for auto-recovery after cooldown
  if (wsPaused) {
    if (alive) {
      // WS recovered on its own while we were paused
      engineLog.info('WS Health Monitor: WebSocket recovered while paused — unpausing');
      resetWsPause();
      return;
    }
    if (wsPausedAt > 0 && (now - wsPausedAt) >= WS_PAUSE_COOLDOWN_MS) {
      // Cooldown expired — unpause so poolMonitor can retry
      engineLog.info(
        { pausedForMs: now - wsPausedAt },
        'WS Health Monitor: 5 min cooldown expired — unpausing, poolMonitor may retry',
      );
      resetWsPause();
      // Don't return — fall through to normal check so we start fresh tracking
    } else {
      return; // Still in cooldown, do nothing
    }
  }

  if (alive) return; // WS is healthy, nothing to do

  // Record disconnect
  wsDisconnectTimestamps.push(now);

  // Prune disconnects older than 5 min
  const fiveMinAgo = now - 5 * 60 * 1000;
  wsDisconnectTimestamps = wsDisconnectTimestamps.filter(ts => ts >= fiveMinAgo);

  if (wsDisconnectTimestamps.length > 3) {
    wsPaused = true;
    wsPausedAt = now;
    engineLog.warn(
      { disconnectsIn5Min: wsDisconnectTimestamps.length },
      'WS Health Monitor: >3 disconnects in 5 min — PAUSING for 5 min cooldown. Poll-only mode active.',
    );
  } else {
    engineLog.info(
      { disconnectsIn5Min: wsDisconnectTimestamps.length },
      'WS Health Monitor: WebSocket not alive — poolMonitor will handle reconnection',
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// PROCESS 4: CONFIRMATION TRACKER
// ═══════════════════════════════════════════════════════════════

/**
 * Batch-poll getSignatureStatuses for all pending signatures.
 * Called every 500ms. Processes up to MAX_BATCH_SIZE per tick.
 * Confirmed/reverted/dropped sigs are removed from queue and reported via callbacks.
 *
 * // Example trace:
 * //   pendingQueue has 3 signatures: [sig1(age=200ms), sig2(age=800ms), sig3(age=31000ms)]
 * //   batch = [sig1, sig2, sig3]
 * //   RPC getSignatureStatuses → [null, {confirmed, err:null}, null]
 * //   sig1: status null, age < 30s → keep in queue
 * //   sig2: confirmed, no error → measure profit, report via callback, remove
 * //   sig3: status null, age > 30s → report as 'dropped', remove
 */
async function pollConfirmations(): Promise<void> {
  if (pendingQueue.length === 0 || !keeperConnection) return;

  const now = Date.now();

  // Take a batch (up to MAX_BATCH_SIZE)
  const batch = pendingQueue.slice(0, MAX_BATCH_SIZE);
  const signatures = batch.map(p => p.signature);

  try {
    const statuses = await keeperConnection.getSignatureStatuses(signatures);

    // Process results in reverse so splice indices stay valid
    const toRemove: number[] = [];

    for (let i = 0; i < batch.length; i++) {
      const pending = batch[i];
      const status = statuses?.value?.[i];
      const age = now - pending.enqueuedAt;

      if (status) {
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          if (status.err) {
            // TX confirmed but reverted on-chain
            const errStr = JSON.stringify(status.err);
            const code = extractErrorCode(errStr);
            toRemove.push(i);
            reportConfirmation(pending, 'reverted', 0, code, errorLabel(code), age);
          } else {
            // TX confirmed successfully — measure profit
            toRemove.push(i);
            const profitSol = await measureProfit(pending);
            reportConfirmation(pending, 'confirmed', profitSol, null, null, age);
          }
        }
        // else: status exists but not confirmed yet — keep waiting
      } else if (age > CONFIRM_DEADLINE_MS) {
        // No status after 30s — dropped
        toRemove.push(i);
        reportConfirmation(pending, 'dropped', 0, null, null, age);
      }
      // else: no status yet, age < 30s — keep in queue
    }

    // Remove processed entries from queue (reverse order to preserve indices)
    for (let j = toRemove.length - 1; j >= 0; j--) {
      pendingQueue.splice(toRemove[j], 1);
    }
  } catch (err: any) {
    executionLog.debug(
      { err: err?.message, batchSize: batch.length },
      'Confirmation tracker: batch poll failed',
    );
  }
}

/**
 * Measure actual profit from balance delta after confirmation.
 * Fetches post-balance and compares to pre-balance.
 * Returns profit in SOL. Falls back to expected profit if balance unavailable.
 *
 * // Example trace:
 * //   pending.preBalanceLamports = 10_000_000_000n (10 SOL)
 * //   getBalance() → 10.0015 SOL → 10_001_500_000 lamports
 * //   profit = 10_001_500_000 - 10_000_000_000 = 1_500_000 lamports = 0.0015 SOL
 */
async function measureProfit(pending: PendingSignature): Promise<number> {
  if (pending.preBalanceLamports === null || !keeperConnection) {
    return Number(pending.expectedProfitLamports) / LAMPORTS_PER_SOL;
  }

  try {
    // Brief delay for balance to settle on-chain
    await sleep(300);
    const wallet = await findWalletPubkey();
    if (!wallet) return Number(pending.expectedProfitLamports) / LAMPORTS_PER_SOL;

    const postBalanceLamports = BigInt(await keeperConnection.getBalance(wallet));
    const profitLamports = postBalanceLamports - pending.preBalanceLamports;
    const profitSol = Number(profitLamports) / LAMPORTS_PER_SOL;

    executionLog.info(
      {
        signature: pending.signature,
        preBalanceSol: (Number(pending.preBalanceLamports) / LAMPORTS_PER_SOL).toFixed(4),
        postBalanceSol: (Number(postBalanceLamports) / LAMPORTS_PER_SOL).toFixed(4),
        actualProfitSol: profitSol.toFixed(6),
        expectedProfitSol: (Number(pending.expectedProfitLamports) / LAMPORTS_PER_SOL).toFixed(6),
      },
      'Confirmation tracker: profit measured from balance delta',
    );

    return profitSol;
  } catch (err: any) {
    executionLog.debug(
      { err: err?.message, signature: pending.signature },
      'Confirmation tracker: post-balance fetch failed — using expected profit',
    );
    return Number(pending.expectedProfitLamports) / LAMPORTS_PER_SOL;
  }
}

/** Report confirmation result to all registered callbacks */
function reportConfirmation(
  pending: PendingSignature,
  status: 'confirmed' | 'reverted' | 'dropped',
  profitSol: number,
  errorCode: number | null,
  errLabel: string | null,
  latencyMs: number,
): void {
  const result: ConfirmationResult = {
    signature: pending.signature,
    status,
    profitSol,
    profitUsd: profitSol * pending.solPrice,
    errorCode,
    errorLabel: errLabel,
    latencyMs,
    buyPool: pending.buyPool,
    sellPool: pending.sellPool,
  };

  const logFn = status === 'confirmed' ? executionLog.info.bind(executionLog)
    : executionLog.warn.bind(executionLog);

  logFn(
    {
      signature: pending.signature,
      status,
      profitSol: profitSol.toFixed(6),
      errorCode,
      latencyMs,
      buyPool: pending.buyPool.slice(0, 8),
      sellPool: pending.sellPool.slice(0, 8),
    },
    `Confirmation tracker: ${pending.signature.slice(0, 12)}... → ${status}`,
  );

  for (const cb of confirmCallbacks) {
    try {
      cb(result);
    } catch (err: any) {
      executionLog.warn({ err: err?.message }, 'Confirmation callback error');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// LIFECYCLE: START / STOP
// ═══════════════════════════════════════════════════════════════

/** Wallet pubkey ref — set by startKeepers, used by measureProfit */
let walletPubkeyRef: import('@solana/web3.js').PublicKey | null = null;

function findWalletPubkey(): import('@solana/web3.js').PublicKey | null {
  return walletPubkeyRef;
}

export interface KeeperDeps {
  connection: Connection;
  rpcUrl: string;
  walletPubkey: import('@solana/web3.js').PublicKey | null;
  poolMonitor?: {
    isWsAlive: () => boolean;
  };
}

/**
 * Start all 4 background keepers.
 * First blockhash fetch is awaited so hot path has a value at startup.
 *
 * // Example trace:
 * //   startKeepers({ connection, rpcUrl, walletPubkey, poolMonitor })
 * //   await refreshBlockhash() — first fetch, hot path now has blockhash
 * //   setInterval(refreshBlockhash, 2000) — process 1 running
 * //   refreshPriorityFee() — fire-and-forget first fetch
 * //   setInterval(refreshPriorityFee, 10000) — process 2 running
 * //   setInterval(checkWsHealth, 30000) — process 3 running
 * //   setInterval(pollConfirmations, 500) — process 4 running
 */
export async function startKeepers(deps: KeeperDeps): Promise<void> {
  keeperConnection = deps.connection;
  keeperRpcUrl = deps.rpcUrl;
  walletPubkeyRef = deps.walletPubkey;
  poolMonitorRef = deps.poolMonitor || null;

  // Process 1: Blockhash — await first fetch, then 2s interval
  await refreshBlockhash();
  blockhashTimer = setInterval(refreshBlockhash, 2_000);
  engineLog.info({ blockhash: cachedBlockhash.slice(0, 12) + '...' }, 'Keeper 1: Blockhash started (2s interval)');

  // Process 2: Priority fee — fire-and-forget first fetch, then 10s interval
  refreshPriorityFee().catch(() => {});
  priorityFeeTimer = setInterval(refreshPriorityFee, 10_000);
  engineLog.info('Keeper 2: Priority fee started (10s interval)');

  // Process 3: WS health — 30s interval
  if (poolMonitorRef) {
    wsHealthTimer = setInterval(checkWsHealth, 30_000);
    engineLog.info('Keeper 3: WS health monitor started (30s interval)');
  } else {
    engineLog.info('Keeper 3: WS health monitor skipped (no poolMonitor provided)');
  }

  // Process 4: Confirmation tracker — 500ms interval
  confirmTimer = setInterval(pollConfirmations, CONFIRM_POLL_INTERVAL_MS);
  engineLog.info('Keeper 4: Confirmation tracker started (500ms batch poll)');
}

/**
 * Stop all background keepers. Clears all timers and drains the confirmation queue.
 */
export function stopKeepers(): void {
  if (blockhashTimer) { clearInterval(blockhashTimer); blockhashTimer = null; }
  if (priorityFeeTimer) { clearInterval(priorityFeeTimer); priorityFeeTimer = null; }
  if (wsHealthTimer) { clearInterval(wsHealthTimer); wsHealthTimer = null; }
  if (confirmTimer) { clearInterval(confirmTimer); confirmTimer = null; }

  // Report remaining pending signatures as dropped
  while (pendingQueue.length > 0) {
    const pending = pendingQueue.shift()!;
    reportConfirmation(pending, 'dropped', 0, null, null, Date.now() - pending.enqueuedAt);
  }

  keeperConnection = null;
  keeperRpcUrl = '';
  walletPubkeyRef = null;
  poolMonitorRef = null;
  wsPaused = false;
  wsPausedAt = 0;
  wsDisconnectTimestamps = [];

  engineLog.info('All keepers stopped');
}

/**
 * Get keeper health stats for the metrics API.
 */
export function getKeeperStats(): {
  blockhashAge: number;
  priorityFee: number;
  priorityFeeAge: number;
  pendingConfirmations: number;
  wsPaused: boolean;
  wsDisconnectsIn5Min: number;
} {
  return {
    blockhashAge: getCachedBlockhashAge(),
    priorityFee: cachedPriorityFee,
    priorityFeeAge: getCachedPriorityFeeAge(),
    pendingConfirmations: pendingQueue.length,
    wsPaused,
    wsDisconnectsIn5Min: wsDisconnectTimestamps.length,
  };
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract the innermost error code from Solana transaction error JSON.
 * // Example: '{"InstructionError":[2,{"Custom":6024}]}' → 6024
 */
function extractErrorCode(errStr: string): number | null {
  const match = errStr.match(/"Custom":(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Map common Raydium/Jupiter error codes to human-readable labels.
 */
function errorLabel(code: number | null): string | null {
  if (code === null) return null;
  const labels: Record<number, string> = {
    6000: 'LOK (pool locked)',
    6001: 'NotApproved',
    6003: 'InvalidOwner',
    6017: 'TooLittleOutputReceived',
    6022: 'InvalidTimestamp',
    6024: 'ZeroAmountSpecified',
    6028: 'LiquidityInsufficient',
    6039: 'ExceededSlippage',
    6040: 'InvalidTickArraySequence',
    6041: 'InvalidTickSpacing',
    1: 'InsufficientFunds',
  };
  return labels[code] || `UnknownError(${code})`;
}
