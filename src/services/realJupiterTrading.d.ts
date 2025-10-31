export interface JupiterQuote {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    platformFee: null;
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
    }>;
}
export interface JupiterSwapResult {
    swapTransaction: string;
    lastValidBlockHeight: number;
}
export interface MEVOpportunity {
    id: string;
    type: 'ARBITRAGE' | 'SANDWICH' | 'LIQUIDATION' | 'MICRO_ARBITRAGE' | 'PRICE_RECOVERY';
    pair: string;
    inputMint: string;
    outputMint: string;
    inputAmount: number;
    expectedOutput: number;
    profitUsd: number;
    profitPercent: number;
    confidence: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA_LOW';
    timestamp: Date;
    quote: JupiterQuote;
    capitalRequired: number;
}
export declare class RealJupiterTrading {
    private connection;
    private jupiterApiUrl;
    constructor();
    getQuote(inputMint: string, outputMint: string, amount: number, slippageBps?: number): Promise<JupiterQuote | null>;
    getSwapTransaction(quote: JupiterQuote): Promise<JupiterSwapResult | null>;
    executeSwap(quote: JupiterQuote): Promise<string>;
    scanForArbitrageOpportunities(): Promise<MEVOpportunity[]>;
    private calculateProfitUsd;
    executeMEVTrade(opportunity: MEVOpportunity): Promise<string>;
}
export declare const realJupiterTrading: RealJupiterTrading;
//# sourceMappingURL=realJupiterTrading.d.ts.map