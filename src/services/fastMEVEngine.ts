import { Connection } from '@solana/web3.js';

// ⚠️ DISABLED: This was a mock service returning fake data
// For REAL trading, use realTradeExecutor.ts instead

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

// ⚠️ MOCK SERVICE - DISABLED FOR REAL TRADING
// This service returned fake/hardcoded opportunities
// Use realTradeExecutor for actual Solana trades
export const fastMEVEngine = { 
  async scanForMEVOpportunities(): Promise<MEVOpportunity[]> { 
    console.warn('⚠️ fastMEVEngine is DISABLED - this was a mock service');
    console.warn('⚠️ For REAL trading, opportunity detection should use live market data');
    // Return empty array instead of fake data
    return []; 
  }, 
  
  async executeArbitrage(opportunity?: MEVOpportunity, priorityFeeSol?: number): Promise<TradeResult> { 
    console.error('❌ fastMEVEngine.executeArbitrage is DISABLED - this was a mock');
    console.error('❌ Use realTradeExecutor.executeArbitrageCycle() for REAL trades');
    return { 
      success: false, 
      netProfitUSD: 0, 
      txSignatures: [], 
      error: 'Mock service disabled - use realTradeExecutor for real trading'
    }; 
  } 
};
