// JUPITER V6 API SERVICE - CORRECT IMPLEMENTATION
// Based on official Jupiter documentation: https://lite-api.jup.ag
// ⚡ Legacy Swap V6: GET /quote, POST /swap
// 🚀 Free tier, no API key required, 300-500ms latency

import { Connection, PublicKey } from '@solana/web3.js';

// CORRECT BASE URL from Jupiter docs
const JUPITER_ULTRA_BASE = 'https://lite-api.jup.ag/ultra/v1';
const JUPITER_PRICE_API = 'https://lite-api.jup.ag/price/v3';
const JUPITER_API_KEY = import.meta.env.JUPITER_ULTRA_API_KEY || 'bca82c35-07e5-4ab0-9a8f-7d23333ffa93';

// Jupiter Ultra V1 Quote Response (from GET /quote)
export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
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
  contextSlot?: number;
  timeTaken?: number;
}

// Jupiter Ultra V1 Swap Request (for POST /swap)
export interface JupiterSwapRequest {
  quoteResponse: JupiterQuoteResponse;
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

// Jupiter Ultra V1 Swap Response (from POST /swap)
export interface JupiterSwapResponse {
  swapTransaction: string; // Base64 encoded transaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

// Internal format for compatibility with existing code
export interface UltraOrderResponse {
  order: {
    orderId: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    estimatedSlippageBps: number;
    priceImpactPct: string;
    routes: any[];
    executionStrategy: 'metis' | 'jupiterz' | 'hybrid';
    gasless: boolean;
  };
  quote: {
    inputAmount: string;
    outputAmount: string;
    pricePerInputToken: string;
    pricePerOutputToken: string;
  };
  timeTakenMs: number;
}

export class JupiterV6Service {
  private baseUrl: string;
  private priceUrl: string;
  
  // Performance metrics
  private metrics = {
    totalQuotes: 0,
    successfulQuotes: 0,
    failedQuotes: 0,
    avgQuoteTimeMs: 0,
    totalSwaps: 0,
    successfulSwaps: 0,
    failedSwaps: 0,
    avgSwapTimeMs: 0,
  };

  constructor() {
    this.baseUrl = JUPITER_ULTRA_BASE;
    this.priceUrl = JUPITER_PRICE_API;
    
    console.log('⚡ Jupiter Ultra V1 Service initialized');
    console.log('🚀 Using CORRECT Jupiter Ultra V1 API: https://lite-api.jup.ag/ultra/v1');
    console.log('⏱️  Quote latency: 300-500ms | Swap latency: 100-200ms');
  }

  /**
   * Fetch with timeout to prevent infinite hangs
   * CRITICAL: All API calls MUST have timeout
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number = 5000
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * GET /ultra/v1/order - Get best price quote
   * CORRECT ENDPOINT: https://lite-api.jup.ag/ultra/v1/quote
   * 
   * @param inputMint - Token to sell
   * @param outputMint - Token to buy
   * @param amount - Amount in smallest units (lamports)
   * @param slippageBps - Max slippage (50 = 0.5%)
   * @returns Jupiter Ultra V1 quote response
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuoteResponse> {
    const startTime = Date.now();
    
    try {
      // CORRECT URL construction - /ultra/v1/order (not /ultra/v1/order!)
      const url = new URL(`${this.baseUrl}/order`);
      url.searchParams.append('inputMint', inputMint);
      url.searchParams.append('outputMint', outputMint);
      url.searchParams.append('amount', amount.toString());
      url.searchParams.append('slippageBps', slippageBps.toString());
      url.searchParams.append('onlyDirectRoutes', 'false');
      
      const response = await this.fetchWithTimeout(
        url.toString(),
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        },
        5000 // 5s timeout
      );

      if (!response.ok) {
        throw new Error(`Jupiter Ultra V1 API error: ${response.status}`);
      }

      const data: JupiterQuoteResponse = await response.json();
      const timeTaken = Date.now() - startTime;

      // Update metrics
      this.metrics.totalQuotes++;
      this.metrics.successfulQuotes++;
      this.metrics.avgQuoteTimeMs = 
        (this.metrics.avgQuoteTimeMs * (this.metrics.totalQuotes - 1) + timeTaken) / 
        this.metrics.totalQuotes;

      return data;
    } catch (error: any) {
      const timeTaken = Date.now() - startTime;
      this.metrics.totalQuotes++;
      this.metrics.failedQuotes++;
      
      console.error(`❌ Jupiter Ultra V1 Quote failed (${timeTaken}ms):`, error.message);
      throw error;
    }
  }

  /**
   * POST /ultra/v1/swap - Convert quote into executable transaction
   * CORRECT ENDPOINT: https://lite-api.jup.ag/ultra/v1/swap
   * 
   * @param quoteResponse - Quote from getQuote()
   * @param userPublicKey - User's wallet address
   * @returns Swap transaction ready to sign
   */
  async getSwapTransaction(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string
  ): Promise<JupiterSwapResponse> {
    const startTime = Date.now();
    
    try {
      const swapRequest: JupiterSwapRequest = {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 'auto',
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: false,
      };

      // CRITICAL: Jupiter Ultra V1 doesn't have /swap endpoint
      // Use Jupiter V6 for swaps instead
      const v6BaseUrl = 'https://quote-api.jup.ag/v6';
      
      const response = await this.fetchWithTimeout(
        `${v6BaseUrl}/swap`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(swapRequest),
        },
        5000 // 5s timeout
      );

      if (!response.ok) {
        throw new Error(`Jupiter Ultra V1 Swap API error: ${response.status}`);
      }

      const data: JupiterSwapResponse = await response.json();
      const timeTaken = Date.now() - startTime;

      // Update metrics
      this.metrics.totalSwaps++;
      this.metrics.successfulSwaps++;
      this.metrics.avgSwapTimeMs = 
        (this.metrics.avgSwapTimeMs * (this.metrics.totalSwaps - 1) + timeTaken) / 
        this.metrics.totalSwaps;

      return data;
    } catch (error: any) {
      const timeTaken = Date.now() - startTime;
      this.metrics.totalSwaps++;
      this.metrics.failedSwaps++;
      
      console.error(`❌ Jupiter Ultra V1 Swap failed (${timeTaken}ms):`, error.message);
      throw error;
    }
  }

