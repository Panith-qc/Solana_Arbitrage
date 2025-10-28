import { jupiterUltraService } from './jupiterUltraService';

export interface MevOpportunity {
  id: string;
  type: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION' | 'MICRO_ARBITRAGE' | 'PRICE_RECOVERY' | 'MEME_ARBITRAGE';
  mevType: 'SANDWICH' | 'FRONTRUN' | 'BACKRUN' | 'LIQUIDATION';
  pair: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  profit: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA_LOW';
  timestamp: Date;
  volume: number;
  quote?: Record<string, unknown>;
  frontrunTx?: string;
  backrunTx?: string;
  executionPriority?: number;
  capitalRequired?: number;
}

class MicroMevService {
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private callback: ((opportunities: MevOpportunity[]) => void) | null = null;
  private opportunities: MevOpportunity[] = [];

  // Popular Solana tokens for MEV scanning
  private readonly MEV_TOKENS = [
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 },
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
    { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6 },
    { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 }
  ];

  public setCallback(callback: (opportunities: MevOpportunity[]) => void): void {
    this.callback = callback;
    console.log('✅ Micro-MEV callback registered');
  }

  public async startMevScanning(): Promise<void> {
    if (this.isScanning) {
      console.log('⚠️ Micro-MEV scanning already active');
      return;
    }

    console.log('🚀 STARTING MICRO-MEV SCANNER...');
    this.isScanning = true;
    
    // Start scanning immediately
    await this.performScan();
    
    // Set up periodic scanning every 3 seconds
    this.scanInterval = setInterval(async () => {
      if (this.isScanning) {
        await this.performScan();
      }
    }, 3000);
  }

  public stopMevScanning(): void {
    console.log('🛑 STOPPING MICRO-MEV SCANNER...');
    this.isScanning = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    
    this.opportunities = [];
    if (this.callback) {
      this.callback([]);
    }
    
    console.log('⏹️ MICRO-MEV SCANNER - Stopped');
  }

  // Add missing stopScanning method for compatibility
  public stopScanning(): void {
    this.stopMevScanning();
  }

  private async performScan(): Promise<void> {
    try {
      const newOpportunities: MevOpportunity[] = [];
      
      // Scan for micro-MEV opportunities across different token pairs
      for (const inputToken of this.MEV_TOKENS) {
        for (const outputToken of this.MEV_TOKENS) {
          if (inputToken.mint === outputToken.mint) continue;
          
          // Check different trade sizes for micro opportunities
          const tradeSizes = [5000000, 10000000, 20000000, 25000000, 50000000, 100000000]; // Various sizes
          
          for (const tradeSize of tradeSizes) {
            const opportunity = await this.checkMicroMevOpportunity(
              inputToken.mint,
              outputToken.mint,
              tradeSize,
              `${inputToken.symbol}/${outputToken.symbol}`
            );
            
            if (opportunity) {
              newOpportunities.push(opportunity);
            }
          }
        }
      }
      
      // Update opportunities
      this.opportunities = newOpportunities.slice(0, 20); // Keep top 20
      
      console.log(`📊 SENDING ${this.opportunities.length} OPPORTUNITIES TO UI`);
      
      if (this.callback) {
        this.callback([...this.opportunities]);
      } else {
        console.log('❌ NO CALLBACK REGISTERED - UI WILL NOT UPDATE');
      }
      
      console.log(`✅ Scan complete: ${this.opportunities.length} opportunities found`);
      
    } catch (error) {
      console.error('❌ Micro-MEV scan error:', error);
    }
  }

  private async checkMicroMevOpportunity(
    inputMint: string,
    outputMint: string,
    amount: number,
    pair: string
  ): Promise<MevOpportunity | null> {
    try {
      console.log(`📊 MICRO-MEV QUOTE: ${inputMint.substring(0, 8)}... → ${outputMint.substring(0, 8)}... | Amount: ${amount}`);
      
      // Get Jupiter quote
      const quote = await realJupiterService.getQuote(inputMint, outputMint, amount, 50);
      
      if (!quote) {
        console.log('❌ MICRO-MEV QUOTE FAILED: No quote received');
        return null;
      }
      
      const inputAmount = parseInt(quote.inAmount);
      const outputAmount = parseInt(quote.outAmount);
      const priceImpact = parseFloat(quote.priceImpactPct);
      
      // Calculate potential MEV profit (simplified)
      const slippage = (inputAmount - outputAmount) / inputAmount;
      const potentialProfit = slippage * 0.1; // 10% of slippage as MEV opportunity
      const profitUsd = potentialProfit * (amount / 1000000); // Rough USD conversion
      
      // Only consider opportunities with reasonable profit potential
      if (profitUsd < 0.001) {
        return null;
      }
      
      const opportunity: MevOpportunity = {
        id: `mev-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'MICRO_ARBITRAGE',
        mevType: Math.random() > 0.5 ? 'SANDWICH' : 'FRONTRUN',
        pair,
        inputMint,
        outputMint,
        inputAmount,
        expectedOutput: outputAmount,
        profit: profitUsd,
        profitPercent: (profitUsd / (amount / 1000000)) * 100,
        confidence: Math.min(0.95, 0.7 + (profitUsd * 100)), // Higher confidence for higher profit
        riskLevel: priceImpact < 0.5 ? 'LOW' : priceImpact < 1.0 ? 'MEDIUM' : 'HIGH',
        timestamp: new Date(),
        volume: amount,
        quote: quote as Record<string, unknown>,
        executionPriority: Math.floor(profitUsd * 1000),
        capitalRequired: amount / 1000000
      };
      
      console.log(`💰 MICRO-MEV OPPORTUNITY: ${pair} - $${(profitUsd && !isNaN(profitUsd) ? profitUsd.toFixed(6) : '0.000000')} profit`);
      return opportunity;
      
    } catch (error) {
      console.error('❌ MICRO-MEV QUOTE FAILED', error);
      return null;
    }
  }

  public async executeMev(opportunityId: string): Promise<boolean> {
    const opportunity = this.opportunities.find(opp => opp.id === opportunityId);
    if (!opportunity) {
      console.log(`❌ MEV opportunity not found: ${opportunityId}`);
      return false;
    }

    try {
      console.log(`🚀 Executing MEV: ${opportunity.pair} - $${(opportunity.profit && !isNaN(opportunity.profit) ? opportunity.profit.toFixed(6) : '0.000000')}`);
      
      // Simulate MEV execution
      const executionTime = 500 + Math.random() * 1500;
      await new Promise(resolve => setTimeout(resolve, executionTime));
      
      const success = Math.random() > 0.3; // 70% success rate for MEV
      
      if (success) {
        console.log(`✅ MEV EXECUTION SUCCESS: ${opportunity.pair} - $${(opportunity.profit && !isNaN(opportunity.profit) ? opportunity.profit.toFixed(6) : '0.000000')}`);
        
        // Remove executed opportunity
        this.opportunities = this.opportunities.filter(opp => opp.id !== opportunityId);
        if (this.callback) {
          this.callback([...this.opportunities]);
        }
      } else {
        console.log(`❌ MEV EXECUTION FAILED: ${opportunity.pair}`);
      }
      
      return success;
    } catch (error) {
      console.error(`❌ MEV execution error for ${opportunityId}:`, error);
      return false;
    }
  }

  public getOpportunities(): MevOpportunity[] {
    return [...this.opportunities];
  }

  public isActive(): boolean {
    return this.isScanning;
  }

  public getMetrics() {
    return {
      isScanning: this.isScanning,
      opportunityCount: this.opportunities.length,
      avgProfit: this.opportunities.length > 0 
        ? this.opportunities.reduce((sum, opp) => sum + opp.profit, 0) / this.opportunities.length 
        : 0,
      highConfidenceCount: this.opportunities.filter(opp => opp.confidence > 0.8).length
    };
  }
}

export const microMevService = new MicroMevService();