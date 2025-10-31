interface JitoBundle {
    transactions: string[];
    tip: number;
    bundleId: string;
    status: 'PENDING' | 'LANDED' | 'FAILED' | 'DROPPED';
    submissionTime: Date;
    landingSlot?: number;
}
interface BundleResult {
    success: boolean;
    bundleId: string;
    landingSlot?: number;
    transactions: Array<{
        signature: string;
        success: boolean;
        error?: string;
    }>;
    totalTip: number;
    executionTime: number;
}
interface BundleSubmissionData {
    transactions: string[];
    tip: number;
    type: 'SANDWICH' | 'ARBITRAGE' | 'BACKRUN';
}
declare class JitoBundleManager {
    private activeBundles;
    private bundleHistory;
    private readonly JITO_ENDPOINT;
    private readonly MAX_BUNDLE_SIZE;
    createSandwichBundle(frontRunTx: string, victimTx: string, backRunTx: string, tip: number): Promise<string>;
    createArbitrageBundle(transactions: string[], tip: number): Promise<string>;
    calculateOptimalTip(expectedProfit: number, competition?: number): number;
    monitorBundle(bundleId: string): Promise<BundleResult>;
    submitMultipleBundles(bundles: BundleSubmissionData[]): Promise<string[]>;
    retryFailedBundle(bundleId: string, increaseTip?: boolean): Promise<string>;
    private submitBundle;
    private getBundleStatus;
    private sleep;
    getActiveBundles(): JitoBundle[];
    getBundleHistory(): BundleResult[];
    getSuccessRate(): number;
    getAverageTip(): number;
    getMetrics(): {
        activeBundles: number;
        totalBundles: number;
        successRate: number;
        averageTip: number;
        averageExecutionTime: number;
    };
}
export declare const jitoBundleManager: JitoBundleManager;
export {};
//# sourceMappingURL=jitoBundleManager.d.ts.map