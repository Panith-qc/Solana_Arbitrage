// JupiterService.ts
import { VersionedTransaction,
// Wallet adapters (Phantom, Backpack, etc.) expose signTransaction(tx)
// We'll type that below as GenericSigner
 } from '@solana/web3.js';
// --- Jupiter endpoints (lite = public, rate-limited, no key required) ---
const ULTRA_BASE = 'https://lite-api.jup.ag/ultra/v1';
const LEGACY_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const LEGACY_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';
const PRICE_V3_URL = 'https://lite-api.jup.ag/price/v3';
export class JupiterService {
    constructor(opts) {
        Object.defineProperty(this, "backendSwapProxyBaseUrl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "metrics", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
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
            }
        });
        this.backendSwapProxyBaseUrl = opts?.backendSwapProxyBaseUrl;
    }
    // -----------------------------------------
    // Internal helper: fetch with timeout
    // -----------------------------------------
    async fetchWithTimeout(url, options, timeoutMs = 5000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return res;
        }
        catch (err) {
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
    async getUltraOrder(args) {
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
            const res = await this.fetchWithTimeout(url.toString(), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            }, 5000);
            if (!res.ok) {
                throw new Error(`/ultra/v1/order error: ${res.status} ${res.statusText}`);
            }
            const data = await res.json();
            const elapsed = Date.now() - start;
            this.metrics.totalUltraOrders++;
            this.metrics.successfulUltraOrders++;
            this.metrics.avgUltraOrderMs =
                (this.metrics.avgUltraOrderMs *
                    (this.metrics.totalUltraOrders - 1) +
                    elapsed) /
                    this.metrics.totalUltraOrders;
            return data;
        }
        catch (err) {
            const elapsed = Date.now() - start;
            this.metrics.totalUltraOrders++;
            this.metrics.failedUltraOrders++;
            console.error(`Ultra order failed (${elapsed}ms):`, err?.message || err);
            throw err;
        }
    }
    // Helper: sign Ultra's unsigned transaction
    // - unsignedTxBase64 is data.transaction from getUltraOrder()
    // - signer is the wallet (Phantom, Backpack, Keypair wrapper, etc.)
    // Returns base64 of the signed transaction, ready for executeUltraOrder
    async signUltraTransaction(unsignedTxBase64, signer) {
        // ✅ Validate input exists
        if (!unsignedTxBase64) {
            throw new Error('unsignedTxBase64 is required but was undefined or empty');
        }
        const txBytes = Buffer.from(unsignedTxBase64, 'base64');
        // ✅ Check buffer is not empty
        if (txBytes.length === 0) {
            throw new Error('Transaction buffer is empty - Jupiter Ultra returned invalid transaction');
        }
        console.log(`📦 Transaction buffer: ${txBytes.length} bytes`);
        const tx = VersionedTransaction.deserialize(txBytes);
        // Sign the transaction
        if ('secretKey' in signer) {
            tx.sign([signer]);
        }
        else if ('signTransaction' in signer) {
            const signedTx = await signer.signTransaction(tx);
            tx.signatures = signedTx.signatures;
        }
        else {
            throw new Error('Invalid signer: must be Keypair or have signTransaction method');
        }
        // Serialize and return
        const signedBytes = tx.serialize();
        const signedBase64 = Buffer.from(signedBytes).toString('base64');
        console.log(`✅ Transaction signed (${signedBase64.length} chars)`);
        return signedBase64;
    }
    // Step 2: Execute Ultra swap
    // You send the signed base64 tx + requestId back to Jupiter Ultra.
    // Jupiter broadcasts / finalizes.
    async executeUltraOrder(args) {
        const start = Date.now();
        // ✅ Validate inputs exist
        if (!args.signedTransactionBase64) {
            throw new Error('signedTransactionBase64 is required but was undefined');
        }
        if (!args.requestId) {
            throw new Error('requestId is required but was undefined');
        }
        console.log(`🚀 Executing Ultra order: ${args.requestId.substring(0, 8)}... (tx: ${args.signedTransactionBase64.length} chars)`);
        const body = {
            requestId: args.requestId,
            signedTransaction: args.signedTransactionBase64,
        };
        try {
            const res = await this.fetchWithTimeout(`${ULTRA_BASE}/execute`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(body),
            }, 10000 // execution can take longer
            );
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`/ultra/v1/execute error: ${res.status} ${res.statusText} - ${text}`);
            }
            const data = await res.json();
            const elapsed = Date.now() - start;
            this.metrics.totalUltraExecutes++;
            this.metrics.successfulUltraExecutes++;
            this.metrics.avgUltraExecuteMs =
                (this.metrics.avgUltraExecuteMs *
                    (this.metrics.totalUltraExecutes - 1) +
                    elapsed) /
                    this.metrics.totalUltraExecutes;
            return data;
        }
        catch (err) {
            const elapsed = Date.now() - start;
            this.metrics.totalUltraExecutes++;
            this.metrics.failedUltraExecutes++;
            console.error(`Ultra execute failed (${elapsed}ms):`, err?.message || err);
            throw err;
        }
    }
    // Convenience: wrap Ultra order into a display object similar to your old "createOrder"
    // This does NOT execute. It's just a UI struct.
    async createUltraDisplay(args) {
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
                pricePerInputTokenApprox: (parseFloat(ultra.outAmount) / parseFloat(ultra.inAmount || '1')).toString(),
                pricePerOutputTokenApprox: (parseFloat(ultra.inAmount) / parseFloat(ultra.outAmount || '1')).toString(),
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
    async getLegacyQuote(args) {
        const start = Date.now();
        const url = new URL(LEGACY_QUOTE_URL);
        url.searchParams.set('inputMint', args.inputMint);
        url.searchParams.set('outputMint', args.outputMint);
        url.searchParams.set('amount', args.rawAmount);
        url.searchParams.set('slippageBps', (args.slippageBps ?? 50).toString());
        // You can tweak routing behavior if you want only single-hop pools
        url.searchParams.set('onlyDirectRoutes', 'false');
        try {
            const res = await this.fetchWithTimeout(url.toString(), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            }, 5000);
            if (!res.ok) {
                throw new Error(`/swap/v1/quote error: ${res.status} ${res.statusText}`);
            }
            const data = await res.json();
            const elapsed = Date.now() - start;
            this.metrics.totalLegacyQuotes++;
            this.metrics.successfulLegacyQuotes++;
            this.metrics.avgLegacyQuoteMs =
                (this.metrics.avgLegacyQuoteMs *
                    (this.metrics.totalLegacyQuotes - 1) +
                    elapsed) /
                    this.metrics.totalLegacyQuotes;
            return data;
        }
        catch (err) {
            const elapsed = Date.now() - start;
            this.metrics.totalLegacyQuotes++;
            this.metrics.failedLegacyQuotes++;
            console.error(`Legacy quote failed (${elapsed}ms):`, err?.message || err);
            throw err;
        }
    }
    // Build legacy swap transaction.
    // We try backend proxy first (good for hiding API keys / handling CORS).
    // If backend proxy fails or isn't provided, we call Jupiter directly.
    async buildLegacySwapTransaction(args) {
        const start = Date.now();
        const payload = {
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
                const proxyRes = await this.fetchWithTimeout(`${this.backendSwapProxyBaseUrl.replace(/\/$/, '')}/api/swap`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(payload),
                }, 10000);
                if (proxyRes.ok) {
                    const data = await proxyRes.json();
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
                console.warn(`Proxy /api/swap returned ${proxyRes.status}. Falling back to direct Jupiter`);
            }
            catch (proxyErr) {
                console.warn(`Proxy /api/swap failed (${proxyErr?.message}). Falling back to direct Jupiter`);
            }
        }
        // 2. Direct call to Jupiter legacy swap builder
        try {
            const directRes = await this.fetchWithTimeout(LEGACY_SWAP_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(payload),
            }, 10000);
            if (!directRes.ok) {
                throw new Error(`/swap/v1/swap error: ${directRes.status} ${directRes.statusText}`);
            }
            const data = await directRes.json();
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
        catch (err) {
            const elapsed = Date.now() - start;
            this.metrics.totalLegacySwaps++;
            this.metrics.failedLegacySwaps++;
            console.error(`Legacy swap build failed (${elapsed}ms):`, err?.message || err);
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
    async getPrices(mints) {
        const url = new URL(PRICE_V3_URL);
        url.searchParams.set('ids', mints.join(','));
        try {
            const res = await this.fetchWithTimeout(url.toString(), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            }, 3000);
            if (!res.ok) {
                throw new Error(`Price API error: ${res.status} ${res.statusText}`);
            }
            const data = await res.json();
            return data.data || {};
        }
        catch (err) {
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
            ultraOrderSuccessRate: m.totalUltraOrders > 0
                ? `${((m.successfulUltraOrders / m.totalUltraOrders) *
                    100).toFixed(2)}%`
                : 'N/A',
            ultraExecuteSuccessRate: m.totalUltraExecutes > 0
                ? `${((m.successfulUltraExecutes / m.totalUltraExecutes) *
                    100).toFixed(2)}%`
                : 'N/A',
            legacyQuoteSuccessRate: m.totalLegacyQuotes > 0
                ? `${((m.successfulLegacyQuotes / m.totalLegacyQuotes) *
                    100).toFixed(2)}%`
                : 'N/A',
            legacySwapSuccessRate: m.totalLegacySwaps > 0
                ? `${((m.successfulLegacySwaps / m.totalLegacySwaps) *
                    100).toFixed(2)}%`
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
    async sendSignedTransaction(connection, signedTxBase64) {
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
let singletonInstance = null;
export function getJupiterService(opts) {
    if (!singletonInstance) {
        singletonInstance = new JupiterService(opts);
    }
    return singletonInstance;
}
// Export singleton instance
export const jupiterUltraService = new JupiterService();
