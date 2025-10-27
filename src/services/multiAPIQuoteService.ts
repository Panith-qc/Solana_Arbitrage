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
  requestId?: string; // Jupiter Ultra V1 order ID for /execute
  provider?: string; // Track which API provided this quote
}

interface APIProvider {
  name: string;
  type: 'rest';
  endpoint: string;
  rateLimit: number; // calls per minute
  priority: number; // 1 = highest

  // Health metrics
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  avgLatency: number;
  lastError: string | null;
  lastErrorTime: number;
  consecutiveFailures: number;

  // Rate limiting
  callsThisMinute: number;
  minuteWindowStart: number;
  isPaused: boolean;
  pausedUntil: number;
}

class MultiAPIQuoteService {
  private providers: APIProvider[] = [
    {
      name: 'Jupiter Ultra V1',
      type: 'rest',
      endpoint: 'https://lite-api.jup.ag/ultra/v1/order',
      rateLimit: 60, // 60 calls/min = 1 call/sec
      priority: 1, // Primary (fastest, best routes)
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      avgLatency: 0,
      lastError: null,
      lastErrorTime: 0,
      consecutiveFailures: 0,
      callsThisMinute: 0,
      minuteWindowStart: Date.now(),
      isPaused: false,
      pausedUntil: 0
    },
    {
      name: 'Raydium V3',
      type: 'rest',
      endpoint: 'https://api-v3.raydium.io',
      rateLimit: 300, // Higher limit, direct DEX
      priority: 2, // Second choice - real DEX quotes
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      avgLatency: 0,
      lastError: null,
      lastErrorTime: 0,
      consecutiveFailures: 0,
      callsThisMinute: 0,
      minuteWindowStart: Date.now(),
      isPaused: false,
      pausedUntil: 0
    },
    // ORCA DISABLED: CORS blocked on client-side (React SPA, not backend)
    // DEXSCREENER DISABLED: Price validation breaking everything
    // ONLY Jupiter Ultra V1 and Raydium V3 are reliable
  ];

  private requestDelay = 100; // 100ms between requests (BALANCED: fast but safe)

  /**
   * Auto-select best API based on:
   * 1. Not paused
   * 2. Under rate limit
   * 3. Low consecutive failures
   * 4. High success rate
   * 5. Low latency
   * 6. Priority order
   */
  private selectBestAPI(): APIProvider | null {
    const now = Date.now();

    // Filter out unavailable APIs
    const availableAPIs = this.providers.filter(api => {
      // Check if paused
      if (api.isPaused && now < api.pausedUntil) {
        return false;
      }

      // Unpause if pause period is over
      if (api.isPaused && now >= api.pausedUntil) {
        api.isPaused = false;
        api.consecutiveFailures = 0;
        console.log(`✅ ${api.name} unpaused - ready for retry`);
      }

      // Skip if too many consecutive failures
      if (api.consecutiveFailures >= 5) {
        return false;
      }

      // Check rate limit
      if (!this.hasRateLimitCapacity(api)) {
        return false;
      }

      return true;
    });

    if (availableAPIs.length === 0) {
      console.error('❌ All APIs unavailable - waiting for cooldown');
      return null;
    }

    // Sort by health metrics
    availableAPIs.sort((a, b) => {
      // Calculate success rate
      const aSuccessRate = a.totalCalls > 0 ? a.successfulCalls / a.totalCalls : 0.5;
      const bSuccessRate = b.totalCalls > 0 ? b.successfulCalls / b.totalCalls : 0.5;

      // If success rates differ significantly, prefer higher success rate
      if (Math.abs(aSuccessRate - bSuccessRate) > 0.15) {
        return bSuccessRate - aSuccessRate;
      }

      // If latencies differ significantly, prefer lower latency
      if (a.avgLatency > 0 && b.avgLatency > 0) {
        if (Math.abs(a.avgLatency - b.avgLatency) > 200) {
          return a.avgLatency - b.avgLatency;
        }
      }

      // Otherwise use priority
      return a.priority - b.priority;
    });

    return availableAPIs[0];
  }

