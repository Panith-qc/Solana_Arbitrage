import { supabase } from './supabaseClient';

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null;
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
  }>;
}

export interface JupiterSwapResult {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

interface SupabaseResponse {
  success: boolean;
  data?: JupiterQuote | JupiterSwapResult;
  error?: string;
}

export class SupabaseJupiterService {
  private supabaseUrl = 'https://jxwynzsxyxzohlhkqmpt.supabase.co';

  constructor() {
    console.log('🚀 Supabase Jupiter Service initialized - CORS-free trading');
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 100
  ): Promise<JupiterQuote | null> {
    try {
      console.log(`🔍 Getting Jupiter quote via Supabase:`, {
        inputMint: inputMint.slice(0, 8) + '...',
        outputMint: outputMint.slice(0, 8) + '...',
        amount
      });

      const response = await fetch(`${this.supabaseUrl}/functions/v1/app_6b054c109e_jupiter_quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3luenN4eXh6b2hsaGtxbXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMjEyNDQsImV4cCI6MjA3MjU5NzI0NH0.69aj1AhvM0k7N788A7MRenHLBayd8aYjTs6UOYYvILY`
        },
        body: JSON.stringify({
          inputMint,
          outputMint,
          amount,
          slippageBps
        })
      });

      if (!response.ok) {
        console.error('❌ Supabase Jupiter quote failed:', response.statusText);
        return null;
      }

      const result = await response.json() as SupabaseResponse;
      
      if (!result.success) {
        console.error('❌ Jupiter quote error via Supabase:', result.error);
        return null;
      }

      const quote = result.data as JupiterQuote;
      console.log('✅ Jupiter quote received via Supabase:', {
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpactPct
      });

      return quote;
    } catch (error) {
      console.error('❌ Failed to get Jupiter quote via Supabase:', error);
      return null;
    }
  }

  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    prioritizationFeeLamports: number = 1000000
  ): Promise<string | null> {
    try {
      console.log('🔄 Creating Jupiter swap via Supabase...');

      const response = await fetch(`${this.supabaseUrl}/functions/v1/app_6b054c109e_jupiter_swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4d3luenN4eXh6b2hsaGtxbXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcwMjEyNDQsImV4cCI6MjA3MjU5NzI0NH0.69aj1AhvM0k7N788A7MRenHLBayd8aYjTs6UOYYvILY`
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey,
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports
        })
      });

      if (!response.ok) {
        console.error('❌ Supabase Jupiter swap failed:', response.statusText);
        return null;
      }

      const result = await response.json() as SupabaseResponse;
      
      if (!result.success) {
        console.error('❌ Jupiter swap error via Supabase:', result.error);
        return null;
      }

      const swapResult = result.data as JupiterSwapResult;
      console.log('✅ Jupiter swap transaction created via Supabase');
      return swapResult.swapTransaction;
    } catch (error) {
      console.error('❌ Failed to get swap transaction via Supabase:', error);
      return null;
    }
  }
}

export const supabaseJupiterService = new SupabaseJupiterService();