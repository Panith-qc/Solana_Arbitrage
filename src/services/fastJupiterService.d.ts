import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
export interface FastQuote {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    priceImpactPct: number;
    routePlan: any[];
    timeTakenMs: number;
}
export interface FastSwapResult {
    success: boolean;
    signature?: string;
    timeTakenMs: number;
    error?: string;
}
export declare class FastJupiterService {
    private readonly JUPITER_V6_API;
    private readonly QUOTE_TIMEOUT_MS;
    private readonly SWAP_TIMEOUT_MS;
    private connection;
    private metrics;
    constructor(connection: Connection);
    /**
     * Get quote with rate limiting and timeout (FAST + SAFE!)
     */
    getQuote(inputMint: string, outputMint: string, amount: number, slippageBps?: number): Promise<FastQuote | null>;
    /**
     * Get multiple quotes in parallel (FAST!)
     */
    getQuotesBatch(requests: Array<{
        inputMint: string;
        outputMint: string;
        amount: number;
        slippageBps?: number;
    }>): Promise<Array<FastQuote | null>>;
    /**
     * Get swap transaction with timeout
     */
    getSwapTransaction(quote: FastQuote, userPublicKey: string, priorityFeeLamports?: number): Promise<string | null>;
    /**
     * Execute swap with millisecond timing
     */
    executeSwap(quote: FastQuote, userPublicKey: PublicKey, signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>, priorityFeeLamports?: number): Promise<FastSwapResult>;
    /**
     * Get performance metrics
     */
    getMetrics(): {
        successRate: string;
        totalQuotes: number;
        successfulQuotes: number;
        failedQuotes: number;
        avgQuoteTimeMs: number;
        fastestQuoteMs: number;
        slowestQuoteMs: number;
    };
    /**
     * Reset metrics
     */
    resetMetrics(): void;
    /**
     * Health check with timing
     */
    healthCheck(): Promise<{
        healthy: boolean;
        latencyMs: number;
    }>;
}
export declare function initFastJupiterService(connection: Connection): FastJupiterService;
export declare function getFastJupiterService(): FastJupiterService;
//# sourceMappingURL=fastJupiterService.d.ts.map