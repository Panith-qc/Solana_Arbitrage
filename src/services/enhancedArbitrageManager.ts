import { CrossDexArbitrageService } from './crossDexArbitrageService';
import { ProductionWalletManager } from './productionWalletManager';

export class EnhancedArbitrageManager {
  private arbitrageService: CrossDexArbitrageService;
  private walletManager: ProductionWalletManager;
  private isRunning = false;

  constructor() {
    this.arbitrageService = new CrossDexArbitrageService();
    this.walletManager = new ProductionWalletManager();
  }

  async startProfitHunting(): Promise<void> {
    if (this.isRunning) {
      console.log('🔄 Arbitrage profit hunting already running...');
      return;
    }

    this.isRunning = true;
    console.log('🚀 ENHANCED ARBITRAGE MANAGER - Starting profit hunting system...');
    console.log('💰 Target: Find Jupiter vs Raydium/Orca price differences');
    console.log('🎯 Minimum profit: $0.50 per trade');
    console.log('💵 Optimized for 0.6 SOL balance');
    
    try {
      // Initialize wallet connection
      await this.walletManager.initialize();
      
      // Start cross-DEX arbitrage scanning
      await this.arbitrageService.startArbitrageScanning();
      
    } catch (error) {
      console.error('❌ Arbitrage manager error:', error);
      this.isRunning = false;
    }
  }

  stopProfitHunting(): void {
    this.isRunning = false;
    this.arbitrageService.stopScanning();
    console.log('⏹️ ENHANCED ARBITRAGE MANAGER - Stopped profit hunting');
  }

  getStatus(): { isRunning: boolean; strategy: string; minProfit: string } {
    return {
      isRunning: this.isRunning,
      strategy: 'Cross-DEX Arbitrage (Jupiter vs Raydium/Orca)',
      minProfit: '$0.50'
    };
  }
}

// Export singleton instance
export const arbitrageManager = new EnhancedArbitrageManager();

// Auto-start the arbitrage system
console.log('🎯 INITIALIZING CROSS-DEX ARBITRAGE SYSTEM...');
arbitrageManager.startProfitHunting().catch(console.error);