// ADVANCED RATE LIMITER - Prevent hitting API limits
// Supports both FREE and PAID tier configurations
export class AdvancedRateLimiter {
    constructor(config = {}) {
        Object.defineProperty(this, "config", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "queue", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "processing", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "requestTimestamps", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        // Statistics
        Object.defineProperty(this, "stats", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                totalRequests: 0,
                queuedRequests: 0,
                rejectedRequests: 0,
                avgWaitTimeMs: 0,
                rateLimitHits: 0,
            }
        });
        // Default: Jupiter FREE tier (conservative)
        this.config = {
            requestsPerMinute: config.requestsPerMinute || 60,
            requestsPerSecond: config.requestsPerSecond || 1,
            burstSize: config.burstSize || 2,
            tier: config.tier || 'free',
        };
        console.log(`⚡ Rate Limiter initialized (${this.config.tier.toUpperCase()} tier)`);
        console.log(`   Max: ${this.config.requestsPerMinute} req/min | ${this.config.requestsPerSecond} req/sec`);
    }
    /**
     * Execute request with rate limiting
     */
    async execute(fn, priority = 5) {
        return new Promise((resolve, reject) => {
            const request = {
                execute: fn,
                resolve,
                reject,
                priority,
                timestamp: Date.now(),
            };
            this.queue.push(request);
            this.stats.queuedRequests++;
            this.processQueue();
        });
    }
    /**
     * Process queued requests with rate limiting
     */
    async processQueue() {
        if (this.processing)
            return;
        this.processing = true;
        while (this.queue.length > 0) {
            // Check if we can make a request
            if (!this.canMakeRequest()) {
                const waitTime = this.getWaitTime();
                await this.sleep(waitTime);
                continue;
            }
            // Sort queue by priority (higher = more urgent)
            this.queue.sort((a, b) => b.priority - a.priority);
            // Get next request
            const request = this.queue.shift();
            if (!request)
                break;
            // Execute request
            try {
                const startTime = Date.now();
                const result = await request.execute();
                // Track stats
                this.stats.totalRequests++;
                const waitTime = startTime - request.timestamp;
                this.stats.avgWaitTimeMs =
                    (this.stats.avgWaitTimeMs * (this.stats.totalRequests - 1) + waitTime) /
                        this.stats.totalRequests;
                // Record request timestamp
                this.requestTimestamps.push(Date.now());
                this.cleanupTimestamps();
                request.resolve(result);
            }
            catch (error) {
                // Check if rate limit error
                if (error.status === 429 || error.message.includes('rate limit')) {
                    this.stats.rateLimitHits++;
                    console.warn(`⚠️ Rate limit hit! Waiting 5 seconds...`);
                    await this.sleep(5000);
                    // Re-queue request
                    this.queue.unshift(request);
                }
                else {
                    this.stats.rejectedRequests++;
                    request.reject(error);
                }
            }
        }
        this.processing = false;
    }
    /**
     * Check if we can make a request without hitting rate limit
     */
    canMakeRequest() {
        const now = Date.now();
        // Check requests per second
        const lastSecond = this.requestTimestamps.filter(ts => now - ts < 1000).length;
        if (lastSecond >= this.config.requestsPerSecond) {
            return false;
        }
        // Check requests per minute
        const lastMinute = this.requestTimestamps.filter(ts => now - ts < 60000).length;
        if (lastMinute >= this.config.requestsPerMinute) {
            return false;
        }
        // Check burst size
        const lastBurst = this.requestTimestamps.filter(ts => now - ts < 100).length;
        if (lastBurst >= this.config.burstSize) {
            return false;
        }
        return true;
    }
    /**
     * Calculate how long to wait before next request
     */
    getWaitTime() {
        const now = Date.now();
        // Check per-second limit
        const recentRequests = this.requestTimestamps.filter(ts => now - ts < 1000);
        if (recentRequests.length >= this.config.requestsPerSecond) {
            const oldestInSecond = Math.min(...recentRequests);
            return Math.max(100, 1000 - (now - oldestInSecond));
        }
        // Check per-minute limit
        const lastMinuteRequests = this.requestTimestamps.filter(ts => now - ts < 60000);
        if (lastMinuteRequests.length >= this.config.requestsPerMinute) {
            const oldestInMinute = Math.min(...lastMinuteRequests);
            return Math.max(1000, 60000 - (now - oldestInMinute));
        }
        return 100; // Small delay between requests
    }
    /**
     * Remove old timestamps
     */
    cleanupTimestamps() {
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter(ts => now - ts < 60000);
    }
    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Get current statistics
     */
    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            requestsInLastSecond: this.requestTimestamps.filter(ts => Date.now() - ts < 1000).length,
            requestsInLastMinute: this.requestTimestamps.filter(ts => Date.now() - ts < 60000).length,
            utilizationPercent: ((this.requestTimestamps.filter(ts => Date.now() - ts < 60000).length /
                this.config.requestsPerMinute) * 100).toFixed(1) + '%',
        };
    }
    /**
     * Check if approaching rate limit
     */
    isApproachingLimit() {
        const lastMinute = this.requestTimestamps.filter(ts => Date.now() - ts < 60000).length;
        return lastMinute >= this.config.requestsPerMinute * 0.8;
    }
    /**
     * Get recommended delay for next scan
     */
    getRecommendedScanDelay() {
        const utilization = this.requestTimestamps.filter(ts => Date.now() - ts < 60000).length / this.config.requestsPerMinute;
        if (utilization > 0.9) {
            return 10000; // 10 seconds (very conservative)
        }
        else if (utilization > 0.7) {
            return 5000; // 5 seconds
        }
        else if (utilization > 0.5) {
            return 3000; // 3 seconds
        }
        else {
            return 2000; // 2 seconds (aggressive)
        }
    }
}
// Rate limiter configurations
export const RATE_LIMIT_CONFIGS = {
    // Jupiter API limits
    JUPITER_FREE: {
        requestsPerMinute: 60,
        requestsPerSecond: 1,
        burstSize: 2,
        tier: 'free',
    },
    JUPITER_PAID: {
        requestsPerMinute: 1200, // 20 req/sec
        requestsPerSecond: 20,
        burstSize: 50,
        tier: 'paid',
    },
    // Helius RPC limits
    HELIUS_FREE: {
        requestsPerMinute: 120, // ~2 req/sec
        requestsPerSecond: 2,
        burstSize: 3,
        tier: 'free',
    },
    HELIUS_PAID: {
        requestsPerMinute: 600, // 10 req/sec
        requestsPerSecond: 10,
        burstSize: 30,
        tier: 'paid',
    },
};
// Determine tier from environment variable (defaults to 'free')
function getTier(envKey) {
    try {
        const tier = import.meta.env?.[`VITE_${envKey}`]
            || import.meta.env?.[envKey]
            || 'free';
        return tier === 'paid' ? 'paid' : 'free';
    }
    catch {
        return 'free';
    }
}
const jupiterTier = getTier('JUPITER_RATE_LIMIT_TIER');
const heliusTier = getTier('HELIUS_RATE_LIMIT_TIER');
const jupiterConfig = jupiterTier === 'paid' ? RATE_LIMIT_CONFIGS.JUPITER_PAID : RATE_LIMIT_CONFIGS.JUPITER_FREE;
const heliusConfig = heliusTier === 'paid' ? RATE_LIMIT_CONFIGS.HELIUS_PAID : RATE_LIMIT_CONFIGS.HELIUS_FREE;
// Export singleton instances - tier selected from env (defaults to FREE)
export const jupiterRateLimiter = new AdvancedRateLimiter(jupiterConfig);
export const heliusRateLimiter = new AdvancedRateLimiter(heliusConfig);
