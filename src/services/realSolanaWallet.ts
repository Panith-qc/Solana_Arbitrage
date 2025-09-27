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

export class RealSolanaWallet {
  private connection: Connection;
  private wallet: WalletAdapter | null = null;

  constructor() {
    // Use Solana mainnet RPC
    this.connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  }

  async connectWallet(walletAdapter: WalletAdapter): Promise<void> {
    try {
      console.log('🔗 Connecting to real Solana wallet...');
      await walletAdapter.connect();
      this.wallet = walletAdapter;
      console.log('✅ Real wallet connected:', walletAdapter.publicKey?.toString());
    } catch (error) {
      console.error('❌ Wallet connection failed:', error);
      throw error;
    }
  }

  async disconnectWallet(): Promise<void> {
    if (this.wallet) {
      await this.wallet.disconnect();
      this.wallet = null;
      console.log('✅ Wallet disconnected');
    }
  }

  async getBalance(): Promise<number> {
    if (!this.wallet?.publicKey) {
      throw new Error('Wallet not connected');
    }

    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      console.error('❌ Failed to get balance:', error);
      throw error;
    }
  }

  async signAndSendTransaction(transaction: Transaction): Promise<string> {
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
    } catch (error) {
      console.error('❌ Transaction failed:', error);
      throw error;
    }
  }

  getConnection(): Connection {
    return this.connection;
  }

  getWallet(): WalletAdapter | null {
    return this.wallet;
  }

  isConnected(): boolean {
    return this.wallet?.connected || false;
  }

  getPublicKey(): PublicKey | null {
    return this.wallet?.publicKey || null;
  }
}

export const realSolanaWallet = new RealSolanaWallet();