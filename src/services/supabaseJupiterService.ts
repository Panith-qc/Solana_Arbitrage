// SUPABASE JUPITER SERVICE - Updated to use WORKING fallback proxy
// Uses app_19a63e71b8_jupiter_fallback_proxy which actually works

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

export interface JupiterSwapResponse {
  swapTransaction: string;
}

class SupabaseJupiterService {
  private supabaseUrl = 'https://jxwynzsxyxzohlhkqmpt.supabase.co';
  private supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3luenN4eXh6b2hsaGtxbXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMjEyNDQsImV4cCI6MjA3MjU5NzI0NH0.69aj1AhvM0k7N788A7MRenHLBayd8aYjTs6UOYYvILY';

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuote | null> {
    console.log(`🔍 Jupiter Quote Request: ${inputMint.substring(0, 8)}... → ${outputMint.substring(0, 8)}... | Amount: ${amount}`);
    
    try {
      // Use the WORKING fallback proxy
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
        console.error(`❌ Jupiter quote error: ${response.status}`);
        return null;
      }

      const result = await response.json();
      
      if (result.success && result.data) {
        console.log(`✅ Jupiter quote received via WORKING proxy:`, {
          inputAmount: result.data.inAmount,
          outputAmount: result.data.outAmount,
          priceImpact: result.data.priceImpactPct,
          exchangeRate: result.exchangeRate,
          dataSource: result.dataSource
        });
        return result.data;
      } else {
        console.error('❌ Jupiter quote failed:', result.error);
        return null;
      }
    } catch (error) {
      console.error('❌ Jupiter quote request failed:', error);
      return null;
    }
  }

  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    priorityFeeLamports: number = 1000
  ): Promise<string | null> {
    console.log(`🔄 Getting swap transaction for ${userPublicKey.substring(0, 8)}...`);
    
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
          userPublicKey,
          priorityFeeLamports
        })
      });

      if (!response.ok) {
        console.error(`❌ Jupiter swap transaction error: ${response.status}`);
        return null;
      }

      const result = await response.json();
      
      if (result.success && result.data?.swapTransaction) {
        console.log(`✅ Swap transaction received via WORKING proxy`);
        return result.data.swapTransaction;
      } else {
        console.error('❌ Jupiter swap transaction failed:', result.error);
        return null;
      }
    } catch (error) {
      console.error('❌ Jupiter swap transaction request failed:', error);
      return null;
    }
  }

  // Health check method
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
      return response.ok && result.success;
    } catch (error) {
      console.error('❌ Jupiter health check failed:', error);
      return false;
    }
  }
}

export const supabaseJupiterService = new SupabaseJupiterService();