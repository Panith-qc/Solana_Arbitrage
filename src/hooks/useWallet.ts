import { useState, useEffect, useCallback } from 'react';
import { PublicKey } from '@solana/web3.js';
import { heliusService } from '../services/heliusService';

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

export const useWallet = () => {
  const [walletState, setWalletState] = useState<WalletState>({
    isConnected: false,
    publicKey: null,
    walletType: null,
    balance: 0
  });

  const [walletData, setWalletData] = useState<WalletData>({
    publicKey: null,
    balance: 0,
    tokenAccounts: [],
    recentTransactions: [],
    isLoading: false,
    error: null,
    lastUpdated: null
  });

  // Connect wallet with private key
  const connectWallet = useCallback(async (walletType: string, privateKey?: string) => {
    try {
      console.log(`🔗 Connecting ${walletType} wallet...`);
      setWalletData(prev => ({ ...prev, isLoading: true, error: null }));

      // For testing, create a mock public key
      const mockPublicKey = privateKey ? 
        `${privateKey.slice(0, 8)}...${privateKey.slice(-8)}` : 
        'TestWallet123...456';

      // Simulate wallet connection
      const newWalletState = {
        isConnected: true,
        publicKey: mockPublicKey,
        walletType: walletType,
        balance: 10.0 // Test balance
      };

      setWalletState(newWalletState);
      
      // Update wallet data
      setWalletData({
        publicKey: mockPublicKey,
        balance: 10.0,
        tokenAccounts: [],
        recentTransactions: [],
        isLoading: false,
        error: null,
        lastUpdated: Date.now()
      });

      console.log('✅ Wallet connected successfully');
      return true;
    } catch (error) {
      console.error('❌ Wallet connection failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet';
      setWalletData(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage
      }));
      return false;
    }
  }, []);

  // Disconnect wallet
  const disconnectWallet = useCallback(() => {
    console.log('🔌 Disconnecting wallet...');
    
    setWalletState({
      isConnected: false,
      publicKey: null,
      walletType: null,
      balance: 0
    });
    
    setWalletData({
      publicKey: null,
      balance: 0,
      tokenAccounts: [],
      recentTransactions: [],
      isLoading: false,
      error: null,
      lastUpdated: null
    });

    console.log('✅ Wallet disconnected');
  }, []);

  // Refresh wallet data
  const refreshWalletData = useCallback(async () => {
    if (!walletState.isConnected || !walletState.publicKey) {
      return;
    }

    try {
      console.log('🔄 Refreshing wallet data...');
      setWalletData(prev => ({ ...prev, isLoading: true, error: null }));

      // For testing, keep the same balance
      setWalletData(prev => ({
        ...prev,
        balance: 10.0,
        isLoading: false,
        lastUpdated: Date.now()
      }));

      console.log('✅ Wallet data refreshed');
    } catch (error) {
      console.error('❌ Failed to refresh wallet data:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to refresh wallet data';
      setWalletData(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage
      }));
    }
  }, [walletState.isConnected, walletState.publicKey]);

  // Validate connection
  const validateConnection = useCallback(() => {
    if (!walletState.isConnected) {
      throw new Error('Wallet not connected');
    }
    if (!walletState.publicKey) {
      throw new Error('No public key available');
    }
    if (walletData.isLoading) {
      throw new Error('Wallet data still loading');
    }
    return true;
  }, [walletState.isConnected, walletState.publicKey, walletData.isLoading]);

  // Get short address
  const getShortAddress = useCallback(() => {
    if (!walletState.publicKey) return null;
    const addr = walletState.publicKey;
    return `${addr.substring(0, 4)}...${addr.substring(addr.length - 4)}`;
  }, [walletState.publicKey]);

  return {
    // Wallet state
    walletState,
    walletData,
    
    // Actions
    connectWallet,
    disconnectWallet,
    refreshWalletData,
    
    // Computed properties
    connected: walletState.isConnected,
    publicKey: walletState.publicKey,
    balance: walletState.balance,
    isWalletReady: walletState.isConnected && walletState.publicKey && !walletData.isLoading,
    hasError: !!walletData.error,
    
    // Helper methods
    getShortAddress,
    validateConnection
  };
};

export default useWallet;