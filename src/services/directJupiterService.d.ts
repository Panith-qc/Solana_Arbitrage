interface JupiterQuote {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    platformFee: any;
    priceImpactPct: string;
    routePlan: any[];
    contextSlot: number;
    timeTaken: number;
}
interface JupiterPriceData {
    data: {
        [key: string]: {
            id: string;
            mintSymbol: string;
            vsToken: string;
            vsTokenSymbol: string;
            price: number;
        };
    };
    timeTaken: number;
}
declare class DirectJupiterService {
    private readonly JUPITER_QUOTE_API;
    private readonly JUPITER_PRICE_API;
    constructor();
    getQuote(inputMint: string, outputMint: string, amount: string, slippageBps?: number): Promise<JupiterQuote>;
    getPrice(tokenId: string): Promise<JupiterPriceData>;
    testConnection(): Promise<boolean>;
}
export declare const directJupiterService: DirectJupiterService;
export {};
//# sourceMappingURL=directJupiterService.d.ts.map