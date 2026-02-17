// HELIUS API SERVICE - COMPREHENSIVE SOLANA DATA
import { Connection } from '@solana/web3.js';
const HELIUS_API_KEY = import.meta.env.VITE_HELIUS_API_KEY || process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL = import.meta.env.VITE_HELIUS_RPC_URL || process.env.HELIUS_RPC_URL || '';
const HELIUS_API_URL = `https://api.helius.xyz/v0`;
if (!HELIUS_API_KEY || !HELIUS_RPC_URL) {
    console.error('❌ CRITICAL: Helius API key or RPC URL not configured. Set HELIUS_API_KEY and HELIUS_RPC_URL in .env.production');
}
class HeliusService {
    constructor() {
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "apiKey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.apiKey = HELIUS_API_KEY;
        this.connection = new Connection(HELIUS_RPC_URL, 'confirmed');
        console.log('🚀 Helius Service initialized with RPC:', HELIUS_RPC_URL ? HELIUS_RPC_URL.substring(0, 50) + '...' : 'NOT CONFIGURED');
    }
    // Get RPC connection
    getConnection() {
        return this.connection;
    }
    // Health check
    async healthCheck() {
        try {
            const slot = await this.connection.getSlot();
            console.log('✅ Helius RPC healthy, current slot:', slot);
            return true;
        }
        catch (error) {
            console.error('❌ Helius RPC health check failed:', error);
            return false;
        }
    }
    // Get wallet balance
    async getBalance(publicKey) {
        try {
            const balance = await this.connection.getBalance(publicKey);
            console.log(`💰 Fetched balance for ${publicKey.toString()}: ${balance / 1e9} SOL`);
            return balance / 1e9; // Convert lamports to SOL
        }
        catch (error) {
            console.error('❌ Failed to get balance:', error);
            throw error;
        }
    }
    // Get token accounts for a wallet
    async getTokenAccounts(publicKey) {
        try {
            const response = await fetch(`${HELIUS_API_URL}/addresses/${publicKey.toString()}/balances?api-key=${this.apiKey}`);
            const data = await response.json();
            if (!response.ok) {
                throw new Error(`Helius API error: ${data.error || response.statusText}`);
            }
            console.log(`📊 Fetched ${data.tokens?.length || 0} token accounts for wallet`);
            return data.tokens || [];
        }
        catch (error) {
            console.error('❌ Failed to get token accounts:', error);
            throw error;
        }
    }
    // Get transaction history
    async getTransactionHistory(publicKey, limit = 10) {
        try {
            const response = await fetch(`${HELIUS_API_URL}/addresses/${publicKey.toString()}/transactions?api-key=${this.apiKey}&limit=${limit}`);
            const data = await response.json();
            if (!response.ok) {
                throw new Error(`Helius API error: ${data.error || response.statusText}`);
            }
            console.log(`📜 Fetched ${data.length || 0} transactions for wallet`);
            return data;
        }
        catch (error) {
            console.error('❌ Failed to get transaction history:', error);
            throw error;
        }
    }
    // Get comprehensive wallet data using Helius
    async getWalletData(publicKey) {
        try {
            console.log('📊 Fetching comprehensive wallet data using Helius for:', publicKey.toString());
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
                network: 'mainnet'
            };
            console.log('✅ Wallet data fetched successfully:', {
                address: walletData.publicKey.substring(0, 8) + '...',
                balance: walletData.balance,
                tokens: walletData.tokenAccounts.length,
                transactions: walletData.recentTransactions.length
            });
            return walletData;
        }
        catch (error) {
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
            console.log('🧪 Testing Helius connection...');
            const slot = await this.connection.getSlot();
            const version = await this.connection.getVersion();
            console.log('✅ Helius connection test successful:', {
                slot,
                version: version['solana-core'],
                rpcUrl: HELIUS_RPC_URL.substring(0, 50) + '...'
            });
            return {
                success: true,
                slot,
                version: version['solana-core'],
                network: 'mainnet'
            };
        }
        catch (error) {
            console.error('❌ Helius connection test failed:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                success: false,
                error: errorMessage,
                network: 'mainnet'
            };
        }
    }
}
export const heliusService = new HeliusService();
export default heliusService;
