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
    console.log(`🚀 Micro Arbitrage: ${opportunity.pair} - $${opportunity.profit.toFixed(6)}`);
    
    // NOTE: This service is deprecated
    // Use realTradeExecutor.executeArbitrageCycle() for REAL trades
    console.warn('⚠️ microArbitrageService is deprecated');
    console.warn('⚠️ Use realTradeExecutor.executeArbitrageCycle() for REAL trades');

    return {
      success: false,
      error: 'Service deprecated - use realTradeExecutor.executeArbitrageCycle() instead',
      executionTimeMs: Date.now() - startTime
    };
  }
}

export const microArbitrageService = new MicroArbitrageService();