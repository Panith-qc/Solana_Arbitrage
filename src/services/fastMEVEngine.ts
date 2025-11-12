// ═══════════════════════════════════════════════════════════════════════════
// FAST MEV ENGINE - NOW USES REAL STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════
// Replaced stub with real strategy integration
// No more hardcoded fake data - all opportunities are REAL
// ═══════════════════════════════════════════════════════════════════════════

import { realTriangularArbitrage } from './realTriangularArbitrage';
import { realCrossDexArbitrage } from './realCrossDexArbitrage';
import { Keypair } from '@solana/web3.js';
import { realTradeExecutor } from './realTradeExecutor';

export interface MEVOpportunity { 
  id: string; 
  pair: string; 
  type: string; 
  riskLevel: 'ULTRA_LOW' | 'LOW' | 'MEDIUM'; 
  netProfitUsd: number; 
  profitUsd: number; 
  profitPercent: number; 
  confidence: number; 
  capitalRequired: number; 
  gasFeeSol: number; 
  entryPrice: number; 
  exitPrice: number; 
  expectedProfit: number;
  outputMint?: string;
  executionPlan?: string[];
}

export interface TradeResult { 
  success: boolean; 
  netProfitUSD: number; 
  txSignatures: string[]; 
  txHash?: string; 
  actualProfitUsd?: number; 
  executionTimeMs?: number; 
  forwardTxHash?: string; 
  reverseTxHash?: string; 
  error?: string; 
}

class FastMEVEngine {
  private isScanning = false;
  private accumulatedOpportunities: MEVOpportunity[] = [];

  /**
   * Scan for MEV opportunities using REAL strategies
   * No more fake data - this calls real Jupiter API
   */
  async scanForMEVOpportunities(capitalSOL: number = 5.0): Promise<MEVOpportunity[]> {
    console.log('🔍 Fast MEV Engine: Scanning for real opportunities...');
    
    const opportunities: MEVOpportunity[] = [];

    try {
      // Check if scanners are already running
      const triangularStatus = realTriangularArbitrage.getStatus();
      const crossDexStatus = realCrossDexArbitrage.getStatus();

      if (!triangularStatus.isScanning) {
        console.log('⚡ Starting real triangular arbitrage scanner...');
        realTriangularArbitrage.startScanning(
          capitalSOL,
          0.3,
          (triOpps) => {
            // Convert to MEVOpportunity format
            triOpps.forEach(opp => {
              this.accumulatedOpportunities.push({
                id: opp.id,
                pair: opp.pathNames.join(' → '),
                type: 'TRIANGULAR_ARB',
                riskLevel: opp.riskLevel,
                netProfitUsd: opp.profitUsd,
                profitUsd: opp.profitUsd,
                profitPercent: opp.profitPercent,
                confidence: opp.confidence,
                capitalRequired: opp.inputAmount / 1_000_000_000,
                gasFeeSol: 0.00015,
                entryPrice: 0,
                exitPrice: 0,
                expectedProfit: opp.profitUsd,
                outputMint: opp.path[1],
                executionPlan: opp.executionPlan
              });
            });
          }
        );
      }

      if (!crossDexStatus.isScanning) {
        console.log('⚡ Starting real cross-DEX arbitrage scanner...');
        realCrossDexArbitrage.startScanning(
          capitalSOL,
          0.3,
          (xdexOpps) => {
            // Convert to MEVOpportunity format
            xdexOpps.forEach(opp => {
              this.accumulatedOpportunities.push({
                id: opp.id,
                pair: opp.pair,
                type: 'CROSS_DEX_ARB',
                riskLevel: opp.riskLevel,
                netProfitUsd: opp.profitUsd,
                profitUsd: opp.profitUsd,
                profitPercent: opp.profitPercent,
                confidence: opp.confidence,
                capitalRequired: opp.inputAmount / 1_000_000_000,
                gasFeeSol: 0.0001,
                entryPrice: opp.buyPrice,
                exitPrice: opp.sellPrice,
                expectedProfit: opp.profitUsd,
                outputMint: opp.tokenMint,
                executionPlan: opp.executionPlan
              });
            });
          }
        );
      }

      // Return accumulated opportunities
      const currentOpps = [...this.accumulatedOpportunities];
      
      // Keep only recent opportunities (last 5 minutes)
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      this.accumulatedOpportunities = this.accumulatedOpportunities.filter(opp => {
        const oppTime = parseInt(opp.id.split('_')[1]);
        return oppTime > fiveMinutesAgo;
      });

      if (currentOpps.length > 0) {
        console.log(`✅ Fast MEV Engine: ${currentOpps.length} real opportunities available`);
      } else {
        console.log('ℹ️ Fast MEV Engine: No opportunities yet (scanners starting...)');
      }

      return currentOpps;

    } catch (error) {
      console.error('❌ Fast MEV Engine scan failed:', error);
      return [];
    }
  }

  /**
   * Execute arbitrage with REAL trade execution
   * No more fake success - this executes on blockchain
   */
  async executeArbitrage(
    opportunity: MEVOpportunity, 
    wallet: Keypair,
    priorityFeeSol: number = 0.0001
  ): Promise<TradeResult> {
    const startTime = Date.now();
    
    console.log(`🚀 Fast MEV Engine: Executing REAL trade for ${opportunity.pair}`);

    try {
      if (!wallet) {
        throw new Error('Wallet required for execution');
      }

      // Use realTradeExecutor for actual blockchain execution
      const result = await realTradeExecutor.executeArbitrageCycle(
        opportunity.outputMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Default to USDC
        opportunity.capitalRequired,
        50, // 0.5% slippage
        wallet,
        false // No Jito for now
      );

      const executionTimeMs = Date.now() - startTime;

      if (result.success) {
        console.log(`✅ Fast MEV Engine: Trade executed successfully in ${executionTimeMs}ms`);
        return {
          success: true,
          netProfitUSD: result.netProfitUSD,
          txSignatures: result.txSignatures,
          txHash: result.txSignatures[0],
          actualProfitUsd: result.netProfitUSD,
          executionTimeMs,
          forwardTxHash: result.txSignatures[0],
          reverseTxHash: result.txSignatures[1]
        };
      } else {
        throw new Error('Trade execution failed');
      }

    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;
      console.error(`❌ Fast MEV Engine: Execution failed:`, error.message);
      
      return {
        success: false,
        netProfitUSD: 0,
        txSignatures: [],
        executionTimeMs,
        error: error.message
      };
    }
  }

  /**
   * Stop all scanning
   */
  stopScanning(): void {
    console.log('⏹️ Fast MEV Engine: Stopping all scanners...');
    realTriangularArbitrage.stopScanning();
    realCrossDexArbitrage.stopScanning();
    this.accumulatedOpportunities = [];
    this.isScanning = false;
  }
}

export const fastMEVEngine = new FastMEVEngine();

console.log('✅ Fast MEV Engine loaded - Now uses REAL strategies (no more fake data)');
