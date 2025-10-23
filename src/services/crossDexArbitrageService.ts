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
    
    // Mock opportunities for now
    const mockOpportunity: ArbitrageOpportunity = {
      id: `arb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      pair: 'SOL/USDC',
      profit: 0.025,
      volume: 1000,
      type: 'ARBITRAGE',
      exchange1: 'Jupiter',
      exchange2: 'Raydium',
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      capitalRequired: 100
    };

    opportunities.push(mockOpportunity);
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