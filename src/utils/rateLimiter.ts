/**
 * API RATE LIMITER - Prevents 500 errors from API overload
 * Implements request queuing + exponential backoff + batching for parallel execution
 * OPTIMIZED: Supports batch execution for 5-10x faster scanning
 */

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
}

export class APIRateLimiter {
  private queue: QueuedRequest<any>[] = [];
  private processing = false;
  private lastBatchTime = 0;
  private MIN_INTERVAL = 200; // 200ms between batches (was 500ms)
  private BATCH_SIZE = 5; // Process up to 5 requests in parallel
  private batchTimeout: NodeJS.Timeout | null = null;
  
  /**
   * Execute an API call with rate limiting and retry logic
   * OPTIMIZED: Batches requests for parallel execution
   */
  async execute<T>(fn: () => Promise<T>, retries: number = 3): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn: async () => this.retryWithBackoff(fn, retries),
        resolve,
        reject
      });
      
      // Debounce processing to allow batching
      if (this.batchTimeout) {
        clearTimeout(this.batchTimeout);
      }
      this.batchTimeout = setTimeout(() => this.processBatch(), 10);
    });
  }
  
  /**
   * Execute multiple requests in a single batch
   * OPTIMIZED: Allows parallel execution within rate limits
   */
  async executeBatch<T>(fns: (() => Promise<T>)[], retries: number = 3): Promise<T[]> {
    const promises = fns.map(fn => this.execute(fn, retries));
    return Promise.all(promises);
  }
  
  /**
   * Retry function with exponential backoff
   */
  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const isLastAttempt = attempt === maxRetries - 1;
        
        // Check if it's a rate limit error (500 or 429)
        const isRateLimitError = 
          error?.message?.includes('500') || 
          error?.message?.includes('429') ||
          error?.message?.includes('rate limit');
        
        if (isLastAttempt || !isRateLimitError) {
          throw error;
        }
        
        // Exponential backoff: 1s, 2s, 4s
        const delayMs = 1000 * Math.pow(2, attempt);
        console.log(`⚠️ Rate limit error, retry ${attempt + 1}/${maxRetries} in ${delayMs}ms...`);
        await this.sleep(delayMs);
      }
    }
    throw new Error('Max retries exceeded');
  }
  
  /**
   * Process requests in batches for better performance
   * OPTIMIZED: Processes multiple requests in parallel
   */
  private async processBatch() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      // Enforce minimum interval between batches
      const now = Date.now();
      const timeSinceLastBatch = now - this.lastBatchTime;
      
      if (timeSinceLastBatch < this.MIN_INTERVAL) {
        const waitTime = this.MIN_INTERVAL - timeSinceLastBatch;
        await this.sleep(waitTime);
      }
      
      // Get next batch of tasks (up to BATCH_SIZE)
      const batch = this.queue.splice(0, this.BATCH_SIZE);
      
      // Execute batch in parallel
      await Promise.allSettled(
        batch.map(async (task) => {
          try {
            const result = await task.fn();
            task.resolve(result);
          } catch (error) {
            task.reject(error);
          }
        })
      );
      
      this.lastBatchTime = Date.now();
    }
    
    this.processing = false;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get queue stats for debugging
   */
  getStats() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      timeSinceLastBatch: Date.now() - this.lastBatchTime,
      minInterval: this.MIN_INTERVAL,
      batchSize: this.BATCH_SIZE
    };
  }
  
  /**
   * Update rate limiter settings (for tuning)
   */
  configure(options: { minInterval?: number; batchSize?: number }) {
    if (options.minInterval !== undefined) {
      this.MIN_INTERVAL = options.minInterval;
    }
    if (options.batchSize !== undefined) {
      this.BATCH_SIZE = options.batchSize;
    }
  }
}

// Global rate limiter instance
export const rateLimiter = new APIRateLimiter();
