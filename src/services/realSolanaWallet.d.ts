import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
export interface WalletAdapter {
    publicKey: PublicKey | null;
    connected: boolean;
    connecting: boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
    signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
}
export declare class RealSolanaWallet {
    private connection;
    private wallet;
    constructor();
    connectWallet(walletAdapter: WalletAdapter): Promise<void>;
    disconnectWallet(): Promise<void>;
    getBalance(): Promise<number>;
    signAndSendTransaction(transaction: Transaction): Promise<string>;
    getConnection(): Connection;
    getWallet(): WalletAdapter | null;
    isConnected(): boolean;
    getPublicKey(): PublicKey | null;
}
export declare const realSolanaWallet: RealSolanaWallet;
//# sourceMappingURL=realSolanaWallet.d.ts.map