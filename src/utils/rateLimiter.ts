/**
 * API RATE LIMITER - Prevents 500 errors from API overload
 * Implements request queuing + exponential backoff + 500ms minimum interval
 */

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
}

export class APIRateLimiter {
  private queue: QueuedRequest<any>[] = [];
  private processing = false;
  private lastRequestTime = 0;
  private MIN_INTERVAL = 500; // 500ms between requests (2 requests/second max)
  
  /**
   * Execute an API call with rate limiting and retry logic
   */
  async execute<T>(fn: () => Promise<T>, retries: number = 3): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn: async () => this.retryWithBackoff(fn, retries),
        resolve,
        reject
      });
      this.processQueue();
    });
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
   * Process the request queue one at a time
   */
  private async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      
      // Enforce minimum interval between requests
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      
      if (timeSinceLastRequest < this.MIN_INTERVAL) {
        const waitTime = this.MIN_INTERVAL - timeSinceLastRequest;
        await this.sleep(waitTime);
      }
      
      // Execute the task
      try {
        const result = await task.fn();
        this.lastRequestTime = Date.now();
        task.resolve(result);
      } catch (error) {
        this.lastRequestTime = Date.now();
        task.reject(error);
      }
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
      timeSinceLastRequest: Date.now() - this.lastRequestTime,
      minInterval: this.MIN_INTERVAL
    };
  }
}

// Global rate limiter instance
export const rateLimiter = new APIRateLimiter();
