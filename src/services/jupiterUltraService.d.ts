import { VersionedTransaction, Connection } from '@solana/web3.js';
export interface JupiterUltraOrderResponse {
    requestId: string;
    transaction: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    slippageBps?: number;
    priceImpactPct?: string;
    routePlan?: any[];
    priorityFeeLamports?: string;
    lastValidBlockHeight?: number;
    [key: string]: any;
}
export interface JupiterUltraExecuteRequest {
    requestId: string;
    signedTransaction: string;
}
export interface JupiterUltraExecuteResponse {
    status: string;
    signature?: string;
    slot?: number | string;
    [key: string]: any;
}
export interface JupiterLegacyQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    platformFee: {
        amount: string;
        feeBps: number;
    } | null;
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
        percent: number;
    }>;
    contextSlot?: number;
    timeTaken?: number;
}
export interface JupiterLegacySwapRequest {
    quoteResponse: JupiterLegacyQuoteResponse;
    userPublicKey: string;
    wrapAndUnwrapSol?: boolean;
    prioritizationFeeLamports?: string | 'auto';
    asLegacyTransaction?: boolean;
    useSharedAccounts?: boolean;
    feeAccount?: string;
    trackingAccount?: string;
    computeUnitPriceMicroLamports?: string | 'auto';
    dynamicComputeUnitLimit?: boolean;
    skipUserAccountsRpcCalls?: boolean;
}
export interface JupiterLegacySwapResponse {
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports?: number;
    [key: string]: any;
}
export interface UltraOrderDisplay {
    order: {
        orderId: string;
        inputMint: string;
        outputMint: string;
        inAmount: string;
        outAmount: string;
        estimatedSlippageBps: number | undefined;
        priceImpactPct: string | undefined;
        routes: any[];
        executionStrategy: 'ultra';
        gasless: boolean | undefined;
    };
    quote: {
        inputAmountRaw: string;
        outputAmountRaw: string;
        pricePerInputTokenApprox: string;
        pricePerOutputTokenApprox: string;
    };
    timeTakenMs: number;
}
export type GenericSigner = {
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction> | VersionedTransaction;
};
interface JupiterServiceOptions {
    backendSwapProxyBaseUrl?: string;
}
export declare class JupiterService {
    private backendSwapProxyBaseUrl;
    private metrics;
    constructor(opts?: JupiterServiceOptions);
    private fetchWithTimeout;
    getUltraOrder(args: {
        inputMint: string;
        outputMint: string;
        rawAmount: string;
        takerPubkey: string;
        slippageBps?: number;
    }): Promise<JupiterUltraOrderResponse>;
    signUltraTransaction(unsignedTxBase64: string, signer: any): Promise<string>;
    executeUltraOrder(args: {
        requestId: string;
        signedTransactionBase64: string;
    }): Promise<JupiterUltraExecuteResponse>;
    createUltraDisplay(args: {
        inputMint: string;
        outputMint: string;
        rawAmount: string;
        takerPubkey: string;
        slippageBps?: number;
    }): Promise<UltraOrderDisplay>;
    getLegacyQuote(args: {
        inputMint: string;
        outputMint: string;
        rawAmount: string;
        slippageBps?: number;
    }): Promise<JupiterLegacyQuoteResponse>;
    buildLegacySwapTransaction(args: {
        quoteResponse: JupiterLegacyQuoteResponse;
        userPublicKey: string;
    }): Promise<JupiterLegacySwapResponse>;
    getPrices(mints: string[]): Promise<Record<string, {
        price: number;
        symbol: string;
        [key: string]: any;
    }>>;
    getMetrics(): {
        ultraOrderSuccessRate: string;
        ultraExecuteSuccessRate: string;
        legacyQuoteSuccessRate: string;
        legacySwapSuccessRate: string;
        totalUltraOrders: number;
        successfulUltraOrders: number;
        failedUltraOrders: number;
        avgUltraOrderMs: number;
        totalUltraExecutes: number;
        successfulUltraExecutes: number;
        failedUltraExecutes: number;
        avgUltraExecuteMs: number;
        totalLegacyQuotes: number;
        successfulLegacyQuotes: number;
        failedLegacyQuotes: number;
        avgLegacyQuoteMs: number;
        totalLegacySwaps: number;
        successfulLegacySwaps: number;
        failedLegacySwaps: number;
        avgLegacySwapMs: number;
    };
    sendSignedTransaction(connection: Connection, signedTxBase64: string): Promise<string>;
}
export declare function getJupiterService(opts?: JupiterServiceOptions): JupiterService;
export declare const jupiterUltraService: JupiterService;
export interface JupiterQuote {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPct?: string;
    platformFee: number | null;
    contextSlot?: number;
}
export interface JupiterSwapResult {
    swapTransaction: string;
    lastValidBlockHeight: number;
}
export {};
//# sourceMappingURL=jupiterUltraService.d.ts.map