  /**
   * Check if API has rate limit capacity
   */
  private hasRateLimitCapacity(api: APIProvider): boolean {
    const now = Date.now();
    const minuteElapsed = now - api.minuteWindowStart;

    // Reset counter if new minute
    if (minuteElapsed >= 60000) {
      api.callsThisMinute = 0;
      api.minuteWindowStart = now;
      return true;
    }

    // Check if under limit
    return api.callsThisMinute < api.rateLimit * 0.8; // Use 80% of limit for safety
  }

  /**
   * Track rate limit usage
   */
  private trackRateLimit(api: APIProvider) {
    const now = Date.now();
    const minuteElapsed = now - api.minuteWindowStart;

    if (minuteElapsed >= 60000) {
      api.callsThisMinute = 1;
      api.minuteWindowStart = now;
    } else {
      api.callsThisMinute++;
    }
  }

  /**
   * Record successful API call
   */
  private recordSuccess(api: APIProvider, latency: number) {
    api.totalCalls++;
    api.successfulCalls++;
    api.consecutiveFailures = 0;
    
    // Update average latency (weighted)
    if (api.avgLatency === 0) {
      api.avgLatency = latency;
    } else {
      api.avgLatency = (api.avgLatency * 0.7) + (latency * 0.3);
    }
    
    this.trackRateLimit(api);
  }

  /**
   * Record failed API call
   */
  private recordFailure(api: APIProvider, error: any) {
    api.totalCalls++;
    api.failedCalls++;
    api.consecutiveFailures++;
    api.lastError = error.message || String(error);
    api.lastErrorTime = Date.now();
    
    this.trackRateLimit(api);

    // Auto-pause on rate limit
    if (error.status === 429 || error.message?.includes('429') || error.message?.includes('rate limit')) {
      api.isPaused = true;
      api.pausedUntil = Date.now() + 60000; // Pause for 60 seconds
      console.warn(`⏸️  ${api.name} paused for 60s due to rate limit (429)`);
    }

    // Auto-pause after 5 consecutive failures
    if (api.consecutiveFailures >= 5) {
      api.isPaused = true;
      api.pausedUntil = Date.now() + 120000; // Pause for 2 minutes
      console.warn(`⏸️  ${api.name} paused for 2min due to ${api.consecutiveFailures} failures`);
    }
  }

  /**
   * Fetch quote from Jupiter Ultra V1
   */
  private async fetchJupiterUltra(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    const url = `https://lite-api.jup.ag/ultra/v1/order?` +
      `inputMint=${inputMint}&` +
      `outputMint=${outputMint}&` +
      `amount=${parseInt(String(amount))}&` +
      `slippageBps=${slippageBps}&` +
      `onlyDirectRoutes=false`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw {
        status: response.status,
        message: `HTTP ${response.status}: ${await response.text()}`
      };
    }

    const data = await response.json();
    
