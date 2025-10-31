export interface ArbitrageOpportunity {
    id: string;
    pair: string;
    profit: number;
    volume: number;
    type: 'ARBITRAGE';
    exchange1: string;
    exchange2: string;
    inputMint: string;
    outputMint: string;
    capitalRequired: number;
}
declare class CrossDexArbitrageService {
    private isScanning;
    private scanInterval;
    private callback;
    setCallback(callback: (opportunities: ArbitrageOpportunity[]) => void): void;
    startArbitrageScanning(): Promise<void>;
    stopArbitrageScanning(): void;
    stopScanning(): void;
    private scanForArbitrageOpportunities;
    executeArbitrage(opportunityId: string): Promise<boolean>;
}
export declare const crossDexArbitrageService: CrossDexArbitrageService;
export {};
//# sourceMappingURL=crossDexArbitrageService.d.ts.map