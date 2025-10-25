// HELIUS API SERVICE - COMPREHENSIVE SOLANA DATA
import { Connection, PublicKey, ParsedAccountData } from '@solana/web3.js';

const HELIUS_API_KEY = process.env.NEXT_PUBLIC_HELIUS_API_KEY || '926fd4af-7c9d-4fa3-9504-a2970ac5f16d';
const HELIUS_RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API_URL = `https://api.helius.xyz/v0`;

class HeliusService {
  private connection: Connection;
  private apiKey: string;

  constructor() {
    this.apiKey = HELIUS_API_KEY;
    this.connection = new Connection(HELIUS_RPC_URL, 'confirmed');
    console.log('🚀 Helius Service initialized with Devnet RPC:', HELIUS_RPC_URL.substring(0, 50) + '...');
  }

  // Get RPC connection
  getConnection(): Connection {
    return this.connection;
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const slot = await this.connection.getSlot();
      console.log('✅ Helius Devnet RPC healthy, current slot:', slot);
      return true;
    } catch (error) {
      console.error('❌ Helius Devnet RPC health check failed:', error);
      return false;
    }
  }

  // Get wallet balance
  async getBalance(publicKey: PublicKey): Promise<number> {
    try {
      const balance = await this.connection.getBalance(publicKey);
      console.log(`💰 Fetched balance for ${publicKey.toString()}: ${balance / 1e9} SOL`);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      console.error('❌ Failed to get balance:', error);
      throw error;
    }
  }

  // Get token accounts for a wallet
  async getTokenAccounts(publicKey: PublicKey) {
    try {
      const response = await fetch(`${HELIUS_API_URL}/addresses/${publicKey.toString()}/balances?api-key=${this.apiKey}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Helius API error: ${data.error || response.statusText}`);
      }

      console.log(`📊 Fetched ${data.tokens?.length || 0} token accounts for wallet`);
      return data.tokens || [];
    } catch (error) {
      console.error('❌ Failed to get token accounts:', error);
      throw error;
    }
  }

  // Get transaction history
  async getTransactionHistory(publicKey: PublicKey, limit: number = 10) {
    try {
      const response = await fetch(`${HELIUS_API_URL}/addresses/${publicKey.toString()}/transactions?api-key=${this.apiKey}&limit=${limit}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(`Helius API error: ${data.error || response.statusText}`);
      }

      console.log(`📜 Fetched ${data.length || 0} transactions for wallet`);
      return data;
    } catch (error) {
      console.error('❌ Failed to get transaction history:', error);
      throw error;
    }
  }

  // Get comprehensive wallet data using Helius
  async getWalletData(publicKey: PublicKey) {
    try {
      console.log('📊 Fetching comprehensive wallet data using Helius Devnet for:', publicKey.toString());
      
      const [balance, tokenAccounts, recentTransactions] = await Promise.allSettled([
        this.getBalance(publicKey),
        this.getTokenAccounts(publicKey),
        this.getTransactionHistory(publicKey, 5)
      ]);

      const walletData = {
        publicKey: publicKey.toString(),
        balance: balance.status === 'fulfilled' ? balance.value : 0,
        tokenAccounts: tokenAccounts.status === 'fulfilled' ? tokenAccounts.value : [],
        recentTransactions: recentTransactions.status === 'fulfilled' ? recentTransactions.value : [],
        timestamp: Date.now(),
        network: 'devnet'
      };

      console.log('✅ Wallet data fetched successfully:', {
        address: walletData.publicKey.substring(0, 8) + '...',
        balance: walletData.balance,
        tokens: walletData.tokenAccounts.length,
        transactions: walletData.recentTransactions.length,
        network: walletData.network
      });

      return walletData;
    } catch (error) {
      console.error('❌ Failed to get wallet data:', error);
      throw error;
    }
  }

  // Get API usage stats
  getApiStats() {
    return {
      apiKey: this.apiKey.substring(0, 8) + '...',
      rpcEndpoint: HELIUS_RPC_URL,
      apiEndpoint: HELIUS_API_URL,
      network: 'devnet',
      isConfigured: this.apiKey !== 'your-helius-api-key-here'
    };
  }

  // Test connection with real API call
  async testConnection() {
    try {
      console.log('🧪 Testing Helius Devnet connection...');
      const slot = await this.connection.getSlot();
      const version = await this.connection.getVersion();
      
      console.log('✅ Helius Devnet connection test successful:', {
        slot,
        version: version['solana-core'],
        rpcUrl: HELIUS_RPC_URL.substring(0, 50) + '...'
      });
      
      return {
        success: true,
        slot,
        version: version['solana-core'],
        network: 'devnet'
      };
    } catch (error) {
      console.error('❌ Helius Devnet connection test failed:', error);
      return {
        success: false,
        error: error.message,
        network: 'devnet'
      };
    }
  }
}

export const heliusService = new HeliusService();
export default heliusService;