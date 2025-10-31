interface WalletState {
    isConnected: boolean;
    publicKey: string | null;
    privateKey: string | null;
    balance: number;
}
interface TransactionResult {
    success: boolean;
    signature?: string;
    error?: string;
    actualProfit?: number;
}
declare class RealWalletManager {
    private connection;
    private keypair;
    private walletState;
    constructor();
    importWallet(privateKeyString: string): Promise<boolean>;
    getBalance(): Promise<number>;
    executeTransaction(swapTransaction: string, tradeType: string, expectedProfit: number): Promise<TransactionResult>;
    getWalletState(): WalletState;
    refreshBalance(): Promise<void>;
    disconnect(): void;
}
export declare const realWalletManager: RealWalletManager;
export {};
//# sourceMappingURL=realWalletManager.d.ts.map