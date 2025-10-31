export interface StrategyOpportunity { id: string; type: string; entryPrice: number; exitPrice: number; expectedProfit: number; riskLevel: string; quote?: any; }
export const strategyEngine = { identifyOpportunities: async () => ([]), executeStrategy: async (opp: StrategyOpportunity) => ({ success: true, netProfitUSD: 0, txSignatures: [], skipped: true }) };
