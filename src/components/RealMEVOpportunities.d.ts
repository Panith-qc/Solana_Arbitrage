import React from 'react';
interface MEVOpportunity {
    id: string;
    type: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION';
    pair: string;
    inputMint: string;
    outputMint: string;
    inputAmount: number;
    expectedOutput: number;
    profitUsd: number;
    profitPercent: number;
    confidence: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    timestamp: Date;
    quote?: Record<string, unknown>;
    frontrunTx?: string;
    backrunTx?: string;
    executionPriority?: number;
}
interface RealMEVOpportunitiesProps {
    opportunities: MEVOpportunity[];
    isScanning: boolean;
    onExecuteTrade: (opportunity: MEVOpportunity) => void;
    executingTradeId: string | null;
    autoTradingEnabled: boolean;
}
declare const RealMEVOpportunities: React.FC<RealMEVOpportunitiesProps>;
export default RealMEVOpportunities;
//# sourceMappingURL=RealMEVOpportunities.d.ts.map