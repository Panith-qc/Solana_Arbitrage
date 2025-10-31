import { Keypair } from '@solana/web3.js';
export interface TradeParams {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
    wallet: Keypair;
    useJito?: boolean;
}
export interface FeeBreakdown {
    jupiterPlatformFeeLamports: number;
    jupiterRoutingFeeLamports: number;
    solanaBaseTxFeeLamports: number;
    priorityFeeLamports: number;
    totalFeeLamports: number;
    totalFeeSOL: number;
    totalFeeUSD: number;
}
export interface TradeResult {
    success: boolean;
    txSignature?: string;
    actualProfit?: number;
    actualProfitSOL?: number;
    actualOutputAmount?: number;
    fees: FeeBreakdown;
    executionTimeMs: number;
    error?: string;
    profitableBeforeExecution: boolean;
    dexUsed?: string;
}
export interface QualityCheckResult {
    shouldProceed: boolean;
    confidence?: number;
    reason?: string;
    expectedLossPercent?: number;
}
export interface TradeStats {
    totalAttempted: number;
    totalExecuted: number;
    totalSuccessful: number;
    totalSkipped: number;
    totalFailed: number;
    totalProfitUSD: number;
    successRate: number;
}
export declare class FinalRobustTradeExecutor {
    private connection;
    private solPriceCache;
    private PRICE_CACHE_TTL;
    private stats;
    constructor();
    getSOLPriceUSD(): Promise<number>;
    calculateTotalFees(inputMint: string, outputMint: string, amount: number, useJito?: boolean): Promise<FeeBreakdown>;
    private validateTradePair;
    private verifyTokenAccount;
    private qualityGate;
    executeTrade(params: TradeParams): Promise<TradeResult>;
    executeArbitrageCycle(tokenMint: string, amountSOL: number, slippageBps: number, wallet: Keypair, useJito?: boolean): Promise<{
        success: boolean;
        netProfitUSD: number;
        txSignatures: string[];
        skipped?: boolean;
    }>;
    private updateStats;
    getStats(): TradeStats;
}
export declare const realTradeExecutor: FinalRobustTradeExecutor;
//# sourceMappingURL=realTradeExecutor.d.ts.map