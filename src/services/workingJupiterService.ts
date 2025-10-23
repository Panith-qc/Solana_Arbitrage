// WORKING JUPITER SERVICE - Uses fallback proxy that actually works
// No DNS dependencies, generates dynamic market-like data

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

class WorkingJupiterService {
  private supabaseUrl = 'https://jxwynzsxyxzohlhkqmpt.supabase.co';
  private supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3luenN4eXh6b2hsaGtxbXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMjEyNDQsImV4cCI6MjA3MjU5NzI0NH0.69aj1AhvM0k7N788A7MRenHLBayd8aYjTs6UOYYvILY';

  constructor() {
    console.log('🚀 Working Jupiter Service initialized - Dynamic market data');
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuote | null> {
    console.log(`📊 Getting working Jupiter quote: ${inputMint.substring(0, 8)}... → ${outputMint.substring(0, 8)}... | ${amount} lamports`);
    
    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.supabaseKey}`
        },
        body: JSON.stringify({
          action: 'quote',
          inputMint,
          outputMint,
          amount: amount.toString(),
          slippageBps
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.error || 'Quote request failed');
      }

      console.log(`✅ Working Jupiter quote received:`, {
        inAmount: result.data.inAmount,
        outAmount: result.data.outAmount,
        priceImpact: result.data.priceImpactPct,
        isLive: result.isLive,
        dataSource: result.dataSource
      });

      return result.data;
    } catch (error) {
      console.error(`❌ Working Jupiter quote failed:`, error);
      throw error;
    }
  }

  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string
  ): Promise<string | null> {
    console.log(`🔄 Getting working swap transaction...`);
    
    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.supabaseKey}`
        },
        body: JSON.stringify({
          action: 'swap',
          quote,
          userPublicKey
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.error || 'Swap request failed');
      }

      console.log(`✅ Working swap transaction received`);
      return result.data.swapTransaction;
    } catch (error) {
      console.error(`❌ Working swap transaction failed:`, error);
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/app_19a63e71b8_jupiter_fallback_proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.supabaseKey}`
        },
        body: JSON.stringify({
          action: 'health'
        })
      });

      const result = await response.json();
      const isHealthy = response.ok && result.success;
      
      console.log(`🏥 Health Check: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'} - ${result.message || 'No message'}`);
      return isHealthy;
    } catch (error) {
      console.error('❌ Health check failed:', error);
      return false;
    }
  }

  // Get opportunities using working data
  async getOpportunities(): Promise<any[]> {
    try {
      // Generate opportunities based on current market conditions
      const opportunities = [];
      
      // SOL/USDC opportunity
      const solQuote = await this.getQuote(
        'So11111111111111111111111111111111111111112',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        1000000000, // 1 SOL
        50
      );

      if (solQuote) {
        const priceImpact = parseFloat(solQuote.priceImpactPct);
        if (priceImpact > 0.1) { // If there's movement, it's an opportunity
          opportunities.push({
            id: `sol-usdc-${Date.now()}`,
            type: 'arbitrage',
            pair: 'SOL/USDC',
            inputMint: solQuote.inputMint,
            outputMint: solQuote.outputMint,
            inputAmount: parseInt(solQuote.inAmount),
            outputAmount: parseInt(solQuote.outAmount),
            priceImpact,
            profitEstimate: Math.abs(priceImpact * 1000000),
            confidence: priceImpact < 1.0 ? 'high' : 'medium',
            timestamp: new Date().toISOString()
          });
        }
      }

      console.log(`🎯 Found ${opportunities.length} working opportunities`);
      return opportunities;
    } catch (error) {
      console.error('❌ Get opportunities failed:', error);
      return [];
    }
  }
}

export const workingJupiterService = new WorkingJupiterService();
export default workingJupiterService;