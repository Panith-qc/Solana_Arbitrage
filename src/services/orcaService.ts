import { enhancedCorsProxy } from './enhancedCorsProxy';

interface OrcaQuoteResponse {
  dex: string;
  price: number;
  outputAmount: number;
  success: boolean;
}

interface OrcaPool {
  tokenA?: {
    mint: string;
  };
  tokenB?: {
    mint: string;
  };
  tokenAReserve?: string;
  tokenBReserve?: string;
  tvl?: string;
}

interface OrcaPoolsResponse {
  whirlpools?: OrcaPool[];
}

export class OrcaService {
  private readonly ORCA_API_BASE = 'https://api.orca.so';

  constructor() {
    // Initialize service
  }

  async getQuote(inputMint: string, outputMint: string, amount: number): Promise<OrcaQuoteResponse> {
    try {
      // Orca quote endpoint
      const url = `${this.ORCA_API_BASE}/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
      
      const response = await enhancedCorsProxy.fetchWithFallback(url) as { outAmount?: string };
      
      if (response.outAmount) {
        const outputAmount = parseInt(response.outAmount);
        const price = amount / outputAmount;
        
        console.log(`📊 Orca quote: ${amount} → ${outputAmount} | Price: ${price.toFixed(8)}`);
        
        return {
          dex: 'Orca',
          price: price,
          outputAmount: outputAmount,
          success: true
        };
      }
      
      // Fallback to pool-based pricing if direct quote fails
      return await this.getPoolBasedQuote(inputMint, outputMint, amount);
      
    } catch (error) {
      console.error('❌ Orca quote error:', error);
      return { dex: 'Orca', price: 0, outputAmount: 0, success: false };
    }
  }

  private async getPoolBasedQuote(inputMint: string, outputMint: string, amount: number): Promise<OrcaQuoteResponse> {
    try {
      // Get Orca pools for the token pair
      const poolsResponse = await this.getTokenPools(inputMint, outputMint);
      
      if (poolsResponse.length > 0) {
        const pool = poolsResponse[0]; // Use the most liquid pool
        
        // Estimate output using pool reserves
        const reserveIn = parseFloat(pool.tokenAReserve || '1000000');
        const reserveOut = parseFloat(pool.tokenBReserve || '1000000');
        
        // Simple constant product formula
        const outputAmount = Math.floor((amount * reserveOut) / (reserveIn + amount));
        const price = amount / outputAmount;
        
        console.log(`📊 Orca pool quote: ${amount} → ${outputAmount} | Price: ${price.toFixed(8)}`);
        
        return {
          dex: 'Orca',
          price: price,
          outputAmount: outputAmount,
          success: true
        };
      }
      
      return { dex: 'Orca', price: 0, outputAmount: 0, success: false };
      
    } catch (error) {
      console.error('❌ Orca pool quote error:', error);
      return { dex: 'Orca', price: 0, outputAmount: 0, success: false };
    }
  }

  async getTokenPools(tokenA?: string, tokenB?: string): Promise<OrcaPool[]> {
    try {
      const url = `${this.ORCA_API_BASE}/v1/whirlpool/list`;
      
      const response = await enhancedCorsProxy.fetchWithFallback(url) as OrcaPoolsResponse;
      let pools = response.whirlpools || [];
      
      // Filter pools by token pair if specified
      if (tokenA && tokenB) {
        pools = pools.filter((pool: OrcaPool) => 
          (pool.tokenA?.mint === tokenA && pool.tokenB?.mint === tokenB) ||
          (pool.tokenA?.mint === tokenB && pool.tokenB?.mint === tokenA)
        );
      } else if (tokenA) {
        pools = pools.filter((pool: OrcaPool) => 
          pool.tokenA?.mint === tokenA || pool.tokenB?.mint === tokenA
        );
      }
      
      // Sort by TVL (Total Value Locked) for liquidity
      pools.sort((a: OrcaPool, b: OrcaPool) => {
        const tvlA = parseFloat(a.tvl || '0');
        const tvlB = parseFloat(b.tvl || '0');
        return tvlB - tvlA;
      });
      
      return pools;
      
    } catch (error) {
      console.error('❌ Orca pools error:', error);
      return [];
    }
  }

  async getTokenPrice(mint: string): Promise<number> {
    try {
      // Orca doesn't have a direct price API, so we'll estimate from pools
      const pools = await this.getTokenPools(mint);
      
      if (pools.length > 0) {
        const pool = pools[0];
        const reserveA = parseFloat(pool.tokenAReserve || '1');
        const reserveB = parseFloat(pool.tokenBReserve || '1');
        
        // Simple price estimation based on reserves
        if (pool.tokenA?.mint === mint) {
          return reserveB / reserveA;
        } else {
          return reserveA / reserveB;
        }
      }
      
      return 0;
    } catch (error) {
      console.error('❌ Orca price error:', error);
      return 0;
    }
  }
}