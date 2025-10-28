// JupiterService.ts

import {
  PublicKey,
  VersionedTransaction,
  Connection,
  Keypair,
  // Wallet adapters (Phantom, Backpack, etc.) expose signTransaction(tx)
  // We'll type that below as GenericSigner
} from '@solana/web3.js';

// --- Jupiter endpoints (lite = public, rate-limited, no key required) ---
const ULTRA_BASE = 'https://lite-api.jup.ag/ultra/v1';
const LEGACY_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const LEGACY_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';
const PRICE_V3_URL = 'https://lite-api.jup.ag/price/v3';

// ---------------------------------------------------------------------------
// Types for ULTRA
// NOTE: Jupiter Ultra /ultra/v1/order returns an unsigned transaction,
// the requestId, amounts, route info, etc.
// We model only what we actually use. You can extend as needed.
// ---------------------------------------------------------------------------

export interface JupiterUltraOrderResponse {
  requestId: string;
  // base64-encoded unsigned txn you must sign with the taker wallet
  transaction: string;

  // Quote-style info for display
  inputMint: string;
  outputMint: string;
  inAmount: string;   // raw units string
  outAmount: string;  // raw units string
  slippageBps?: number;
  priceImpactPct?: string;

  // Routing / fees / extra info, shape may evolve
  // Keep these as loose types so UI can still render
  routePlan?: any[];
  priorityFeeLamports?: string;
  lastValidBlockHeight?: number;

  // You may also get flags like "gasless", "ttl", etc. We keep it open.
  [key: string]: any;
}

// Payload for POST /ultra/v1/execute
export interface JupiterUltraExecuteRequest {
  requestId: string;
  signedTransaction: string; // base64 signed transaction
}

