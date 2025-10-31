import { Keypair } from '@solana/web3.js';
interface WalletState {
    isConnected: boolean;
    publicKey: string | null;
    walletType: 'private-key' | 'browser' | null;
    keypair: Keypair | null;
}
interface BalanceInfo {
    sol: number;
    usdc: number;
    usdt: number;
    totalUsd: number;
}
interface TransactionResult {
    success: boolean;
    signature?: string;
    error?: string;
    actualProfit?: number;
    executionTime?: number;
}
interface PerformanceMetrics {
    totalTrades: number;
    successfulTrades: number;
    totalProfit: number;
    winRate: number;
    avgExecutionTime: number;
    lastTradeTime: Date | null;
}
declare class ProductionWalletManager {
    private connection;
    private walletState;
    private balanceInfo;
    private performanceMetrics;
    private readonly RPC_ENDPOINTS;
    private currentRpcIndex;
    private readonly TOKEN_MINTS;
    constructor();
    private switchToBackupRpc;
    connectWallet(walletType: string, privateKey?: string): void;
    refreshBalance(): Promise<void>;
    private getSolPrice;
    executeTransaction(swapTransaction: string, tradeType: string, expectedProfit: number): Promise<TransactionResult>;
    private sendRealTransactionToBlockchain;
    updatePerformanceMetrics(profit: number, success: boolean): void;
    disconnect(): void;
    getWalletState(): WalletState;
    getBalanceInfo(): BalanceInfo;
    getPerformanceMetrics(): PerformanceMetrics;
    healthCheck(): Promise<boolean>;
}
export declare const productionWalletManager: ProductionWalletManager;
export {};
//# sourceMappingURL=productionWalletManager.d.ts.map