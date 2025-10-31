import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
export interface PrivateKeyWalletState {
    isConnected: boolean;
    publicKey: PublicKey | null;
    keypair: Keypair | null;
    balance: number;
}
export declare class PrivateKeyWallet {
    private connection;
    private keypair;
    constructor();
    connectWithPrivateKey(privateKeyString: string): Promise<PrivateKeyWalletState>;
    disconnectWallet(): Promise<void>;
    getBalance(): Promise<number>;
    signAndSendTransaction(transaction: Transaction | VersionedTransaction): Promise<string>;
    getConnection(): Connection;
    getKeypair(): Keypair | null;
    isConnected(): boolean;
    getPublicKey(): PublicKey | null;
}
export declare const privateKeyWallet: PrivateKeyWallet;
//# sourceMappingURL=privateKeyWallet.d.ts.map