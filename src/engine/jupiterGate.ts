// GLOBAL JUPITER RATE GATE
// Singleton that serializes ALL Jupiter API calls across every strategy.
// Free-tier Jupiter lite API allows ~2 req/s. With 7 strategies scanning
// concurrently, each with their own rate limiter, we blow past this.
// This module provides a single queue that enforces the global limit.

import { engineLog } from './logger.js';

const MIN_DELAY_MS = 600; // ~1.6 req/s — conservative to avoid 429s
let lastCallMs = 0;
let totalCalls = 0;
let total429s = 0;

/**
 * Wait for the global Jupiter rate gate before making a call.
 * Call this BEFORE every Jupiter API request from any strategy.
 */
export async function jupiterGate(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallMs;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise(r => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallMs = Date.now();
  totalCalls++;
}

/**
 * Record a 429 and back off globally.
 * Call this when a Jupiter 429 response is received.
 */
export async function jupiterBackoff(): Promise<void> {
  total429s++;
  engineLog.warn({ total429s, totalCalls }, 'Jupiter 429 — global 3s backoff');
  lastCallMs = Date.now() + 3000; // block all strategies for 3s
  await new Promise(r => setTimeout(r, 3000));
}

/** Stats for dashboard / logging */
export function jupiterGateStats() {
  return { totalCalls, total429s, rps: MIN_DELAY_MS > 0 ? (1000 / MIN_DELAY_MS).toFixed(1) : '∞' };
}
