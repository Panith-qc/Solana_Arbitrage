interface CapitalStrategy {
    strategy: string;
    maxTradeSize: number;
    focusAreas: string[];
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    recommendedMinProfit: number;
}
interface TradeRecommendation {
    canTrade: boolean;
    recommendedSize: number;
    reason: string;
    confidence: number;
}
declare class CapitalOptimizer {
    private active;
    private strategies;
    start(): Promise<void>;
    stop(): Promise<void>;
    getOptimalStrategy(availableCapital: number): CapitalStrategy;
    recommendTradeSize(availableCapital: number, expectedProfit: number, riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'): TradeRecommendation;
    isActive(): boolean;
}
export declare const capitalOptimizer: CapitalOptimizer;
export {};
//# sourceMappingURL=capitalOptimizer.d.ts.map