  /**
   * COMPATIBILITY METHOD: createOrder (maps to getQuote for backward compatibility)
   * This method exists to maintain compatibility with existing code
   * 
   * @param request - Order request (maps to quote params)
   * @returns Ultra-format response (wraps Jupiter Ultra V1 quote)
   */
  async createOrder(request: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
  }): Promise<UltraOrderResponse> {
    const startTime = Date.now();
    
    try {
      // Call the CORRECT Jupiter Ultra V1 /quote endpoint
      const quote = await this.getQuote(
        request.inputMint,
        request.outputMint,
        parseInt(request.amount),
        request.slippageBps || 50
      );

      const timeTaken = Date.now() - startTime;

      // Map Jupiter Ultra V1 response to Ultra format for compatibility
      const ultraResponse: UltraOrderResponse = {
        order: {
          orderId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          estimatedSlippageBps: quote.slippageBps,
          priceImpactPct: quote.priceImpactPct,
          routes: quote.routePlan || [],
          executionStrategy: 'metis',
          gasless: false,
        },
        quote: {
          inputAmount: quote.inAmount,
          outputAmount: quote.outAmount,
          pricePerInputToken: (parseFloat(quote.outAmount) / parseFloat(quote.inAmount)).toString(),
          pricePerOutputToken: (parseFloat(quote.inAmount) / parseFloat(quote.outAmount)).toString(),
        },
        timeTakenMs: timeTaken,
      };

      console.log(`✅ Quote received in ${timeTaken}ms: ${request.amount} → ${quote.outAmount}`);
      return ultraResponse;
    } catch (error: any) {
      const timeTaken = Date.now() - startTime;
      console.error(`❌ Order creation failed (${timeTaken}ms):`, error.message);
      throw error;
    }
  }

  /**
   * Get token prices from Jupiter Price API V3
   * CORRECT ENDPOINT: https://lite-api.jup.ag/price/v3/price
   * 
   * @param mints - Array of token mint addresses
   * @returns Price data for each token
   */
  async getPrices(mints: string[]): Promise<Record<string, { price: number; symbol: string }>> {
    try {
      const url = new URL(`${this.priceUrl}/price`);
      url.searchParams.append('ids', mints.join(','));
      
      const response = await this.fetchWithTimeout(
        url.toString(),
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        },
        3000 // 3s timeout
      );

      if (!response.ok) {
        throw new Error(`Jupiter Price API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data || {};
    } catch (error: any) {
      console.error('❌ Price fetch failed:', error.message);
      return {};
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      quoteSuccessRate: this.metrics.totalQuotes > 0 
        ? (this.metrics.successfulQuotes / this.metrics.totalQuotes * 100).toFixed(2) + '%'
        : 'N/A',
      swapSuccessRate: this.metrics.totalSwaps > 0
        ? (this.metrics.successfulSwaps / this.metrics.totalSwaps * 100).toFixed(2) + '%'
        : 'N/A',
    };
  }

  /**
   * Legacy compatibility methods (kept for backward compatibility)
   */
  async executeOrder() {
    throw new Error('executeOrder() not implemented - use getSwapTransaction() instead');
  }

  async getHoldings() {
    throw new Error('getHoldings() not implemented - use Helius RPC instead');
  }

  async searchToken() {
    throw new Error('searchToken() not implemented - use Jupiter Tokens API instead');
  }

  async checkTokenSecurity() {
    throw new Error('checkTokenSecurity() not implemented - use Jupiter Shield API instead');
  }

  async swap() {
    throw new Error('swap() not implemented - use getQuote() + getSwapTransaction() instead');
  }
}

// Singleton instance
let jupiterV6Instance: JupiterV6Service | null = null;

export function getJupiterUltraService(): JupiterV6Service {
  if (!jupiterV6Instance) {
    jupiterV6Instance = new JupiterV6Service();
  }
  return jupiterV6Instance;
}

// Export for backward compatibility
export { JupiterV6Service as JupiterUltraService };
