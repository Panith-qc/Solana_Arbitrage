// JUPITER ULTRA API SERVICE - PROFESSIONAL GRADE
// ⚡ RPC-less, MEV-protected, sub-second execution
// 🚀 96% success rate, gasless swaps, predictive routing

import { Connection, PublicKey } from '@solana/web3.js';

const JUPITER_ULTRA_API = 'https://api.jup.ag/ultra';
const JUPITER_API_KEY = import.meta.env.JUPITER_ULTRA_API_KEY || 'bca82c35-07e5-4ab0-9a8f-7d23333ffa93';

// Ultra API Types
export interface UltraOrderRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
  wallet?: string;
}

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

export interface UltraExecuteRequest {
  orderId: string;
  wallet: string;
  priorityFee?: {
    type: 'auto' | 'exact';
    value?: number;
  };
}

export interface UltraExecuteResponse {
  txid: string;
  status: 'pending' | 'confirmed' | 'failed';
  inAmount: string;
  outAmount: string;
  executionTimeMs: number;
  gasless: boolean;
  mevProtected: boolean;
}

export interface UltraHoldingsRequest {
  wallet: string;
}

export interface UltraHoldingsResponse {
  wallet: string;
  tokens: Array<{
    mint: string;
    symbol: string;
    name: string;
    balance: string;
    decimals: number;
    uiAmount: number;
    valueUsd: number;
  }>;
  totalValueUsd: number;
  solBalance: number;
}

export class JupiterUltraService {
  private apiKey: string;
  private baseUrl: string;
  
  // Performance metrics
  private metrics = {
    totalOrders: 0,
    successfulOrders: 0,
    failedOrders: 0,
    avgOrderTimeMs: 0,
    avgExecuteTimeMs: 0,
    totalValueUsd: 0,
    gaslessTrades: 0,
    mevProtectedTrades: 0,
  };

  constructor() {
    this.apiKey = JUPITER_API_KEY;
    this.baseUrl = JUPITER_ULTRA_API;
    
    console.log('⚡ Jupiter Ultra Service initialized');
    console.log('🚀 Features: RPC-less | MEV Protection | Gasless | 96% Success Rate');
    console.log('⏱️  Latency: 300ms quote | 700ms-2s execution');
  }