// Typical execute response
export interface JupiterUltraExecuteResponse {
  status: string;          // e.g. "ok"
  signature?: string;      // Solana signature
  slot?: number | string;  // slot at which it was sent
  // Keep open for future fields
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Types for LEGACY (swap/v1/*)
// This is Jupiter "classic" quote + swapTransaction builder.
// ---------------------------------------------------------------------------

export interface JupiterLegacyQuoteResponse {
  inputMint: string;
  inAmount: string; // raw units string
  outputMint: string;
  outAmount: string; // raw units string
  otherAmountThreshold: string;
  swapMode: string; // "ExactIn" | "ExactOut"
  slippageBps: number;
  platformFee: {
    amount: string;
    feeBps: number;
  } | null;
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
  // Jupiter sometimes returns timing/context fields
  contextSlot?: number;
  timeTaken?: number;
}

// Body for POST /swap/v1/swap
export interface JupiterLegacySwapRequest {
  quoteResponse: JupiterLegacyQuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
  prioritizationFeeLamports?: string | 'auto';
  asLegacyTransaction?: boolean;
  useSharedAccounts?: boolean;
  feeAccount?: string;
  trackingAccount?: string;
  computeUnitPriceMicroLamports?: string | 'auto';
  dynamicComputeUnitLimit?: boolean;
  skipUserAccountsRpcCalls?: boolean;
}

// Response from /swap/v1/swap
export interface JupiterLegacySwapResponse {
  // base64 encoded transaction that the user still needs to SIGN and SEND
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Extra helper shapes for UI / metrics
// ---------------------------------------------------------------------------

export interface UltraOrderDisplay {
  order: {
    orderId: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    estimatedSlippageBps: number | undefined;
    priceImpactPct: string | undefined;
    routes: any[];
    executionStrategy: 'ultra';
    gasless: boolean | undefined;
  };
  quote: {
    inputAmountRaw: string;
    outputAmountRaw: string;
    // caller can compute human price using decimals outside this class
    pricePerInputTokenApprox: string;
    pricePerOutputTokenApprox: string;
  };
  timeTakenMs: number;
}

// Generic signer contract for Ultra signing.
// - Keypair has sign(), wallet adapters have signTransaction().
// We'll normalize to a function that takes a VersionedTransaction and returns a signed VersionedTransaction.
export type GenericSigner = {
  signTransaction: (
    tx: VersionedTransaction
  ) => Promise<VersionedTransaction> | VersionedTransaction;
};

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

interface JupiterServiceOptions {
  // If you have a backend proxy endpoint like https://yourapp.com/api/swap,
  // pass it here. We'll try proxy first for legacy swap (better for CORS/key mgmt).
  backendSwapProxyBaseUrl?: string;
}

interface Metrics {
  // Ultra "order" (quote/build unsigned tx)
  totalUltraOrders: number;
  successfulUltraOrders: number;
  failedUltraOrders: number;
  avgUltraOrderMs: number;

  // Ultra "execute" (submit signed tx)
  totalUltraExecutes: number;
  successfulUltraExecutes: number;
  failedUltraExecutes: number;
  avgUltraExecuteMs: number;

  // Legacy quote
  totalLegacyQuotes: number;
  successfulLegacyQuotes: number;
  failedLegacyQuotes: number;
  avgLegacyQuoteMs: number;

  // Legacy swap transaction build
  totalLegacySwaps: number;
  successfulLegacySwaps: number;
  failedLegacySwaps: number;
  avgLegacySwapMs: number;
}

export class JupiterService {
  private backendSwapProxyBaseUrl: string | undefined;

  private metrics: Metrics = {
    totalUltraOrders: 0,
    successfulUltraOrders: 0,
    failedUltraOrders: 0,
    avgUltraOrderMs: 0,

    totalUltraExecutes: 0,
    successfulUltraExecutes: 0,
    failedUltraExecutes: 0,
    avgUltraExecuteMs: 0,

    totalLegacyQuotes: 0,
    successfulLegacyQuotes: 0,
    failedLegacyQuotes: 0,
    avgLegacyQuoteMs: 0,

    totalLegacySwaps: 0,
    successfulLegacySwaps: 0,
    failedLegacySwaps: 0,
    avgLegacySwapMs: 0,
  };

  constructor(opts?: JupiterServiceOptions) {
    this.backendSwapProxyBaseUrl = opts?.backendSwapProxyBaseUrl;
  }

  // -----------------------------------------
  // Internal helper: fetch with timeout
  // -----------------------------------------
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs = 5000
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return res;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  // =========================================================================
  // ULTRA (Primary path)
  // =========================================================================
  // Step 1: Ask Ultra for best route + unsigned tx
  // REQUIRED:
  // - inputMint, outputMint: token mints
  // - rawAmount: base units string (lamports etc)
  // - takerPubkey: wallet of the user (string)
  // Optional:
  // - slippageBps if you want to override default
  // NOTE:
  // Ultra builds the transaction server-side and returns it unsigned.
  // =========================================================================
  async getUltraOrder(args: {
    inputMint: string;
    outputMint: string;
    rawAmount: string; // integer string in base units
    takerPubkey: string; // user's wallet address
    slippageBps?: number; // optional, e.g. 50 = 0.5%
  }): Promise<JupiterUltraOrderResponse> {
    const start = Date.now();

    const url = new URL(`${ULTRA_BASE}/order`);
    url.searchParams.set('inputMint', args.inputMint);
    url.searchParams.set('outputMint', args.outputMint);
    url.searchParams.set('amount', args.rawAmount);
    url.searchParams.set('taker', args.takerPubkey);
    if (args.slippageBps !== undefined) {
      url.searchParams.set('slippageBps', args.slippageBps.toString());
    }

    try {
      const res = await this.fetchWithTimeout(
        url.toString(),
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        },
        5000
      );

      if (!res.ok) {
        throw new Error(
          `/ultra/v1/order error: ${res.status} ${res.statusText}`
        );
      }

      const data: JupiterUltraOrderResponse = await res.json();
      const elapsed = Date.now() - start;

      this.metrics.totalUltraOrders++;
      this.metrics.successfulUltraOrders++;
      this.metrics.avgUltraOrderMs =
        (this.metrics.avgUltraOrderMs *
          (this.metrics.totalUltraOrders - 1) +
          elapsed) /
        this.metrics.totalUltraOrders;

      return data;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      this.metrics.totalUltraOrders++;
      this.metrics.failedUltraOrders++;

      console.error(
        `Ultra order failed (${elapsed}ms):`,
        err?.message || err
      );
      throw err;
    }
  }

  // Helper: sign Ultra's unsigned transaction
  // - unsignedTxBase64 is data.transaction from getUltraOrder()
  // - signer is the wallet (Phantom, Backpack, Keypair wrapper, etc.)
  // Returns base64 of the signed transaction, ready for executeUltraOrder
  async signUltraTransaction(
    unsignedTxBase64: string,
    signer: GenericSigner
  ): Promise<string> {
    const txBytes = Buffer.from(unsignedTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBytes);

    const signedTx = await signer.signTransaction(tx);
    const signedBytes = signedTx.serialize();
    return Buffer.from(signedBytes).toString('base64');
  }

  // Step 2: Execute Ultra swap
  // You send the signed base64 tx + requestId back to Jupiter Ultra.
  // Jupiter broadcasts / finalizes.
  async executeUltraOrder(args: {
    requestId: string;
    signedTransactionBase64: string;
  }): Promise<JupiterUltraExecuteResponse> {
    const start = Date.now();

    const body: JupiterUltraExecuteRequest = {
      requestId: args.requestId,
      signedTransaction: args.signedTransactionBase64,
    };

    try {
      const res = await this.fetchWithTimeout(
        `${ULTRA_BASE}/execute`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        },
        10000 // execution can take longer
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `/ultra/v1/execute error: ${res.status} ${res.statusText} - ${text}`
        );
      }

      const data: JupiterUltraExecuteResponse = await res.json();
      const elapsed = Date.now() - start;

      this.metrics.totalUltraExecutes++;
      this.metrics.successfulUltraExecutes++;
      this.metrics.avgUltraExecuteMs =
        (this.metrics.avgUltraExecuteMs *
          (this.metrics.totalUltraExecutes - 1) +
          elapsed) /
        this.metrics.totalUltraExecutes;

      return data;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      this.metrics.totalUltraExecutes++;
      this.metrics.failedUltraExecutes++;

      console.error(
        `Ultra execute failed (${elapsed}ms):`,
        err?.message || err
      );
      throw err;
    }
  }

  // Convenience: wrap Ultra order into a display object similar to your old "createOrder"
  // This does NOT execute. It's just a UI struct.
  async createUltraDisplay(args: {
    inputMint: string;
    outputMint: string;
    rawAmount: string;
    takerPubkey: string;
    slippageBps?: number;
  }): Promise<UltraOrderDisplay> {
    const start = Date.now();

    const ultra = await this.getUltraOrder(args);
    const elapsed = Date.now() - start;

    return {
      order: {
        orderId: ultra.requestId,
        inputMint: ultra.inputMint,
        outputMint: ultra.outputMint,
        inAmount: ultra.inAmount,
        outAmount: ultra.outAmount,
        estimatedSlippageBps: ultra.slippageBps,
        priceImpactPct: ultra.priceImpactPct,
        routes: ultra.routePlan || [],
        executionStrategy: 'ultra',
        gasless: Boolean(ultra.gasless),
      },
      quote: {
        inputAmountRaw: ultra.inAmount,
        outputAmountRaw: ultra.outAmount,
        // Approx ratios in raw units. Caller should convert using decimals.
        pricePerInputTokenApprox: (
          parseFloat(ultra.outAmount) / parseFloat(ultra.inAmount || '1')
        ).toString(),
        pricePerOutputTokenApprox: (
          parseFloat(ultra.inAmount) / parseFloat(ultra.outAmount || '1')
        ).toString(),
      },
      timeTakenMs: elapsed,
    };
  }

  // =========================================================================
  // LEGACY (Fallback path)
  // =========================================================================
  // Step 1: Get quote from /swap/v1/quote
  // Step 2: Build swap transaction via /swap/v1/swap
  // =========================================================================

  async getLegacyQuote(args: {
    inputMint: string;
    outputMint: string;
    rawAmount: string; // integer string in base units
    slippageBps?: number; // default 50 (0.5%)
  }): Promise<JupiterLegacyQuoteResponse> {
    const start = Date.now();

    const url = new URL(LEGACY_QUOTE_URL);
    url.searchParams.set('inputMint', args.inputMint);
    url.searchParams.set('outputMint', args.outputMint);
    url.searchParams.set('amount', args.rawAmount);
    url.searchParams.set(
      'slippageBps',
      (args.slippageBps ?? 50).toString()
    );
    // You can tweak routing behavior if you want only single-hop pools
    url.searchParams.set('onlyDirectRoutes', 'false');

    try {
      const res = await this.fetchWithTimeout(
        url.toString(),
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        },
        5000
      );

      if (!res.ok) {
        throw new Error(`/swap/v1/quote error: ${res.status} ${res.statusText}`);
      }

      const data: JupiterLegacyQuoteResponse = await res.json();
      const elapsed = Date.now() - start;

      this.metrics.totalLegacyQuotes++;
      this.metrics.successfulLegacyQuotes++;
      this.metrics.avgLegacyQuoteMs =
        (this.metrics.avgLegacyQuoteMs *
          (this.metrics.totalLegacyQuotes - 1) +
          elapsed) /
        this.metrics.totalLegacyQuotes;

      return data;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      this.metrics.totalLegacyQuotes++;
      this.metrics.failedLegacyQuotes++;

      console.error(
        `Legacy quote failed (${elapsed}ms):`,
        err?.message || err
      );
      throw err;
    }
  }

  // Build legacy swap transaction.
  // We try backend proxy first (good for hiding API keys / handling CORS).
  // If backend proxy fails or isn't provided, we call Jupiter directly.
  async buildLegacySwapTransaction(args: {
    quoteResponse: JupiterLegacyQuoteResponse;
    userPublicKey: string;
  }): Promise<JupiterLegacySwapResponse> {
    const start = Date.now();

    const payload: JupiterLegacySwapRequest = {
      quoteResponse: args.quoteResponse,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 'auto',
      dynamicComputeUnitLimit: true,
      skipUserAccountsRpcCalls: false,
    };

    // 1. Try backend proxy if configured
    if (this.backendSwapProxyBaseUrl) {
      try {
        const proxyRes = await this.fetchWithTimeout(
          `${this.backendSwapProxyBaseUrl.replace(/\/$/, '')}/api/swap`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(payload),
          },
          10000
        );

        if (proxyRes.ok) {
          const data: JupiterLegacySwapResponse = await proxyRes.json();
          const elapsed = Date.now() - start;

          this.metrics.totalLegacySwaps++;
          this.metrics.successfulLegacySwaps++;
          this.metrics.avgLegacySwapMs =
            (this.metrics.avgLegacySwapMs *
              (this.metrics.totalLegacySwaps - 1) +
              elapsed) /
            this.metrics.totalLegacySwaps;

          return data;
        }

        console.warn(
          `Proxy /api/swap returned ${proxyRes.status}. Falling back to direct Jupiter`
        );
      } catch (proxyErr: any) {
        console.warn(
          `Proxy /api/swap failed (${proxyErr?.message}). Falling back to direct Jupiter`
        );
      }
    }

    // 2. Direct call to Jupiter legacy swap builder
    try {
      const directRes = await this.fetchWithTimeout(
        LEGACY_SWAP_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
        },
        10000
      );

      if (!directRes.ok) {
        throw new Error(
          `/swap/v1/swap error: ${directRes.status} ${directRes.statusText}`
        );
      }

      const data: JupiterLegacySwapResponse = await directRes.json();
      const elapsed = Date.now() - start;

      this.metrics.totalLegacySwaps++;
      this.metrics.successfulLegacySwaps++;
      this.metrics.avgLegacySwapMs =
        (this.metrics.avgLegacySwapMs *
          (this.metrics.totalLegacySwaps - 1) +
          elapsed) /
        this.metrics.totalLegacySwaps;

      return data;
    } catch (err: any) {
      const elapsed = Date.now() - start;
      this.metrics.totalLegacySwaps++;
      this.metrics.failedLegacySwaps++;

      console.error(
        `Legacy swap build failed (${elapsed}ms):`,
        err?.message || err
      );
      throw err;
    }
  }

  // =========================================================================
  // PRICE API
  // =========================================================================
  // Jupiter price V3 endpoint:
  // GET /price/v3?ids=<comma-separated-token-mints>
  // Returns an object keyed by mint with { price, symbol, ... }.
  // =========================================================================
  async getPrices(mints: string[]): Promise<
    Record<string, { price: number; symbol: string; [key: string]: any }>
  > {
    const url = new URL(PRICE_V3_URL);
    url.searchParams.set('ids', mints.join(','));

    try {
      const res = await this.fetchWithTimeout(
        url.toString(),
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
        },
        3000
      );

      if (!res.ok) {
        throw new Error(
          `Price API error: ${res.status} ${res.statusText}`
        );
      }

      const data = await res.json();
      return data.data || {};
    } catch (err: any) {
      console.error('Price fetch failed:', err?.message || err);
      return {};
    }
  }

  // =========================================================================
  // METRICS
  // =========================================================================
  getMetrics() {
    const m = this.metrics;
    return {
      ...m,
      ultraOrderSuccessRate:
        m.totalUltraOrders > 0
          ? `${(
              (m.successfulUltraOrders / m.totalUltraOrders) *
              100
            ).toFixed(2)}%`
          : 'N/A',
      ultraExecuteSuccessRate:
        m.totalUltraExecutes > 0
          ? `${(
              (m.successfulUltraExecutes / m.totalUltraExecutes) *
              100
            ).toFixed(2)}%`
          : 'N/A',
      legacyQuoteSuccessRate:
        m.totalLegacyQuotes > 0
          ? `${(
              (m.successfulLegacyQuotes / m.totalLegacyQuotes) *
              100
            ).toFixed(2)}%`
          : 'N/A',
      legacySwapSuccessRate:
        m.totalLegacySwaps > 0
          ? `${(
              (m.successfulLegacySwaps / m.totalLegacySwaps) *
              100
            ).toFixed(2)}%`
          : 'N/A',
    };
  }

  // =========================================================================
  // Utility: broadcast signed legacy tx yourself if you want
  // =========================================================================
  // For Legacy flow, /swap/v1/swap returns swapTransaction (base64 unsigned).
  // You still need to sign + sendRawTransaction using your Connection.
  // Ultra execute handles broadcast for you, so you don't need this there.
  //
  // This helper shows how you'd send a signed tx yourself if needed.
  // =========================================================================
  async sendSignedTransaction(
    connection: Connection,
    signedTxBase64: string
  ): Promise<string> {
    const raw = Buffer.from(signedTxBase64, 'base64');
    // sendRawTransaction returns the signature string
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });
    return sig;
  }
}

// Singleton instance
let singletonInstance: JupiterService | null = null;

export function getJupiterService(
  opts?: JupiterServiceOptions
): JupiterService {
  if (!singletonInstance) {
    singletonInstance = new JupiterService(opts);
  }
  return singletonInstance;
}

// Export singleton instance
export const jupiterUltraService = new JupiterService();
