/**
 * PRODUCTION-READY MULTI-API QUOTE SERVICE
 *
 * Supports 5 API providers with automatic failover:
 * 1. Jupiter Ultra V1 (fastest, rate-limited)
 * 2. Jupiter Legacy V6 (backup)
 * 3. Birdeye (price data)
 * 4. DexScreener (backup price data)
 * 5. Direct DEX queries (last resort)
 *
 * Features:
 * - Automatic health monitoring
 * - Smart API selection based on success rate
 * - Rate limit detection and auto-pause
 * - Real-time performance metrics
 * - Zero-downtime failover
 */
export interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    platformFee: null | any;
    priceImpactPct: string;
    routePlan: any[];
    contextSlot?: number;
    timeTaken?: number;
    requestId?: string;
    provider?: string;
}
declare class MultiAPIQuoteService {
    private providers;
    private requestDelay;
    /**
     * Auto-select best API based on:
     * 1. Not paused
     * 2. Under rate limit
     * 3. Low consecutive failures
     * 4. High success rate
     * 5. Low latency
     * 6. Priority order
     */
    private selectBestAPI;
    /**
     * Check if API has rate limit capacity
     */
    private hasRateLimitCapacity;
    /**
     * Track rate limit usage
     */
    private trackRateLimit;
    /**
     * Record successful API call
     */
    private recordSuccess;
    /**
     * Record failed API call
     */
    private recordFailure;
    /**
     * Fetch quote from Jupiter Ultra V1
     */
    private fetchJupiterUltra;
    /**
     * Fetch quote from Jupiter V6 (quote-api or lite-api)
     */
    private fetchJupiterV6;
    /**
     * Fetch quote from Raydium V3 API (REAL DEX)
     */
    private fetchRaydiumV3;
    /**
     * Fetch quote from Orca (via Jupiter aggregator - CORS BYPASS)
     * \u2705 CORS FIX: Use Jupiter V6 API with dexes=Orca filter
     * This bypasses CORS because Jupiter's API supports CORS headers
     */
    private fetchOrcaWhirlpool;
    /**
     * Fetch price from DexScreener - DISABLED
     * ❌ DexScreener returns unreliable data causing fake profit reports ($1B+ fake profits)
     * Use Jupiter/Raydium for real quotes only
     */
    private fetchDexScreener;
    /**
     * Get token decimals
     */
    private getTokenDecimals;
    /**
     * Get token USD price (approximate)
     */
    private getTokenPrice;
    /**
     * Validate quote with PROPER USD CONVERSION
     * \u2705 FIXED: Handles all token decimals correctly
     * \u2705 Compares USD values (not raw token amounts)
     * \u2705 Reasonable profit range: -20% to +30%
     */
    private isRealisticQuote;
    /**
     * Main entry point: Get quote with automatic failover
     */
    getQuote(inputMint: string, outputMint: string, amount: number, slippageBps?: number): Promise<JupiterQuoteResponse>;
    /**
     * Get health report for monitoring/UI
     */
    getHealthReport(): {
        name: string;
        status: "HEALTHY" | "DEGRADED" | "PAUSED" | "FAILED";
        successRate: string;
        totalCalls: number;
        successfulCalls: number;
        failedCalls: number;
        avgLatency: string;
        callsThisMinute: string;
        lastError: string;
        consecutiveFailures: number;
        pauseRemaining: string;
    }[];
    /**
     * Test all APIs on startup
     */
    testAllAPIs(): Promise<void>;
    /**
     * Set request delay (ms between requests)
     */
    setRequestDelay(delayMs: number): void;
    /**
     * Reset all API health metrics
     */
    resetHealthMetrics(): void;
}
export declare const multiAPIService: MultiAPIQuoteService;
export { MultiAPIQuoteService };
//# sourceMappingURL=multiAPIQuoteService.d.ts.map