// GLOBAL JUPITER RATE GATE (with mutex)
// Singleton that serializes ALL Jupiter API calls across every strategy.
// Uses a promise-chain mutex so concurrent callers actually queue up
// instead of racing on a shared timestamp.

import { engineLog } from './logger.js';

const MIN_DELAY_MS = 700; // ~1.4 req/s — safe margin below 2 RPS free tier
let totalCalls = 0;
let total429s = 0;

// Promise-chain mutex: each caller waits for the previous one to finish + delay
let chain: Promise<void> = Promise.resolve();

/**
 * Wait for the global Jupiter rate gate before making a call.
 * Concurrent callers are serialized through a promise chain — no races.
 */
export function jupiterGate(): Promise<void> {
  const next = chain.then(() => {
    totalCalls++;
    return new Promise<void>(resolve => setTimeout(resolve, MIN_DELAY_MS));
  });
  chain = next;
  return next;
}

/**
 * Record a 429 and back off globally.
 * All queued calls will wait behind this 4s pause.
 */
export function jupiterBackoff(): Promise<void> {
  total429s++;
  engineLog.warn({ total429s, totalCalls }, 'Jupiter 429 — global 4s backoff');
  const backoff = chain.then(() => {
    return new Promise<void>(resolve => setTimeout(resolve, 4000));
  });
  chain = backoff;
  return backoff;
}

/** Stats for dashboard / logging */
export function jupiterGateStats() {
  return { totalCalls, total429s, rps: MIN_DELAY_MS > 0 ? (1000 / MIN_DELAY_MS).toFixed(1) : '∞' };
}
