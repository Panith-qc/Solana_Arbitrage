// ═══════════════════════════════════════════════════════════════════════════
// MICRO ARBITRAGE SERVICE - NOW USES REAL TRADES
// ═══════════════════════════════════════════════════════════════════════════
// Replaced simulation with real Jupiter API execution
// No more fake sleep - real blockchain transactions
// ═══════════════════════════════════════════════════════════════════════════

import { Keypair } from '@solana/web3.js';
import { realTradeExecutor } from './realTradeExecutor';

export interface ArbitrageResult {
  success: boolean;
  txHash?: string;
  actualProfitUsd?: number;
  gasFeeUsed?: number;
  executionTimeMs?: number;
  error?: string;
  txSignatures?: string[];
}

export interface ArbitrageOpportunity {
  id: string;
  pair: string;
  profit: number;
  capitalRequired: number;
  type?: string;
  outputMint?: string;
  inputMint?: string;
}

class RealMicroArbitrageService {
  /**
   * Execute REAL arbitrage trade on blockchain
   * No more simulation - this sends actual transactions
   */
  public async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    wallet?: Keypair
  ): Promise<ArbitrageResult> {
    const startTime = Date.now();
    
    console.log(`🚀 EXECUTING REAL Micro Arbitrage: ${opportunity.pair}`);
    console.log(`   Expected Profit: $${opportunity.profit.toFixed(6)}`);
    console.log(`   Capital Required: ${opportunity.capitalRequired.toFixed(4)} SOL`);

    try {
      // Validate opportunity data
      if (!opportunity || typeof opportunity.profit !== 'number') {
        throw new Error('Invalid opportunity: profit is undefined or not a number');
      }

      if (!opportunity.capitalRequired || typeof opportunity.capitalRequired !== 'number') {
        throw new Error('Invalid opportunity: capitalRequired is undefined or not a number');
      }

      // Check if we have a wallet
      if (!wallet) {
        throw new Error('Wallet required for real trade execution');
      }

      // Extract token mint from pair (e.g., "SOL/USDC" -> USDC mint)
      const outputMint = opportunity.outputMint || 
                        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Default to USDC

      console.log(`📊 Output Mint: ${outputMint.slice(0, 12)}...`);
      console.log(`🚀 Executing REAL arbitrage cycle on blockchain...`);

      // Execute REAL trade using realTradeExecutor
      const result = await realTradeExecutor.executeArbitrageCycle(
        outputMint,
        opportunity.capitalRequired,
        50, // 0.5% slippage
        wallet,
        false // No Jito for micro arbitrage
      );

      const executionTimeMs = Date.now() - startTime;

      if (result.success) {
        console.log(`✅ REAL Micro Arbitrage SUCCESS!`);
        console.log(`   Net Profit: $${result.netProfitUSD.toFixed(6)}`);
        console.log(`   TX Signatures: ${result.txSignatures.join(', ')}`);
        console.log(`   Execution Time: ${executionTimeMs}ms`);

        return {
          success: true,
          txHash: result.txSignatures[0],
          actualProfitUsd: result.netProfitUSD,
          gasFeeUsed: 0.00015, // Estimated from 3 txs × 0.000005 SOL
          executionTimeMs,
          txSignatures: result.txSignatures
        };
      } else {
        const errorMsg = 'Trade execution failed - not profitable after validation';
        console.log(`⏭️ Micro Arbitrage SKIPPED: ${errorMsg}`);

        return {
          success: false,
          error: errorMsg,
          executionTimeMs
        };
      }

    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown execution error';
      
      console.error(`❌ REAL Micro Arbitrage FAILED: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
        executionTimeMs
      };
    }
  }

  /**
   * Validate opportunity before execution
   */
  public async validateOpportunity(opportunity: ArbitrageOpportunity): Promise<boolean> {
    if (!opportunity) return false;
    if (typeof opportunity.profit !== 'number' || opportunity.profit <= 0) return false;
    if (typeof opportunity.capitalRequired !== 'number' || opportunity.capitalRequired <= 0) return false;
    if (opportunity.capitalRequired > 10) return false; // Max 10 SOL per trade
    
    return true;
  }
}

export const microArbitrageService = new RealMicroArbitrageService();

console.log('✅ Micro Arbitrage Service loaded - Now uses REAL blockchain trades (no more simulation)');