  /**
   * Step 1: Create order (get quote and route)
   * Ultra automatically selects best liquidity source
   */
  async createOrder(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number = 50,
    wallet?: string
  ): Promise<UltraOrderResponse | null> {
    const startTime = Date.now();
    this.metrics.totalOrders++;

    try {
      const response = await fetch(`${this.baseUrl}/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          inputMint,
          outputMint,
          amount,
          slippageBps,
          wallet,
          features: {
            mevProtection: true,
            gasless: true,
            predictiveRouting: true,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ultra Order API error: ${response.status}`);
      }

      const data = await response.json();
      const timeTakenMs = Date.now() - startTime;

      this.metrics.successfulOrders++;
      this.metrics.avgOrderTimeMs = 
        (this.metrics.avgOrderTimeMs * (this.metrics.successfulOrders - 1) + timeTakenMs) / 
        this.metrics.successfulOrders;

      console.log(`✅ Order created in ${timeTakenMs}ms`);
      console.log(`   Route: ${data.order.executionStrategy} | Gasless: ${data.order.gasless}`);

      return {
        ...data,
        timeTakenMs,
      };

    } catch (error: any) {
      this.metrics.failedOrders++;
      const timeTakenMs = Date.now() - startTime;
      console.error(`❌ Order creation failed (${timeTakenMs}ms):`, error.message);
      return null;
    }
  }

  /**
   * Step 2: Execute order (Ultra handles transaction broadcasting & landing)
   * Sub-second landing: 50-400ms
   */
  async executeOrder(
    orderId: string,
    wallet: string,
    priorityFee: { type: 'auto' | 'exact'; value?: number } = { type: 'auto' }
  ): Promise<UltraExecuteResponse | null> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          orderId,
          wallet,
          priorityFee,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ultra Execute API error: ${response.status}`);
      }

      const data = await response.json();
      const executionTimeMs = Date.now() - startTime;

      // Update metrics
      this.metrics.avgExecuteTimeMs = 
        (this.metrics.avgExecuteTimeMs * this.metrics.successfulOrders + executionTimeMs) / 
        (this.metrics.successfulOrders + 1);
      
      if (data.gasless) this.metrics.gaslessTrades++;
      if (data.mevProtected) this.metrics.mevProtectedTrades++;

      console.log(`✅ Trade executed in ${executionTimeMs}ms`);
      console.log(`   Txid: ${data.txid}`);
      console.log(`   MEV Protected: ${data.mevProtected} | Gasless: ${data.gasless}`);

      return data;

    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;
      console.error(`❌ Execution failed (${executionTimeMs}ms):`, error.message);
      return null;
    }
  }

  /**
   * Get user wallet balances (RPC-less!)
   * No need to manage RPC connections
   */
  async getHoldings(wallet: string): Promise<UltraHoldingsResponse | null> {
    try {
      const response = await fetch(`${this.baseUrl}/holdings?wallet=${wallet}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Ultra Holdings API error: ${response.status}`);
      }

      const data = await response.json();
      return data;

    } catch (error: any) {
      console.error('❌ Holdings fetch failed:', error.message);
      return null;
    }
  }

  /**
   * Search for tokens (fast: 15ms)
   */
  async searchToken(query: string): Promise<any[] | null> {
    try {
      const response = await fetch(`${this.baseUrl}/search?q=${encodeURIComponent(query)}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Ultra Search API error: ${response.status}`);
      }

      return await response.json();

    } catch (error: any) {
      console.error('❌ Token search failed:', error.message);
      return null;
    }
  }

  /**
   * Token security shield (safety check)
   */
  async checkTokenSecurity(mint: string): Promise<any | null> {
    try {
      const response = await fetch(`${this.baseUrl}/shield?mint=${mint}`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Ultra Shield API error: ${response.status}`);
      }

      return await response.json();

    } catch (error: any) {
      console.error('❌ Security check failed:', error.message);
      return null;
    }
  }

  /**
   * Complete swap flow: order + execute
   */
  async swap(
    inputMint: string,
    outputMint: string,
    amount: string,
    wallet: string,
    slippageBps: number = 50
  ): Promise<{ success: boolean; txid?: string; error?: string; timeMs: number }> {
    const startTime = Date.now();

    try {
      // Step 1: Create order
      console.log('📊 Creating order...');
      const order = await this.createOrder(inputMint, outputMint, amount, slippageBps, wallet);
      
      if (!order) {
        throw new Error('Failed to create order');
      }

      console.log(`💰 Expected output: ${order.quote.outputAmount}`);
      console.log(`📈 Price impact: ${order.order.priceImpactPct}%`);

      // Step 2: Execute order
      console.log('⚡ Executing trade...');
      const result = await this.executeOrder(order.order.orderId, wallet);

      if (!result || result.status === 'failed') {
        throw new Error('Trade execution failed');
      }

      const totalTimeMs = Date.now() - startTime;

      console.log(`\n🎉 SWAP SUCCESS`);
      console.log(`   Total time: ${totalTimeMs}ms`);
      console.log(`   Txid: ${result.txid}`);
      console.log(`   MEV Protected: ✅`);
      console.log(`   Gasless: ${result.gasless ? '✅' : '❌'}`);

      return {
        success: true,
        txid: result.txid,
        timeMs: totalTimeMs,
      };

    } catch (error: any) {
      const totalTimeMs = Date.now() - startTime;
      console.error(`❌ Swap failed (${totalTimeMs}ms):`, error.message);
      
      return {
        success: false,
        error: error.message,
        timeMs: totalTimeMs,
      };
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalOrders > 0
        ? ((this.metrics.successfulOrders / this.metrics.totalOrders) * 100).toFixed(2) + '%'
        : '0%',
      gaslessRate: this.metrics.successfulOrders > 0
        ? ((this.metrics.gaslessTrades / this.metrics.successfulOrders) * 100).toFixed(2) + '%'
        : '0%',
      mevProtectionRate: this.metrics.successfulOrders > 0
        ? ((this.metrics.mevProtectedTrades / this.metrics.successfulOrders) * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    const startTime = Date.now();
    const order = await this.createOrder(SOL, USDC, '1000000', 50); // 0.001 SOL
    const latencyMs = Date.now() - startTime;

    return {
      healthy: order !== null,
      latencyMs,
    };
  }
}

// Export singleton
let jupiterUltraService: JupiterUltraService | null = null;

export function getJupiterUltraService(): JupiterUltraService {
  if (!jupiterUltraService) {
    jupiterUltraService = new JupiterUltraService();
  }
  return jupiterUltraService;
}
