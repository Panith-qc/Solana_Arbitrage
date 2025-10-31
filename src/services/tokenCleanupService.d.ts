export interface TokenBalance {
    mint: string;
    symbol: string;
    amount: number;
    uiAmount: number;
    usdValue: number;
}
export interface CleanupResult {
    success: boolean;
    cleaned: number;
    tokensCleaned?: number;
    totalValueRecovered?: number;
    transactions?: string[];
    errors?: string[];
}
declare class TokenCleanupServiceImpl {
    private connection;
    constructor();
    scanWalletTokens(walletAddress?: string): Promise<TokenBalance[]>;
    cleanupAllTokens(minValueUsd?: number): Promise<CleanupResult>;
}
export declare const tokenCleanupService: TokenCleanupServiceImpl;
export {};
//# sourceMappingURL=tokenCleanupService.d.ts.map