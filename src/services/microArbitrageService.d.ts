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
declare class MicroArbitrageService {
    executeArbitrage(opportunity: ArbitrageOpportunity): Promise<ArbitrageResult>;
}
export declare const microArbitrageService: MicroArbitrageService;
export {};
//# sourceMappingURL=microArbitrageService.d.ts.map