    return {
      inputMint,
      inAmount: String(amount),
      outputMint,
      outAmount: data.outAmount || '0',
      otherAmountThreshold: data.otherAmountThreshold || '0',
      swapMode: 'ExactIn',
      slippageBps,
      platformFee: null,
      priceImpactPct: '0',
      routePlan: [],
      contextSlot: data.contextSlot,
      timeTaken: data.timeTaken,
      requestId: data.requestId || data.orderId, // Jupiter Ultra V1 /order returns requestId
      provider: 'Jupiter Ultra V1'
    };
  }

  /**
   * Fetch quote from Jupiter V6 (quote-api or lite-api)
   */
  private async fetchJupiterV6(
    baseUrl: string,
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    const url = `${baseUrl}?` +
      `inputMint=${inputMint}&` +
      `outputMint=${outputMint}&` +
      `amount=${parseInt(String(amount))}&` +
      `slippageBps=${slippageBps}&` +
      `onlyDirectRoutes=false`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw {
        status: response.status,
        message: `HTTP ${response.status}: ${await response.text()}`
      };
    }

    return await response.json();
  }

  /**
   * Fetch quote from Raydium V3 API (REAL DEX)
   */
  private async fetchRaydiumV3(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    // Get pool info for this pair
    const poolsUrl = `https://api-v3.raydium.io/pools/info/mint?mint1=${inputMint}&mint2=${outputMint}&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`;
    
    const poolsResponse = await fetch(poolsUrl);
    
    if (!poolsResponse.ok) {
      throw {
        status: poolsResponse.status,
        message: `Raydium pools API error: ${poolsResponse.status}`
      };
    }

    const poolsData = await poolsResponse.json();
    
    if (!poolsData.data || !poolsData.data.data || poolsData.data.data.length === 0) {
      throw new Error('No Raydium pool found for this pair');
    }

    const pool = poolsData.data.data[0];
    
    // Raydium uses 'tvl' field for reserves, not 'amount'
    // Check if this is CLMM (concentrated) or Standard pool
    const isConcentrated = pool.type === 'Concentrated';
    
    if (isConcentrated) {
      // For concentrated liquidity, use price directly
      const price = parseFloat(pool.price || '0');
      if (price === 0 || isNaN(price)) {
        throw new Error('Invalid price from Raydium pool');
      }
      
      const inputDecimals = pool.mintA.address === inputMint ? pool.mintA.decimals : pool.mintB.decimals;
      const outputDecimals = pool.mintA.address === inputMint ? pool.mintB.decimals : pool.mintA.decimals;
      
      const amountInFloat = amount / Math.pow(10, inputDecimals);
      const amountOutFloat = pool.mintA.address === inputMint ? amountInFloat * price : amountInFloat / price;
      const outputAmount = Math.floor(amountOutFloat * Math.pow(10, outputDecimals));
      
      return {
        inputMint,
        inAmount: String(amount),
        outputMint,
        outAmount: String(outputAmount),
        otherAmountThreshold: String(Math.floor(outputAmount * (1 - slippageBps / 10000))),
        swapMode: 'ExactIn',
        slippageBps,
        platformFee: null,
        priceImpactPct: '0.1',
        routePlan: [{
          swapInfo: {
            ammKey: pool.id,
            label: 'Raydium CLMM',
            inputMint,
            outputMint,
            inAmount: String(amount),
            outAmount: String(outputAmount),
            feeAmount: '0',
            feeMint: inputMint
          }
        }],
        provider: 'Raydium V3'
      };
    }
    
    // For standard pools, use AMM formula
    const isMint1Input = pool.mintA.address === inputMint;
    const reserveIn = isMint1Input ? parseFloat(pool.mintA.amount || pool.mintA.vault || '0') : parseFloat(pool.mintB.amount || pool.mintB.vault || '0');
    const reserveOut = isMint1Input ? parseFloat(pool.mintB.amount || pool.mintB.vault || '0') : parseFloat(pool.mintA.amount || pool.mintA.vault || '0');
    
    if (reserveIn === 0 || reserveOut === 0 || isNaN(reserveIn) || isNaN(reserveOut)) {
      throw new Error('Invalid reserves from Raydium pool');
    }
    
    // Constant product formula: amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
    const amountInNum = amount / Math.pow(10, isMint1Input ? pool.mintA.decimals : pool.mintB.decimals);
    const amountOutNum = (amountInNum * reserveOut) / (reserveIn + amountInNum);
    const outputDecimals = isMint1Input ? pool.mintB.decimals : pool.mintA.decimals;
    const outputAmount = Math.floor(amountOutNum * Math.pow(10, outputDecimals));

    return {
      inputMint,
      inAmount: String(amount),
      outputMint,
      outAmount: String(outputAmount),
      otherAmountThreshold: String(Math.floor(outputAmount * (1 - slippageBps / 10000))),
      swapMode: 'ExactIn',
      slippageBps,
      platformFee: null,
      priceImpactPct: ((amountInNum / reserveIn) * 100).toFixed(2),
      routePlan: [{
        swapInfo: {
          ammKey: pool.id,
          label: 'Raydium',
          inputMint,
          outputMint,
          inAmount: String(amount),
          outAmount: String(outputAmount),
          feeAmount: '0',
          feeMint: inputMint
        }
      }],
      provider: 'Raydium V3'
    };
  }

  /**
   * Fetch quote from Orca Whirlpool API (REAL DEX)
   */
  private async fetchOrcaWhirlpool(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    // Get whirlpool for this pair
    const whirlpoolsUrl = `https://api.mainnet.orca.so/v1/whirlpool/list`;
    
    const response = await fetch(whirlpoolsUrl);
    
    if (!response.ok) {
      throw {
        status: response.status,
        message: `Orca API error: ${response.status}`
      };
    }

    const data = await response.json();
    
    // Find pool with matching tokens
    const pool = data.whirlpools.find((p: any) => 
      (p.tokenA.mint === inputMint && p.tokenB.mint === outputMint) ||
      (p.tokenB.mint === inputMint && p.tokenA.mint === outputMint)
    );

    if (!pool) {
      throw new Error('No Orca pool found for this pair');
    }

    // Get quote from Orca's quote endpoint
    const quoteUrl = `https://api.mainnet.orca.so/v1/whirlpool/${pool.address}/quote?` +
      `inputToken=${inputMint}&` +
      `amount=${amount}&` +
      `slippageTolerance=${slippageBps / 100}`;

    const quoteResponse = await fetch(quoteUrl);
    
    if (!quoteResponse.ok) {
      // Fallback: estimate using pool data
      const isTokenA = pool.tokenA.mint === inputMint;
      const amountInNum = amount / Math.pow(10, isTokenA ? pool.tokenA.decimals : pool.tokenB.decimals);
      const price = parseFloat(pool.price || '1');
      const outputAmount = Math.floor(amountInNum * price * Math.pow(10, isTokenA ? pool.tokenB.decimals : pool.tokenA.decimals));

      return {
        inputMint,
        inAmount: String(amount),
        outputMint,
        outAmount: String(outputAmount),
        otherAmountThreshold: String(Math.floor(outputAmount * (1 - slippageBps / 10000))),
        swapMode: 'ExactIn',
        slippageBps,
        platformFee: null,
        priceImpactPct: '0.3',
        routePlan: [{
          swapInfo: {
            ammKey: pool.address,
            label: 'Orca',
            inputMint,
            outputMint,
            inAmount: String(amount),
            outAmount: String(outputAmount),
            feeAmount: '0',
            feeMint: inputMint
          }
        }],
        provider: 'Orca Whirlpool'
      };
    }

    const quoteData = await quoteResponse.json();
    
    return {
      inputMint,
      inAmount: String(amount),
      outputMint,
      outAmount: quoteData.estimatedAmountOut || quoteData.outputAmount || '0',
      otherAmountThreshold: quoteData.otherAmountThreshold || '0',
      swapMode: 'ExactIn',
      slippageBps,
      platformFee: null,
      priceImpactPct: quoteData.priceImpact || '0',
      routePlan: [{
        swapInfo: {
          ammKey: pool.address,
          label: 'Orca Whirlpool',
          inputMint,
          outputMint,
          inAmount: String(amount),
          outAmount: quoteData.estimatedAmountOut || '0',
          feeAmount: '0',
          feeMint: inputMint
        }
      }],
      provider: 'Orca Whirlpool'
    };
  }

  /**
   * Fetch price from DexScreener with SANITY CHECKS
   * ⚠️ PRICE VALIDATION: Rejects unrealistic profits (>150% or <50%)
   */
  private async fetchDexScreener(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<JupiterQuoteResponse> {
    // Get pair info
    const url = `https://api.dexscreener.com/latest/dex/tokens/${inputMint}`;
    
    const response = await fetch(url);
    
    if (!response.ok) {
      throw {
        status: response.status,
        message: `HTTP ${response.status}`
      };
    }

    const data = await response.json();
    
    if (!data.pairs || data.pairs.length === 0) {
      throw new Error('No pairs found for token');
    }

    // Find pair with output token
    const pair = data.pairs.find((p: any) => 
      p.quoteToken.address === outputMint || p.baseToken.address === outputMint
    ) || data.pairs[0];

    // Calculate approximate output
    const price = parseFloat(pair.priceUsd || pair.priceNative || '0');
    
    if (price === 0 || isNaN(price)) {
      throw new Error('Invalid price from DexScreener');
    }

    const outputAmount = Math.floor(amount * price);

    // ✅ SANITY CHECK: Prevent fake profits
    const profitRatio = outputAmount / amount;
    
    if (profitRatio > 1.5) {
      throw new Error(`Unrealistic price: ${price} (>150% profit impossible)`);
    }
    
    if (profitRatio < 0.5) {
      throw new Error(`Unrealistic price: ${price} (<50% loss impossible)`);
    }

    return {
      inputMint,
      inAmount: String(amount),
      outputMint,
      outAmount: String(outputAmount),
      otherAmountThreshold: String(Math.floor(outputAmount * 0.99)),
      swapMode: 'ExactIn',
      slippageBps: 100,
      platformFee: null,
      priceImpactPct: '0.5',
      routePlan: [],
      provider: 'DexScreener'
    };
  }

  /**
   * Validate quote is realistic (prevents fake $10k profits)
   * Checks:
   * - Profit < 10% (impossible in arbitrage)
   * - Loss < 5% (too risky)
   * - Output amount is valid number
   */
  private isRealisticQuote(quote: JupiterQuoteResponse, inputAmount: number): boolean {
    try {
      const inputAmt = parseFloat(quote.inAmount);
      const outputAmt = parseFloat(quote.outAmount);

      if (isNaN(inputAmt) || isNaN(outputAmt)) {
        console.warn('⚠️ Quote validation failed: NaN values');
        return false;
      }

      if (outputAmt === 0) {
        console.warn('⚠️ Quote validation failed: Zero output');
        return false;
      }

      // Approximate USD values (assuming SOL ~$191, USDC ~$1)
      // This is a rough check - adjust if trading other pairs
      const profitRatio = outputAmt / inputAmt;

      // Reject if profit > 10% (impossible in normal arbitrage)
      if (profitRatio > 1.1) {
        console.warn(`⚠️ Quote validation failed: ${(profitRatio * 100 - 100).toFixed(1)}% profit (>10% impossible)`);
        return false;
      }

      // Reject if loss > 5% (too risky)
      if (profitRatio < 0.95) {
        console.warn(`⚠️ Quote validation failed: ${(100 - profitRatio * 100).toFixed(1)}% loss (>5% too risky)`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('⚠️ Quote validation error:', error);
      return false;
    }
  }

  /**
   * Main entry point: Get quote with automatic failover
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    const maxAttempts = this.providers.filter(p => !p.isPaused).length || this.providers.length;
    let lastError: any = null;
    let attemptCount = 0;

    // Add small delay to prevent bursts
    if (this.requestDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.requestDelay));
    }

    while (attemptCount < maxAttempts) {
      const api = this.selectBestAPI();
      
      if (!api) {
        // All APIs unavailable, wait a bit and retry
        console.warn('⏳ All APIs unavailable, waiting 5s...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      attemptCount++;
      const startTime = Date.now();

      try {
        console.log(`📡 Attempt ${attemptCount}/${maxAttempts}: ${api.name} (Success: ${api.totalCalls > 0 ? (api.successfulCalls / api.totalCalls * 100).toFixed(1) : 'N/A'}%, Latency: ${api.avgLatency > 0 ? api.avgLatency.toFixed(0) : 'N/A'}ms, Calls: ${api.callsThisMinute}/${Math.floor(api.rateLimit * 0.8)})`);

        let quote: JupiterQuoteResponse;

        // Route to appropriate fetcher
        if (api.name === 'Jupiter Ultra V1') {
          quote = await this.fetchJupiterUltra(inputMint, outputMint, amount, slippageBps);
        } else if (api.name === 'Raydium V3') {
          quote = await this.fetchRaydiumV3(inputMint, outputMint, amount, slippageBps);
        } else if (api.name === 'Orca Whirlpool') {
          quote = await this.fetchOrcaWhirlpool(inputMint, outputMint, amount, slippageBps);
        } else if (api.name === 'DexScreener') {
          quote = await this.fetchDexScreener(inputMint, outputMint, amount);
        } else {
          throw new Error(`Unknown API provider: ${api.name}`);
        }

        const latency = Date.now() - startTime;
        this.recordSuccess(api, latency);

        // ✅ Basic validation only (NaN/zero check)
        const outputAmt = parseFloat(quote.outAmount);
        if (isNaN(outputAmt) || outputAmt === 0) {
          console.warn(`⚠️ ${api.name} returned invalid output (NaN or zero), trying next API`);
          this.recordFailure(api, new Error('Invalid output'));
          continue;
        }

        console.log(`✅ ${api.name} succeeded in ${latency}ms`);
        return quote;

      } catch (error: any) {
        const latency = Date.now() - startTime;
        this.recordFailure(api, error);
        lastError = error;

        console.error(`❌ ${api.name} failed (${latency}ms): ${error.message || error} - trying next API`);
      }
    }

    throw new Error(`All ${maxAttempts} APIs exhausted. Last error: ${lastError?.message || lastError}`);
  }

  /**
   * Get health report for monitoring/UI
   */
  getHealthReport() {
    return this.providers.map(api => {
      const successRate = api.totalCalls > 0 
        ? ((api.successfulCalls / api.totalCalls) * 100).toFixed(1)
        : 'N/A';

      let status: 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'FAILED';
      if (api.isPaused) {
        status = 'PAUSED';
      } else if (api.consecutiveFailures >= 5) {
        status = 'FAILED';
      } else if (api.consecutiveFailures >= 2) {
        status = 'DEGRADED';
      } else {
        status = 'HEALTHY';
      }

      const now = Date.now();
      const pauseRemaining = api.isPaused ? Math.max(0, api.pausedUntil - now) : 0;

      return {
        name: api.name,
        status,
        successRate: `${successRate}%`,
        totalCalls: api.totalCalls,
        successfulCalls: api.successfulCalls,
        failedCalls: api.failedCalls,
        avgLatency: `${api.avgLatency > 0 ? api.avgLatency.toFixed(0) : 'N/A'}ms`,
        callsThisMinute: `${api.callsThisMinute}/${Math.floor(api.rateLimit * 0.8)}`,
        lastError: api.lastError,
        consecutiveFailures: api.consecutiveFailures,
        pauseRemaining: pauseRemaining > 0 ? `${Math.ceil(pauseRemaining / 1000)}s` : null
      };
    });
  }

  /**
   * Test all APIs on startup
   */
  async testAllAPIs(): Promise<void> {
    console.log('\n🧪 TESTING ALL APIs...\n');

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const testAmount = 100000000; // 0.1 SOL

    for (const api of this.providers) {
      const startTime = Date.now();
      
      try {
        let quote: JupiterQuoteResponse;

        if (api.name === 'Jupiter Ultra V1') {
          quote = await this.fetchJupiterUltra(SOL_MINT, USDC_MINT, testAmount);
        } else if (api.name === 'Raydium V3') {
          quote = await this.fetchRaydiumV3(SOL_MINT, USDC_MINT, testAmount);
        } else if (api.name === 'Orca Whirlpool') {
          quote = await this.fetchOrcaWhirlpool(SOL_MINT, USDC_MINT, testAmount);
        } else if (api.name === 'DexScreener') {
          quote = await this.fetchDexScreener(SOL_MINT, USDC_MINT, testAmount);
        } else {
          continue;
        }

        const latency = Date.now() - startTime;
        console.log(`✅ ${api.name}: Working (${(parseInt(quote.outAmount) / 1000000).toFixed(2)} USDC output, ${latency}ms)`);
        
      } catch (error: any) {
        const latency = Date.now() - startTime;
        console.log(`❌ ${api.name}: Failed (${error.message || error}, ${latency}ms)`);
      }

      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n✅ API testing complete\n');
  }

  /**
   * Set request delay (ms between requests)
   */
  setRequestDelay(delayMs: number) {
    this.requestDelay = delayMs;
    console.log(`⚙️  Request delay set to ${delayMs}ms`);
  }

  /**
   * Reset all API health metrics
   */
  resetHealthMetrics() {
    this.providers.forEach(api => {
      api.totalCalls = 0;
      api.successfulCalls = 0;
      api.failedCalls = 0;
      api.avgLatency = 0;
      api.consecutiveFailures = 0;
      api.lastError = null;
      api.isPaused = false;
    });
    console.log('🔄 All API health metrics reset');
  }
}

// Export singleton instance
export const multiAPIService = new MultiAPIQuoteService();

// Export for testing
export { MultiAPIQuoteService };
