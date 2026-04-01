// GLOBAL JUPITER RATE GATE (with mutex)
// Singleton that serializes ALL Jupiter API calls across every strategy.
// Uses a promise-chain mutex so concurrent callers queue up properly.
// The delay is between REQUEST STARTS, not between completions.

import { engineLog } from './logger.js';

const MIN_DELAY_MS = 520; // ~1.9 req/s — just under 2 RPS free tier
let totalCalls = 0;
let total429s = 0;

// Tracks when the last request was allowed to start
let lastStartMs = 0;
// Mutex: ensures only one caller checks/updates lastStartMs at a time
let mutex: Promise<void> = Promise.resolve();

/**
 * Wait for the global Jupiter rate gate before making a call.
 * Concurrent callers are serialized — no races.
 */
export function jupiterGate(): Promise<void> {
  const ticket = mutex.then(async () => {
    const now = Date.now();
    const elapsed = now - lastStartMs;
    if (elapsed < MIN_DELAY_MS) {
      await new Promise<void>(resolve => setTimeout(resolve, MIN_DELAY_MS - elapsed));
    }
    lastStartMs = Date.now();
    totalCalls++;
  });
  mutex = ticket;
  return ticket;
}

/**
 * Record a 429 and back off globally.
 * All queued calls will wait behind this pause.
 */
export function jupiterBackoff(): Promise<void> {
  total429s++;
  engineLog.warn({ total429s, totalCalls }, 'Jupiter 429 — global 3s backoff');
  const backoff = mutex.then(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 3000));
    lastStartMs = Date.now();
  });
  mutex = backoff;
  return backoff;
}

/** Stats for dashboard / logging */
export function jupiterGateStats() {
  return { totalCalls, total429s, rps: MIN_DELAY_MS > 0 ? (1000 / MIN_DELAY_MS).toFixed(1) : '∞' };
}
