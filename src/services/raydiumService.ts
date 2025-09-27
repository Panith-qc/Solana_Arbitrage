import { enhancedCorsProxy } from './enhancedCorsProxy';

interface RaydiumQuoteResponse {
  dex: string;
  price: number;
  outputAmount: number;
  success: boolean;
}

interface RaydiumApiResponse {
  data?: {
    outAmount?: string;
    length?: number;
    [key: string]: unknown;
  };
}

interface RaydiumPool {
  baseReserve?: string;
  quoteReserve?: string;
  reserve0?: string;
  reserve1?: string;
  [key: string]: unknown;
}

interface RaydiumPoolsResponse {
  data?: RaydiumPool[];
}

interface RaydiumPriceResponse {
  data?: {
    [mint: string]: string;
  };
}

export class RaydiumService {
  private readonly RAYDIUM_API_BASE = 'https://api.raydium.io';

  constructor() {
    // Initialize service
  }

  async getQuote(inputMint: string, outputMint: string, amount: number): Promise<RaydiumQuoteResponse> {
    try {
      // Raydium quote endpoint
      const url = `${this.RAYDIUM_API_BASE}/v2/ammV3/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
      
      const response = await enhancedCorsProxy.fetchWithFallback(url) as RaydiumApiResponse;
      
      if (response.data && response.data.outAmount) {
        const outputAmount = parseInt(response.data.outAmount);
        const price = amount / outputAmount;
        
        console.log(`📊 Raydium quote: ${amount} → ${outputAmount} | Price: ${price.toFixed(8)}`);
        
        return {
          dex: 'Raydium',
          price: price,
          outputAmount: outputAmount,
          success: true
        };
      }
      
      // Fallback to pool-based pricing if direct quote fails
      return await this.getPoolBasedQuote(inputMint, outputMint, amount);
      
    } catch (error) {
      console.error('❌ Raydium quote error:', error);
      return { dex: 'Raydium', price: 0, outputAmount: 0, success: false };
    }
  }

  private async getPoolBasedQuote(inputMint: string, outputMint: string, amount: number): Promise<RaydiumQuoteResponse> {
    try {
      // Get pool information for the token pair
      const poolsUrl = `${this.RAYDIUM_API_BASE}/v2/ammV3/pools?inputMint=${inputMint}&outputMint=${outputMint}`;
      const poolsResponse = await enhancedCorsProxy.fetchWithFallback(poolsUrl) as RaydiumPoolsResponse;
      
      if (poolsResponse.data && poolsResponse.data.length > 0) {
        const pool = poolsResponse.data[0]; // Use the first (most liquid) pool
        
        // Simple constant product formula estimation
        // This is a simplified calculation - in production you'd want more sophisticated pricing
        const reserveIn = parseFloat(pool.baseReserve || pool.reserve0 || '1000000');
        const reserveOut = parseFloat(pool.quoteReserve || pool.reserve1 || '1000000');
        
        // Constant product formula: (x + Δx)(y - Δy) = xy
        const outputAmount = Math.floor((amount * reserveOut) / (reserveIn + amount));
        const price = amount / outputAmount;
        
        console.log(`📊 Raydium pool quote: ${amount} → ${outputAmount} | Price: ${price.toFixed(8)}`);
        
        return {
          dex: 'Raydium',
          price: price,
          outputAmount: outputAmount,
          success: true
        };
      }
      
      return { dex: 'Raydium', price: 0, outputAmount: 0, success: false };
      
    } catch (error) {
      console.error('❌ Raydium pool quote error:', error);
      return { dex: 'Raydium', price: 0, outputAmount: 0, success: false };
    }
  }

  async getPools(inputMint?: string, outputMint?: string): Promise<RaydiumPool[]> {
    try {
      let url = `${this.RAYDIUM_API_BASE}/v2/ammV3/pools`;
      const params = new URLSearchParams();
      
      if (inputMint) params.append('inputMint', inputMint);
      if (outputMint) params.append('outputMint', outputMint);
      
      if (params.toString()) {
        url += `?${params.toString()}`;
      }
      
      const response = await enhancedCorsProxy.fetchWithFallback(url) as RaydiumPoolsResponse;
      return response.data || [];
      
    } catch (error) {
      console.error('❌ Raydium pools error:', error);
      return [];
    }
  }

  async getTokenPrice(mint: string): Promise<number> {
    try {
      const url = `${this.RAYDIUM_API_BASE}/v2/main/price?mints=${mint}`;
      const response = await enhancedCorsProxy.fetchWithFallback(url) as RaydiumPriceResponse;
      
      if (response.data && response.data[mint]) {
        return parseFloat(response.data[mint]);
      }
      
      return 0;
    } catch (error) {
      console.error('❌ Raydium price error:', error);
      return 0;
    }
  }
}