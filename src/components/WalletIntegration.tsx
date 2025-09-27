import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Wallet, RefreshCw, TrendingUp, Activity, DollarSign, Clock } from 'lucide-react';
import { productionWalletManager } from '@/services/productionWalletManager';

interface WalletState {
  isConnected: boolean;
  publicKey: string | null;
  walletType: string | null;
}

interface BalanceInfo {
  sol: number;
  usdc: number;
  usdt: number;
  totalUsd: number;
}

interface PerformanceMetrics {
  totalTrades: number;
  successfulTrades: number;
  totalProfit: number;
  winRate: number;
  avgExecutionTime: number;
  lastTradeTime: Date | null;
}

const WalletIntegration: React.FC = () => {
  const [walletState, setWalletState] = useState<WalletState>({
    isConnected: false,
    publicKey: null,
    walletType: null
  });

  const [balanceInfo, setBalanceInfo] = useState<BalanceInfo>({
    sol: 0,
    usdc: 0,
    usdt: 0,
    totalUsd: 0
  });

  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics>({
    totalTrades: 0,
    successfulTrades: 0,
    totalProfit: 0,
    winRate: 0,
    avgExecutionTime: 0,
    lastTradeTime: null
  });

  const [privateKey, setPrivateKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Update wallet state from manager
  const updateWalletState = () => {
    try {
      const state = productionWalletManager.getWalletState();
      const balance = productionWalletManager.getBalanceInfo();
      const metrics = productionWalletManager.getPerformanceMetrics();

      setWalletState({
        isConnected: state.isConnected || false,
        publicKey: state.publicKey || null,
        walletType: state.walletType || null
      });

      setBalanceInfo({
        sol: balance?.sol || 0,
        usdc: balance?.usdc || 0,
        usdt: balance?.usdt || 0,
        totalUsd: balance?.totalUsd || 0
      });

      setPerformanceMetrics({
        totalTrades: metrics?.totalTrades || 0,
        successfulTrades: metrics?.successfulTrades || 0,
        totalProfit: metrics?.totalProfit || 0,
        winRate: metrics?.winRate || 0,
        avgExecutionTime: metrics?.avgExecutionTime || 0,
        lastTradeTime: metrics?.lastTradeTime || null
      });
    } catch (error) {
      console.error('Error updating wallet state:', error);
    }
  };

  // Connect wallet with private key
  const connectWallet = async () => {
    if (!privateKey.trim()) {
      setConnectionError('Please enter a private key');
      return;
    }

    setIsConnecting(true);
    setConnectionError(null);

    try {
      console.log('🔗 Connecting wallet with private key...');
      
      // Connect using production wallet manager
      productionWalletManager.connectWallet('private-key', privateKey.trim());
      
      // Update state
      updateWalletState();
      
      console.log('✅ Wallet connected successfully');
      
      // Clear private key from input for security
      setPrivateKey('');
      
    } catch (error) {
      console.error('❌ Wallet connection failed:', error);
      setConnectionError(error instanceof Error ? error.message : 'Failed to connect wallet');
    } finally {
      setIsConnecting(false);
    }
  };

  // Refresh wallet balance
  const refreshBalance = async () => {
    if (!walletState.isConnected) {
      setConnectionError('Wallet not connected');
      return;
    }

    setIsRefreshing(true);
    setConnectionError(null);

    try {
      console.log('🔄 Refreshing wallet balance...');
      
      await productionWalletManager.refreshBalance();
      
      // Update state
      updateWalletState();
      
      console.log('✅ Balance refreshed successfully');
      
    } catch (error) {
      console.error('❌ Balance refresh failed:', error);
      setConnectionError(error instanceof Error ? error.message : 'Failed to refresh balance');
    } finally {
      setIsRefreshing(false);
    }
  };

  // Disconnect wallet
  const disconnectWallet = () => {
    try {
      productionWalletManager.disconnect();
      
      setWalletState({
        isConnected: false,
        publicKey: null,
        walletType: null
      });

      setBalanceInfo({
        sol: 0,
        usdc: 0,
        usdt: 0,
        totalUsd: 0
      });

      setPerformanceMetrics({
        totalTrades: 0,
        successfulTrades: 0,
        totalProfit: 0,
        winRate: 0,
        avgExecutionTime: 0,
        lastTradeTime: null
      });

      setConnectionError(null);
      console.log('🔌 Wallet disconnected');
      
    } catch (error) {
      console.error('❌ Disconnect failed:', error);
      setConnectionError(error instanceof Error ? error.message : 'Failed to disconnect wallet');
    }
  };

  // Format public key for display
  const formatPublicKey = (key: string | null): string => {
    if (!key) return 'Not connected';
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  };

  // Format balance with safe number handling
  const formatBalance = (value: number | undefined | null): string => {
    if (typeof value !== 'number' || isNaN(value)) return '0.00';
    return value.toFixed(6);
  };

  // Format USD with safe number handling
  const formatUsd = (value: number | undefined | null): string => {
    if (typeof value !== 'number' || isNaN(value)) return '0.00';
    return value.toFixed(2);
  };

  // Format percentage with safe number handling
  const formatPercentage = (value: number | undefined | null): string => {
    if (typeof value !== 'number' || isNaN(value)) return '0.0';
    return value.toFixed(1);
  };

  // Update wallet state on component mount
  useEffect(() => {
    updateWalletState();
    
    // Set up periodic updates
    const interval = setInterval(updateWalletState, 5000);
    
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            Wallet Connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!walletState.isConnected ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Private Key (Base58)</label>
                <Input
                  type="password"
                  placeholder="Enter your Solana private key..."
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  disabled={isConnecting}
                />
              </div>
              
              <Button 
                onClick={connectWallet}
                disabled={isConnecting || !privateKey.trim()}
                className="w-full"
              >
                {isConnecting ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Wallet className="mr-2 h-4 w-4" />
                    Connect Wallet
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Connected Wallet</p>
                  <p className="font-mono text-sm">{formatPublicKey(walletState.publicKey)}</p>
                </div>
                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                  Connected
                </Badge>
              </div>
              
              <div className="flex gap-2">
                <Button 
                  onClick={refreshBalance}
                  disabled={isRefreshing}
                  variant="outline"
                  size="sm"
                >
                  {isRefreshing ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Refreshing...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4" />
                      Refresh
                    </>
                  )}
                </Button>
                
                <Button 
                  onClick={disconnectWallet}
                  variant="outline"
                  size="sm"
                >
                  Disconnect
                </Button>
              </div>
            </div>
          )}

          {connectionError && (
            <Alert variant="destructive">
              <AlertDescription>{connectionError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Balance Information */}
      {walletState.isConnected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Wallet Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-blue-50 rounded-lg">
                <p className="text-sm text-muted-foreground">SOL Balance</p>
                <p className="text-2xl font-bold text-blue-600">
                  {formatBalance(balanceInfo.sol)}
                </p>
                <p className="text-xs text-muted-foreground">SOL</p>
              </div>
              
              <div className="text-center p-4 bg-green-50 rounded-lg">
                <p className="text-sm text-muted-foreground">USDC Balance</p>
                <p className="text-2xl font-bold text-green-600">
                  {formatUsd(balanceInfo.usdc)}
                </p>
                <p className="text-xs text-muted-foreground">USDC</p>
              </div>
              
              <div className="text-center p-4 bg-purple-50 rounded-lg">
                <p className="text-sm text-muted-foreground">USDT Balance</p>
                <p className="text-2xl font-bold text-purple-600">
                  {formatUsd(balanceInfo.usdt)}
                </p>
                <p className="text-xs text-muted-foreground">USDT</p>
              </div>
              
              <div className="text-center p-4 bg-orange-50 rounded-lg">
                <p className="text-sm text-muted-foreground">Total USD Value</p>
                <p className="text-2xl font-bold text-orange-600">
                  ${formatUsd(balanceInfo.totalUsd)}
                </p>
                <p className="text-xs text-muted-foreground">USD</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Performance Metrics */}
      {walletState.isConnected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Trading Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="text-center p-4 bg-slate-50 rounded-lg">
                <p className="text-sm text-muted-foreground">Total Trades</p>
                <p className="text-2xl font-bold">{performanceMetrics.totalTrades || 0}</p>
              </div>
              
              <div className="text-center p-4 bg-green-50 rounded-lg">
                <p className="text-sm text-muted-foreground">Successful Trades</p>
                <p className="text-2xl font-bold text-green-600">{performanceMetrics.successfulTrades || 0}</p>
              </div>
              
              <div className="text-center p-4 bg-blue-50 rounded-lg">
                <p className="text-sm text-muted-foreground">Win Rate</p>
                <p className="text-2xl font-bold text-blue-600">{formatPercentage(performanceMetrics.winRate)}%</p>
              </div>
              
              <div className="text-center p-4 bg-purple-50 rounded-lg">
                <p className="text-sm text-muted-foreground">Total Profit</p>
                <p className="text-2xl font-bold text-purple-600">
                  ${formatUsd(performanceMetrics.totalProfit)}
                </p>
              </div>
            </div>
            
            {performanceMetrics.lastTradeTime && (
              <div className="mt-4 pt-4 border-t">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Last Trade: {new Date(performanceMetrics.lastTradeTime).toLocaleString()}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default WalletIntegration;