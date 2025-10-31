export interface StrategyOpportunity {
    id: string;
    type: 'arbitrage' | 'momentum' | 'dca' | 'yield';
    pair: string;
    targetProfit: number;
    riskScore: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    timeToExecute: number;
    profitUsd: number;
    confidence: number;
    recommendedCapital: number;
    strategyName: string;
    outputMint?: string;
    executionPlan?: string[];
}
export interface StrategyResult {
    opportunityId: string;
    status: 'pending' | 'executing' | 'completed' | 'failed';
    profitRealized?: number;
    timestamp: number;
}
declare class StrategyEngineImpl {
    private activeStrategies;
    private executionHistory;
    private isRunning;
    startAllStrategies(callback?: (opps: StrategyOpportunity[]) => void): Promise<void>;
    stopAllStrategies(): Promise<void>;
    getActiveStrategies(): StrategyOpportunity[];
    getExecutionHistory(): StrategyResult[];
    recordExecution(result: StrategyResult): void;
}
export declare const strategyEngine: StrategyEngineImpl;
export {};
//# sourceMappingURL=StrategyEngine.d.ts.map