interface MicroMevOpportunity {
    id: string;
    type: 'MICRO_ARBITRAGE';
    pair: string;
    inputMint: string;
    outputMint: string;
    inputAmount: number;
    expectedOutput: number;
    profitUsd: number;
    profitPercent: number;
    confidence: number;
    riskLevel: 'ULTRA_LOW' | 'LOW';
    timestamp: Date;
    capitalRequired: number;
}
interface MicroMevCallbacks {
    onOpportunityFound?: (opportunity: MicroMevOpportunity) => void;
    onScanComplete?: () => void;
}
declare class MicroMevEngine {
    private isActive;
    private scanInterval;
    private callbacks;
    private metrics;
    private tokenPairs;
    startMicroMevScanning(maxCapital: number, callbacks?: MicroMevCallbacks): Promise<void>;
    stop(): Promise<void>;
    stopMicroMevScanning(): void;
    isRunning(): boolean;
    private scanMicroArbitrage;
    executeMicroTrade(opportunity: MicroMevOpportunity): Promise<boolean>;
    getMetrics(): {
        totalScans: number;
        opportunitiesFound: number;
        successfulTrades: number;
        totalProfit: number;
        isActive: boolean;
    };
}
export declare const microMevEngine: MicroMevEngine;
export {};
//# sourceMappingURL=microMevEngine.d.ts.map