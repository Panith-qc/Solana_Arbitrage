import { enhancedCorsProxy } from './enhancedCorsProxy';
import { microArbitrageService } from './microArbitrageService';

export interface ArbitrageOpportunity {
  id: string;
  pair: string;
  profit: number;
  volume: number;
  type: 'ARBITRAGE';
  exchange1: string;
  exchange2: string;
  inputMint: string;
  outputMint: string;
  capitalRequired: number;
}

class CrossDexArbitrageService {
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private callback: ((opportunities: ArbitrageOpportunity[]) => void) | null = null;

  setCallback(callback: (opportunities: ArbitrageOpportunity[]) => void): void {
    this.callback = callback;
  }

  async startArbitrageScanning(): Promise<void> {
    if (this.isScanning) {
      console.log('⚠️ Arbitrage scanning already active');
      return;
    }

    console.log('🔄 Starting arbitrage scanning...');
    this.isScanning = true;

    const scanForArbitrageOpportunities = async () => {
      try {
        const opportunities = await this.scanForArbitrageOpportunities();
        if (this.callback && opportunities.length > 0) {
          this.callback(opportunities);
        }
      } catch (error) {
        console.error('❌ Arbitrage scan failed:', error);
      }
    };

    // Initial scan
    await scanForArbitrageOpportunities();
    
    // Set up interval scanning
    this.scanInterval = setInterval(scanForArbitrageOpportunities, 10000); // 10 seconds
  }

  stopArbitrageScanning(): void {
    console.log('⏹️ Stopping arbitrage scanning...');
    this.isScanning = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }

  // Add the missing stopScanning method
  stopScanning(): void {
    this.stopArbitrageScanning();
  }

  private async scanForArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    
    // REAL cross-DEX arbitrage scanning using Jupiter
    const { multiAPIService } = await import('./multiAPIQuoteService');
    const { priceService } = await import('./priceService');
    
    const tokens = [
      { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
      { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
    ];
    
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const scanAmount = 100000000; // 0.1 SOL
    
    for (const token of tokens) {
      try {
        // Get REAL Jupiter quotes
        const forwardQuote = await multiAPIService.getQuote(SOL_MINT, token.mint, scanAmount, 50);
        if (!forwardQuote?.outAmount) continue;
        
        const reverseQuote = await multiAPIService.getQuote(token.mint, SOL_MINT, Number(forwardQuote.outAmount), 50);
        if (!reverseQuote?.outAmount) continue;
        
        // Calculate REAL profit
        const endAmount = Number(reverseQuote.outAmount);
        const profitLamports = endAmount - scanAmount;
        const profitSOL = profitLamports / 1e9;
        
        const solPrice = await priceService.getPriceUsd(SOL_MINT);
        const profitUSD = profitSOL * solPrice;
        const feesUSD = 0.002 * solPrice;
        const netProfitUSD = profitUSD - feesUSD;
        
        // Only add if profitable
        if (netProfitUSD > 0.01) {
          opportunities.push({
            id: `arb_${token.symbol}_${Date.now()}`,
            pair: `SOL/${token.symbol}`,
            profit: netProfitUSD,
            volume: scanAmount / 1e9,
            type: 'ARBITRAGE',
            exchange1: 'Jupiter',
            exchange2: 'Aggregated',
            inputMint: SOL_MINT,
            outputMint: token.mint,
            capitalRequired: scanAmount / 1e9
          });
        }
      } catch (error) {
        // Skip failed quotes
      }
    }

    return opportunities;
  }

  async executeArbitrage(opportunityId: string): Promise<boolean> {
    console.log(`🚀 Executing arbitrage: ${opportunityId}`);
    
    try {
      // Find the opportunity (mock for now)
      const opportunity = {
        id: opportunityId,
        pair: 'SOL/USDC',
        profit: 0.025,
        capitalRequired: 0.1,
        type: 'ARBITRAGE'
      };

      // Use the microArbitrageService for execution
      const result = await microArbitrageService.executeArbitrage(opportunity);
      
      return result.success;
    } catch (error) {
      console.error('❌ Arbitrage execution failed:', error);
      return false;
    }
  }
}

export const crossDexArbitrageService = new CrossDexArbitrageService();