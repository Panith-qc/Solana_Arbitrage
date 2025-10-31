export interface MEVOpportunity {
  id: string; type: string; pair?: string; entryPrice: number; exitPrice: number;
  expectedProfit: number; netProfitUsd?: number; profitPercent?: number; confidence?: number;
  capitalRequired?: number; gasFeeSol?: number; riskLevel?: string;
}
export interface StrategyOpportunity {
  id: string; type: string; entryPrice: number; exitPrice: number; expectedProfit: number; riskLevel: string; quote?: any;
}
export interface StrategyResult {
  success: boolean; netProfitUSD: number; txSignatures: string[]; skipped?: boolean;
  actualProfitUsd?: number; txHash?: string; executionTimeMs?: number; forwardTxHash?: string; reverseTxHash?: string; error?: string;
}
