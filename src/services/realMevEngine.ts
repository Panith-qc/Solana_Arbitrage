// REAL MEV ENGINE - LIVE SOLANA MEV TRADING
// Scans for actual MEV opportunities and executes real trades

import { jupiterUltraService } from './jupiterUltraService';
import { realWalletManager } from './realWalletManager';

interface RealMevOpportunity {
  id: string;
  type: 'ARBITRAGE' | 'MICRO_ARBITRAGE';
  pair: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  profitUsd: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  capitalRequired: number;
  timestamp: Date;
  quote1?: unknown;
  quote2?: unknown;
}

interface WalletState {
  isConnected: boolean;
  balance: number;
  publicKey?: string;
}

interface TransactionResult {
  success: boolean;
  signature?: string;
  error?: string;
  actualProfit?: number;
}

interface SwapTransaction {
  swapTransaction: string;
}

class RealMevEngine {
  private isActive = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private readonly MAX_CAPITAL_PER_TRADE = 0.1; // Max 0.1 SOL per trade
  private readonly MIN_PROFIT_THRESHOLD = 0.0001; // $0.0001 minimum profit

  // Start real MEV scanning
  async startRealMevScanning(
    maxCapital: number,
    onOpportunity: (opportunities: RealMevOpportunity[]) => void
  ): Promise<void> {
    if (this.isActive) {
      console.log('🔄 Real MEV Engine already running');
      return;
    }

    console.log(`🚀 STARTING REAL MEV ENGINE - Capital: ${maxCapital} SOL`);
    this.isActive = true;

    // Start scanning every 10 seconds (real API has rate limits)
    this.scanInterval = setInterval(async () => {
      if (!this.isActive) return;
      
      try {
        const opportunities = await this.scanForRealOpportunities(maxCapital);
        if (opportunities.length > 0) {
          console.log(`📊 FOUND ${opportunities.length} REAL MEV OPPORTUNITIES`);
          onOpportunity(opportunities);
        }
      } catch (error) {
        console.error('❌ Real MEV scan error:', error);
      }
    }, 10000); // 10 second intervals for real API

    // Initial scan
    try {
      const opportunities = await this.scanForRealOpportunities(maxCapital);
      if (opportunities.length > 0) {
        onOpportunity(opportunities);
      }
    } catch (error) {
      console.error('❌ Initial MEV scan error:', error);
    }
  }

  // Stop MEV scanning
  stopRealMevScanning(): void {
    console.log('🛑 STOPPING REAL MEV ENGINE...');
    this.isActive = false;
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    
    console.log('✅ REAL MEV ENGINE STOPPED');
  }

  // Scan for real opportunities
  private async scanForRealOpportunities(maxCapital: number): Promise<RealMevOpportunity[]> {
    console.log('🔍 SCANNING FOR REAL MEV OPPORTUNITIES...');
    
    const opportunities: RealMevOpportunity[] = [];
    const walletState = realWalletManager.getWalletState() as WalletState;
    
    if (!walletState.isConnected) {
      console.log('⚠️ Wallet not connected for real trading');
      return [];
    }

    // Scan different trade sizes
    const tradeSizes = [0.01, 0.02, 0.05, 0.1].filter(size => 
      size <= maxCapital && size <= this.MAX_CAPITAL_PER_TRADE
    );

    for (const tradeSize of tradeSizes) {
      try {
        const arbOpportunities = await realJupiterService.scanRealArbitrageOpportunities(tradeSize);
        
        for (const opp of arbOpportunities) {
          if (opp.profitUsd >= this.MIN_PROFIT_THRESHOLD) {
            opportunities.push({
              ...opp,
              type: tradeSize <= 0.05 ? 'MICRO_ARBITRAGE' : 'ARBITRAGE',
              riskLevel: this.assessRiskLevel(opp.profitUsd, tradeSize)
            });
          }
        }
      } catch (error) {
        console.warn(`⚠️ Error scanning trade size ${tradeSize}:`, error);
      }
    }

    return opportunities.sort((a, b) => b.profitUsd - a.profitUsd).slice(0, 5);
  }

  // Execute real MEV trade
  async executeRealTrade(opportunity: RealMevOpportunity): Promise<boolean> {
    console.log(`⚡ EXECUTING REAL MEV TRADE: ${opportunity.pair}`);
    
    const walletState = realWalletManager.getWalletState() as WalletState;
    
    if (!walletState.isConnected) {
      console.log('❌ Wallet not connected');
      return false;
    }

    if (opportunity.capitalRequired > walletState.balance * 0.8) {
      console.log('❌ Insufficient balance for trade');
      return false;
    }

    try {
      // Get fresh quote for execution
      const quote = await realJupiterService.getQuote(
        opportunity.inputMint,
        opportunity.outputMint,
        opportunity.inputAmount,
        50 // 0.5% slippage
      );

      if (!quote) {
        console.log('❌ Failed to get fresh quote');
        return false;
      }

      // Get swap transaction
      const swapTransaction = await realJupiterService.getSwapTransaction(
        quote,
        walletState.publicKey!,
        200000 // Higher priority fee for MEV
      );

      if (!swapTransaction) {
        console.log('❌ Failed to create swap transaction');
        return false;
      }

      // Execute the transaction
      const result = await realWalletManager.executeTransaction(
        (swapTransaction as SwapTransaction).swapTransaction,
        opportunity.type,
        opportunity.profitUsd
      ) as TransactionResult;

      if (result.success) {
        console.log(`✅ REAL MEV TRADE SUCCESS: ${result.signature}`);
        console.log(`💰 ACTUAL PROFIT: $${result.actualProfit?.toFixed(6)}`);
        return true;
      } else {
        console.log(`❌ REAL MEV TRADE FAILED: ${result.error}`);
        return false;
      }

    } catch (error) {
      console.error('❌ Real MEV trade execution error:', error);
      return false;
    }
  }

  // Assess risk level
  private assessRiskLevel(profitUsd: number, capitalRequired: number): 'LOW' | 'MEDIUM' | 'HIGH' {
    const profitRatio = profitUsd / (capitalRequired * 222.12);
    
    if (profitRatio < 0.001) return 'LOW';
    if (profitRatio < 0.01) return 'MEDIUM';
    return 'HIGH';
  }

  // Check if engine is running
  isRunning(): boolean {
    return this.isActive;
  }

  // Get metrics
  getMetrics() {
    return {
      isActive: this.isActive,
      maxCapitalPerTrade: this.MAX_CAPITAL_PER_TRADE,
      minProfitThreshold: this.MIN_PROFIT_THRESHOLD
    };
  }
}

export const realMevEngine = new RealMevEngine();