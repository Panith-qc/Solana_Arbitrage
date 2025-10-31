export interface WalletData {
    publicKey: string | null;
    balance: number;
    tokenAccounts: any[];
    recentTransactions: any[];
    isLoading: boolean;
    error: string | null;
    lastUpdated: number | null;
}
export interface WalletState {
    isConnected: boolean;
    publicKey: string | null;
    walletType: string | null;
    balance: number;
}
export declare const useWallet: () => {
    walletState: WalletState;
    walletData: WalletData;
    connectWallet: (walletType: string, privateKey?: string) => Promise<boolean>;
    disconnectWallet: () => void;
    refreshWalletData: () => Promise<void>;
    connected: boolean;
    publicKey: string;
    balance: number;
    isWalletReady: boolean;
    hasError: boolean;
    getShortAddress: () => string;
    validateConnection: () => true;
};
export default useWallet;
//# sourceMappingURL=useWallet.d.ts.map