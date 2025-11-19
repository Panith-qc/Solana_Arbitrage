export interface ArbitrageResult {
  success: boolean;
  txHash?: string;
  actualProfitUsd?: number;
  gasFeeUsed?: number;
  executionTimeMs?: number;
  error?: string;
}

export interface ArbitrageOpportunity {
  id: string;
  pair: string;
  profit: number;
  capitalRequired: number;
  type?: string;
}

class MicroArbitrageService {
  public async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<ArbitrageResult> {
    const startTime = Date.now();
    
    // ⚠️ MOCK SERVICE - DISABLED FOR REAL TRADING
    console.error('❌ microArbitrageService is DISABLED - this was a MOCK service using Math.random()');
    console.error('❌ Use realTradeExecutor.executeArbitrageCycle() for REAL Solana trades');
    console.error('❌ This service did NOT execute real trades - it was simulation only');

    return {
      success: false,
      error: 'Mock service disabled - use realTradeExecutor for real trading',
      executionTimeMs: Date.now() - startTime
    };
  }
}

export const microArbitrageService = new MicroArbitrageService();