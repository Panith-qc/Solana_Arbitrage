import { getJupiterUltraService } from './jupiterUltraService'; // OLD: realJupiterService

// This service now uses REAL CoinGecko data - NO MOCK DATA
export class FixedJupiterService {
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number = 50
  ): Promise<JupiterQuote> {
    console.log('🔄 FixedJupiterService: Using REAL CoinGecko data')
    
    // Delegate to real service that uses CoinGecko API
    return await realJupiterService.getQuote(inputMint, outputMint, amount, slippageBps)
  }

  async getSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
    prioritizationFeeLamports: number = 1000
  ): Promise<JupiterSwapResult> {
    console.log('🔄 FixedJupiterService: Creating REAL swap transaction')
    
    return await realJupiterService.getSwapTransaction(quote, userPublicKey, prioritizationFeeLamports)
  }

  async executeSwap(
    swapTransaction: string,
    userPublicKey: string
  ): Promise<{ signature: string; success: boolean }> {
    console.log('🔄 FixedJupiterService: Executing REAL swap')
    
    return await realJupiterService.executeSwap(swapTransaction, userPublicKey)
  }
}

export const fixedJupiterService = new FixedJupiterService()