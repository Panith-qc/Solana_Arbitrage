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
export declare const fastMEVEngine: {
    scanForMEVOpportunities(): Promise<MEVOpportunity[]>;
    executeArbitrage(opportunity?: MEVOpportunity, priorityFeeSol?: number): Promise<TradeResult>;
};
//# sourceMappingURL=fastMEVEngine.d.ts.map