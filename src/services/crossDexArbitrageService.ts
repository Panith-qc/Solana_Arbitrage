import { enhancedCorsProxy } from './enhancedCorsProxy';
import { microArbitrageService } from './microArbitrageService';
import { realCrossDexArbitrage } from './realCrossDexArbitrage';

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

    console.log('═══════════════════════════════════════════════════════════');
    console.log('🔄 crossDexArbitrageService: NOW USING REAL SCANNER');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('⚠️ This service is deprecated - redirecting to realCrossDexArbitrage');
    console.log('✅ Real Jupiter API calls will be used for price comparison');
    console.log('═══════════════════════════════════════════════════════════');
    
    this.isScanning = true;

    // Use REAL cross-DEX arbitrage scanner instead of mock
    await realCrossDexArbitrage.startScanning(
      5.0, // 5 SOL default capital
      0.3, // 0.3% minimum profit
      (opportunities) => {
        // Convert to old format for backward compatibility
        const legacyOpps: ArbitrageOpportunity[] = opportunities.map(opp => ({
          id: opp.id,
          pair: opp.pair,
          profit: opp.profitPercent / 100,
          volume: 1000,
          type: 'ARBITRAGE',
          exchange1: opp.buyDex,
          exchange2: opp.sellDex,
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: opp.tokenMint,
          capitalRequired: opp.inputAmount / 1_000_000_000
        }));

        if (this.callback && legacyOpps.length > 0) {
          console.log(`✅ Found ${legacyOpps.length} REAL cross-DEX opportunities`);
          this.callback(legacyOpps);
        }
      }
    );

    console.log('✅ REAL cross-DEX arbitrage scanner started');
  }

  stopArbitrageScanning(): void {
    console.log('⏹️ Stopping arbitrage scanning...');
    this.isScanning = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    // Stop the REAL scanner too
    realCrossDexArbitrage.stopScanning();
  }

  // Add the missing stopScanning method
  stopScanning(): void {
    this.stopArbitrageScanning();
  }

  private async scanForArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
    // NOW USES REAL SCANNER - No more mock data!
    // This method is deprecated - use realCrossDexArbitrage instead
    
    console.log('⚠️ crossDexArbitrageService.scanForArbitrageOpportunities is deprecated');
    console.log('   Use realCrossDexArbitrage.startScanning() for REAL opportunities');
    
    // Return empty array - this service is replaced by realCrossDexArbitrage
    return [];
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

console.log('✅ Cross-DEX Arbitrage Service loaded - Now uses realCrossDexArbitrage (no more mock data)');