/**
 * API RATE LIMITER - Prevents 500 errors from API overload
 * Implements request queuing + exponential backoff + batching for parallel execution
 * OPTIMIZED: Supports batch execution for 5-10x faster scanning
 */
export declare class APIRateLimiter {
    private queue;
    private processing;
    private lastBatchTime;
    private MIN_INTERVAL;
    private BATCH_SIZE;
    private batchTimeout;
    /**
     * Execute an API call with rate limiting and retry logic
     * OPTIMIZED: Batches requests for parallel execution
     */
    execute<T>(fn: () => Promise<T>, retries?: number): Promise<T>;
    /**
     * Execute multiple requests in a single batch
     * OPTIMIZED: Allows parallel execution within rate limits
     */
    executeBatch<T>(fns: (() => Promise<T>)[], retries?: number): Promise<T[]>;
    /**
     * Retry function with exponential backoff
     */
    private retryWithBackoff;
    /**
     * Process requests in batches for better performance
     * OPTIMIZED: Processes multiple requests in parallel
     */
    private processBatch;
    private sleep;
    /**
     * Get queue stats for debugging
     */
    getStats(): {
        queueLength: number;
        processing: boolean;
        timeSinceLastBatch: number;
        minInterval: number;
        batchSize: number;
    };
    /**
     * Update rate limiter settings (for tuning)
     */
    configure(options: {
        minInterval?: number;
        batchSize?: number;
    }): void;
}
export declare const rateLimiter: APIRateLimiter;
//# sourceMappingURL=rateLimiter.d.ts.map