import { Connection } from '@solana/web3.js';
export class RealSolanaWallet {
    constructor() {
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "wallet", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        // Use Solana mainnet RPC
        this.connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    }
    async connectWallet(walletAdapter) {
        try {
            console.log('🔗 Connecting to real Solana wallet...');
            await walletAdapter.connect();
            this.wallet = walletAdapter;
            console.log('✅ Real wallet connected:', walletAdapter.publicKey?.toString());
        }
        catch (error) {
            console.error('❌ Wallet connection failed:', error);
            throw error;
        }
    }
    async disconnectWallet() {
        if (this.wallet) {
            await this.wallet.disconnect();
            this.wallet = null;
            console.log('✅ Wallet disconnected');
        }
    }
    async getBalance() {
        if (!this.wallet?.publicKey) {
            throw new Error('Wallet not connected');
        }
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            return balance / 1e9; // Convert lamports to SOL
        }
        catch (error) {
            console.error('❌ Failed to get balance:', error);
            throw error;
        }
    }
    async signAndSendTransaction(transaction) {
        if (!this.wallet) {
            throw new Error('Wallet not connected');
        }
        try {
            console.log('🔄 Signing transaction...');
            const signedTransaction = await this.wallet.signTransaction(transaction);
            console.log('📡 Sending transaction to blockchain...');
            const signature = await this.connection.sendRawTransaction(signedTransaction.serialize());
            console.log('⏳ Confirming transaction...');
            await this.connection.confirmTransaction(signature, 'confirmed');
            console.log('✅ Transaction confirmed:', signature);
            return signature;
        }
        catch (error) {
            console.error('❌ Transaction failed:', error);
            throw error;
        }
    }
    getConnection() {
        return this.connection;
    }
    getWallet() {
        return this.wallet;
    }
    isConnected() {
        return this.wallet?.connected || false;
    }
    getPublicKey() {
        return this.wallet?.publicKey || null;
    }
}
export const realSolanaWallet = new RealSolanaWallet();
