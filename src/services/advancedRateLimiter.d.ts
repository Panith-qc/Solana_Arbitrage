interface RateLimitConfig {
    requestsPerMinute: number;
    requestsPerSecond: number;
    burstSize: number;
    tier: 'free' | 'paid';
}
export declare class AdvancedRateLimiter {
    private config;
    private queue;
    private processing;
    private requestTimestamps;
    private stats;
    constructor(config?: Partial<RateLimitConfig>);
    /**
     * Execute request with rate limiting
     */
    execute<T>(fn: () => Promise<T>, priority?: number): Promise<T>;
    /**
     * Process queued requests with rate limiting
     */
    private processQueue;
    /**
     * Check if we can make a request without hitting rate limit
     */
    private canMakeRequest;
    /**
     * Calculate how long to wait before next request
     */
    private getWaitTime;
    /**
     * Remove old timestamps
     */
    private cleanupTimestamps;
    /**
     * Sleep helper
     */
    private sleep;
    /**
     * Get current statistics
     */
    getStats(): {
        queueLength: number;
        requestsInLastSecond: number;
        requestsInLastMinute: number;
        utilizationPercent: string;
        totalRequests: number;
        queuedRequests: number;
        rejectedRequests: number;
        avgWaitTimeMs: number;
        rateLimitHits: number;
    };
    /**
     * Check if approaching rate limit
     */
    isApproachingLimit(): boolean;
    /**
     * Get recommended delay for next scan
     */
    getRecommendedScanDelay(): number;
}
export declare const RATE_LIMIT_CONFIGS: {
    JUPITER_LITE: {
        requestsPerMinute: number;
        requestsPerSecond: number;
        burstSize: number;
        tier: "free";
    };
    JUPITER_ULTRA: {
        requestsPerMinute: number;
        requestsPerSecond: number;
        burstSize: number;
        tier: "paid";
    };
    HELIUS_PAID: {
        requestsPerMinute: number;
        requestsPerSecond: number;
        burstSize: number;
        tier: "paid";
    };
};
export declare const jupiterRateLimiter: AdvancedRateLimiter;
export declare const heliusRateLimiter: AdvancedRateLimiter;
export {};
//# sourceMappingURL=advancedRateLimiter.d.ts.map