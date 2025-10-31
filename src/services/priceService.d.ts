export interface TokenPrice {
    mint: string;
    price: number;
    symbol: string;
    lastUpdated: number;
}
declare class PriceService {
    private priceCache;
    private cacheTimeout;
    private supabaseUrl;
    private supabaseKey;
    private readonly USDC_MINT;
    private readonly USDT_MINT;
    private readonly SOL_MINT;
    private readonly TOKEN_DECIMALS;
    constructor();
    getPriceUsd(mint: string): Promise<number>;
    getMultiplePrices(mints: string[]): Promise<Map<string, number>>;
    isHealthy(): boolean;
    healthCheck(): Promise<boolean>;
    clearCache(): void;
    calculateUsdValue(amount: number, mint: string, decimals?: number): Promise<number>;
    getMetrics(): {
        apiEndpoint: string;
        provider: string;
        isHealthy: boolean;
        cacheSize: number;
        source: string;
    };
}
export declare const priceService: PriceService;
export default priceService;
//# sourceMappingURL=priceService.d.ts.map