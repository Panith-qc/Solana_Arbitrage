// JUPITER ENDPOINT POOL
// Manages multiple Jupiter API keys (each with its own rate limit) for parallel API calls.
// Each endpoint has its own independent rate limiter and API key.
// Strategies request endpoints by role (scan, buy-quote, forward-tx, reverse-tx)
// to maximize parallelism without 429 errors.

import { strategyLog } from './logger.js';
import { BotConfig, PRIORITY_FEE_LAMPORTS, JUPITER_MAX_ACCOUNTS } from './config.js';

export interface JupiterEndpoint {
  /** Base URL (same for all: https://lite-api.jup.ag) */
  baseUrl: string;
  /** API key for this endpoint (each free-tier account has its own key) */
  apiKey: string;
  /** Label for logging */
  label: string;
  /** Timestamp of last API call (for rate limiting) */
  lastCallMs: number;
  /** Minimum ms between calls */
  minIntervalMs: number;
  /** Number of 429 errors received */
  throttleCount: number;
}

export interface DexQuote {
  source: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  pricePerToken: number;
  raw: any;
}

/**
 * Pool of Jupiter API endpoints for parallel calls.
 * Each endpoint uses the SAME base URL but a DIFFERENT API key.
 * With N keys, the bot can make N simultaneous Jupiter calls
 * without hitting any single key's rate limit.
 */
export class JupiterPool {
  private endpoints: JupiterEndpoint[] = [];
  private roundRobinIndex = 0;

  constructor(config: BotConfig) {
    const baseUrl = config.jupiterApiUrl || 'https://lite-api.jup.ag';

    // Collect all API keys — first key is required, rest are optional
    const keys = [
      config.jupiterApiKey,
      config.jupiterApiKey2,
      config.jupiterApiKey3,
      config.jupiterApiKey4,
    ].filter(k => k && k.length > 0);

    // If no keys at all, still create one endpoint (no auth, public rate limit)
    if (keys.length === 0) {
      keys.push('');
    }

    const minInterval = Math.max(1000, Math.ceil(1000 / config.maxRequestsPerSecond));

    for (let i = 0; i < keys.length; i++) {
      this.endpoints.push({
        baseUrl,
        apiKey: keys[i],
        label: `jup-${i + 1}`,
        lastCallMs: 0,
        minIntervalMs: minInterval,
        throttleCount: 0,
      });
    }

    strategyLog.info(
      { endpoints: this.endpoints.length, labels: this.endpoints.map(e => e.label) },
      `Jupiter pool initialized — ${this.endpoints.length} endpoint(s) with API keys`,
    );
  }

  /** Number of available endpoints */
  get size(): number {
    return this.endpoints.length;
  }

  /** Build headers for an endpoint — includes API key if present */
  private buildHeaders(ep: JupiterEndpoint, json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (ep.apiKey) headers['x-api-key'] = ep.apiKey;
    return headers;
  }

  // ═══════════════════════════════════════════════════════════════
  // RATE-LIMITED CALLS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get a quote from a specific endpoint index (0-based).
   * Respects that endpoint's individual rate limit.
   */
  async getQuote(
    endpointIndex: number,
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
  ): Promise<DexQuote | null> {
    const ep = this.endpoints[endpointIndex % this.endpoints.length];
    await this.rateLimitEndpoint(ep);

    const url = new URL(`${ep.baseUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('maxAccounts', JUPITER_MAX_ACCOUNTS.toString());

    try {
      const response = await fetch(url.toString(), {
        headers: this.buildHeaders(ep),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        if (response.status === 429) {
          ep.throttleCount++;
          strategyLog.warn({ endpoint: ep.label }, 'Jupiter 429 — 5s backoff');
          await new Promise(r => setTimeout(r, 5000));
        }
        return null;
      }
      const data = await response.json();
      if (!data.outAmount) return null;

      return {
        source: 'aggregator',
        inputMint, outputMint, inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: parseFloat(data.outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get a quote from the next available endpoint (round-robin).
   */
  async getQuoteRoundRobin(
    inputMint: string, outputMint: string, amount: string, slippageBps: number,
  ): Promise<DexQuote | null> {
    const idx = this.roundRobinIndex;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.endpoints.length;
    return this.getQuote(idx, inputMint, outputMint, amount, slippageBps);
  }

  /**
   * Get multiple quotes in PARALLEL — one per endpoint.
   * Each call goes to a different endpoint, so no rate limit conflicts.
   * Returns results in same order as input array.
   */
  async getQuotesParallel(
    requests: Array<{ inputMint: string; outputMint: string; amount: string; slippageBps: number }>,
  ): Promise<Array<DexQuote | null>> {
    // Limit parallel calls to number of endpoints
    const batches: Array<DexQuote | null>[] = [];

    for (let i = 0; i < requests.length; i += this.endpoints.length) {
      const batch = requests.slice(i, i + this.endpoints.length);
      const results = await Promise.all(
        batch.map((req, j) =>
          this.getQuote(
            (i + j) % this.endpoints.length,
            req.inputMint, req.outputMint, req.amount, req.slippageBps,
          ),
        ),
      );
      batches.push(results);
    }

    return batches.flat();
  }

  /**
   * Fetch a swap TX from a specific endpoint.
   */
  async fetchSwapTx(
    endpointIndex: number,
    quote: any,
    walletPubkey: string,
  ): Promise<any | null> {
    const ep = this.endpoints[endpointIndex % this.endpoints.length];
    await this.rateLimitEndpoint(ep);

    const swapUrl = `${ep.baseUrl}/swap/v1/swap`;
    const body = {
      quoteResponse: quote,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
    };

    try {
      const response = await fetch(swapUrl, {
        method: 'POST',
        headers: this.buildHeaders(ep, true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        if (response.status === 429) {
          ep.throttleCount++;
          strategyLog.warn({ endpoint: ep.label, status: response.status }, 'Jupiter /swap 429');
          await new Promise(r => setTimeout(r, 5000));
        }
        return null;
      }
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Fetch forward + reverse swap TXs in PARALLEL using two different endpoints.
   */
  async fetchSwapTxPairParallel(
    forwardQuote: any,
    reverseQuote: any,
    walletPubkey: string,
    forwardEndpoint: number,
    reverseEndpoint: number,
  ): Promise<{ forwardSwapTx: string; reverseSwapTx: string } | null> {
    const [fwdData, revData] = await Promise.all([
      this.fetchSwapTx(forwardEndpoint, forwardQuote, walletPubkey),
      this.fetchSwapTx(reverseEndpoint, reverseQuote, walletPubkey),
    ]);

    if (!fwdData?.swapTransaction || !revData?.swapTransaction) return null;

    return {
      forwardSwapTx: fwdData.swapTransaction,
      reverseSwapTx: revData.swapTransaction,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RATE LIMITING (per endpoint)
  // ═══════════════════════════════════════════════════════════════

  private async rateLimitEndpoint(ep: JupiterEndpoint): Promise<void> {
    const now = Date.now();
    const elapsed = now - ep.lastCallMs;
    if (elapsed < ep.minIntervalMs) {
      await new Promise(r => setTimeout(r, ep.minIntervalMs - elapsed));
    }
    ep.lastCallMs = Date.now();
  }

  /** Get stats for logging/dashboard */
  getStats(): { endpoints: number; throttleCounts: Record<string, number> } {
    const throttleCounts: Record<string, number> = {};
    for (const ep of this.endpoints) {
      throttleCounts[ep.label] = ep.throttleCount;
    }
    return { endpoints: this.endpoints.length, throttleCounts };
  }
}
