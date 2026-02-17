import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
export class PrivateKeyWallet {
    constructor() {
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "keypair", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        // Use Helius RPC endpoint from environment
        const heliusRpcUrl = import.meta.env.VITE_HELIUS_RPC_URL || '';
        if (!heliusRpcUrl) {
            console.error('❌ CRITICAL: VITE_HELIUS_RPC_URL not configured. Set it in .env.production');
        }
        this.connection = new Connection(heliusRpcUrl, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
        });
        console.log('🚀 Using Helius RPC endpoint for real trading');
    }
    async connectWithPrivateKey(privateKeyString) {
        try {
            console.log('🔗 Connecting with private key using Helius RPC...');
            // Decode private key from base58 string
            let privateKeyBytes;
            try {
                // Try base58 decode first
                privateKeyBytes = bs58.decode(privateKeyString);
            }
            catch (error) {
                // If base58 fails, try parsing as JSON array
                try {
                    const keyArray = JSON.parse(privateKeyString);
                    if (Array.isArray(keyArray) && keyArray.length === 64) {
                        privateKeyBytes = new Uint8Array(keyArray);
                    }
                    else {
                        throw new Error('Invalid array format');
                    }
                }
                catch {
                    throw new Error('Invalid private key format. Expected base58 string or JSON array of 64 numbers.');
                }
            }
            this.keypair = Keypair.fromSecretKey(privateKeyBytes);
            // Get real balance from Helius RPC
            const balance = await this.connection.getBalance(this.keypair.publicKey);
            const balanceInSol = balance / LAMPORTS_PER_SOL;
            const walletState = {
                isConnected: true,
                publicKey: this.keypair.publicKey,
                keypair: this.keypair,
                balance: balanceInSol
            };
            console.log('✅ Private key wallet connected via Helius:', {
                publicKey: this.keypair.publicKey.toBase58(),
                balance: balanceInSol,
                balanceLamports: balance
            });
            return walletState;
        }
        catch (error) {
            console.error('❌ Failed to connect with private key:', error);
            throw new Error(`Connection failed: ${error}`);
        }
    }
    async disconnectWallet() {
        this.keypair = null;
        console.log('✅ Private key wallet disconnected');
    }
    async getBalance() {
        try {
            if (!this.keypair) {
                return 0;
            }
            const balance = await this.connection.getBalance(this.keypair.publicKey);
            return balance / LAMPORTS_PER_SOL;
        }
        catch (error) {
            console.error('❌ Failed to get balance from Helius:', error);
            return 0;
        }
    }
    async signAndSendTransaction(transaction) {
        try {
            if (!this.keypair) {
                throw new Error('Wallet not connected');
            }
            console.log('📝 Signing transaction with private key via Helius...');
            let signature;
            if (transaction instanceof VersionedTransaction) {
                // Sign versioned transaction
                transaction.sign([this.keypair]);
                signature = await this.connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 5
                });
            }
            else {
                // Sign legacy transaction
                const { blockhash } = await this.connection.getLatestBlockhash();
                transaction.recentBlockhash = blockhash;
                transaction.feePayer = this.keypair.publicKey;
                transaction.sign(this.keypair);
                signature = await this.connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 5
                });
            }
            console.log('📤 Transaction sent via Helius:', signature);
            // Confirm transaction
            const confirmation = await this.connection.confirmTransaction({
                signature,
                blockhash: (await this.connection.getLatestBlockhash()).blockhash,
                lastValidBlockHeight: (await this.connection.getLatestBlockhash()).lastValidBlockHeight
            }, 'confirmed');
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }
            console.log('✅ Transaction confirmed via Helius:', signature);
            return signature;
        }
        catch (error) {
            console.error('❌ Failed to sign and send transaction via Helius:', error);
            throw error;
        }
    }
    getConnection() {
        return this.connection;
    }
    getKeypair() {
        return this.keypair;
    }
    isConnected() {
        return this.keypair !== null;
    }
    getPublicKey() {
        return this.keypair?.publicKey || null;
    }
}
export const privateKeyWallet = new PrivateKeyWallet();
