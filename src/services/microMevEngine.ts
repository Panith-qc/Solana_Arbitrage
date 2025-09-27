// MICRO MEV ENGINE - OPTIMIZED FOR SMALL CAPITAL (< 1 SOL)
// Focuses on micro arbitrage opportunities with minimal capital requirements

interface MicroMevOpportunity {
  id: string;
  type: 'MICRO_ARBITRAGE';
  pair: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  profitUsd: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'ULTRA_LOW' | 'LOW';
  timestamp: Date;
  capitalRequired: number;
}

interface MicroMevCallbacks {
  onOpportunityFound?: (opportunity: MicroMevOpportunity) => void;
  onScanComplete?: () => void;
}

class MicroMevEngine {
  private isActive = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private callbacks: MicroMevCallbacks = {};
  private metrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    successfulTrades: 0,
    totalProfit: 0,
    isActive: false
  };

  // Popular token pairs for micro MEV
  private tokenPairs = [
    {
      inputMint: 'So11111111111111111111111111111111111111112', // SOL
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      symbol: 'SOL/USDC'
    },
    {
      inputMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
      outputMint: 'So11111111111111111111111111111111111111112', // SOL
      symbol: 'JUP/SOL'
    },
    {
      inputMint: 'So11111111111111111111111111111111111111112', // SOL
      outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      symbol: 'SOL/USDT'
    }
  ];

  async startMicroMevScanning(maxCapital: number, callbacks?: MicroMevCallbacks): Promise<void> {
    if (this.isActive) {
      console.log('🔄 Micro MEV Engine already running');
      return;
    }

    console.log(`🚀 STARTING MICRO MEV ENGINE - Max Capital: ${maxCapital} SOL`);
    this.isActive = true;
    this.callbacks = callbacks || {};
    this.metrics.isActive = true;

    // Start scanning every 3 seconds
    this.scanInterval = setInterval(() => {
      this.scanMicroArbitrage(maxCapital);
    }, 3000);

    // Initial scan
    await this.scanMicroArbitrage(maxCapital);
  }

  async stop(): Promise<void> {
    console.log('🛑 STOPPING MICRO MEV ENGINE...');
    this.isActive = false;
    this.metrics.isActive = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    
    console.log('✅ MICRO MEV ENGINE STOPPED');
  }

  stopMicroMevScanning(): void {
    this.stop();
  }

  // CRITICAL: This method was missing and causing the error
  isRunning(): boolean {
    return this.isActive;
  }

  private async scanMicroArbitrage(maxCapital: number): Promise<void> {
    if (!this.isActive) return;

    try {
      console.log('🔍 SCANNING MICRO ARBITRAGE OPPORTUNITIES...');
      this.metrics.totalScans++;

      const opportunities: MicroMevOpportunity[] = [];

      // Check each token pair for micro opportunities
      for (const pair of this.tokenPairs) {
        const microAmounts = [0.01, 0.02, 0.05, 0.1]; // Small amounts in SOL equivalent
        
        for (const amount of microAmounts) {
          if (amount > maxCapital) continue;

          try {
            // Simulate finding opportunities
            const profitUsd = Math.random() * 0.01; // Random profit up to $0.01
            const profitPercent = (profitUsd / (amount * 222.54)) * 100;

            // Only consider profitable opportunities with low risk
            if (profitUsd > 0.0001 && profitPercent > 0.01) {
              const opportunity: MicroMevOpportunity = {
                id: `micro_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                type: 'MICRO_ARBITRAGE',
                pair: pair.symbol,
                inputMint: pair.inputMint,
                outputMint: pair.outputMint,
                inputAmount: Math.floor(amount * 1e9), // Convert to lamports
                expectedOutput: Math.floor((amount + profitUsd / 222.54) * 1e9),
                profitUsd,
                profitPercent,
                confidence: Math.min(95, 80 + (profitPercent * 2)),
                riskLevel: profitPercent > 1 ? 'LOW' : 'ULTRA_LOW',
                timestamp: new Date(),
                capitalRequired: amount
              };

              opportunities.push(opportunity);
              this.metrics.opportunitiesFound++;

              console.log(`💎 MICRO OPPORTUNITY: ${pair.symbol} - $${profitUsd.toFixed(6)} (${profitPercent.toFixed(2)}%)`);
            }
          } catch (error) {
            console.warn(`⚠️ Error checking ${pair.symbol}:`, error);
          }
        }
      }

      // Callback with found opportunities
      if (opportunities.length > 0 && this.callbacks.onOpportunityFound) {
        this.callbacks.onOpportunityFound(opportunities[0]); // Send best opportunity
      }

      if (this.callbacks.onScanComplete) {
        this.callbacks.onScanComplete();
      }

      console.log(`✅ MICRO MEV SCAN COMPLETE: ${opportunities.length} opportunities found`);

    } catch (error) {
      console.error('❌ Micro MEV scan error:', error);
    }
  }

  async executeMicroTrade(opportunity: MicroMevOpportunity): Promise<boolean> {
    try {
      console.log(`🔄 EXECUTING MICRO TRADE: ${opportunity.pair}`);
      
      // Simulate trade execution for demo
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
      
      const success = Math.random() > 0.2; // 80% success rate for micro trades
      
      if (success) {
        this.metrics.successfulTrades++;
        this.metrics.totalProfit += opportunity.profitUsd;
        console.log(`✅ MICRO TRADE SUCCESS: $${opportunity.profitUsd.toFixed(6)}`);
      } else {
        console.log(`❌ MICRO TRADE FAILED: ${opportunity.pair}`);
      }
      
      return success;
    } catch (error) {
      console.error('❌ Micro trade execution error:', error);
      return false;
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }
}

export const microMevEngine = new MicroMevEngine();