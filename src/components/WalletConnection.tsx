import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Alert, AlertDescription } from './ui/alert';
import { Wallet, AlertCircle, CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { heliusService } from '../services/heliusService';

interface WalletConnectionProps {
  showDetails?: boolean;
  className?: string;
  onWalletConnect?: (walletType: string, privateKey?: string) => void;
  onWalletDisconnect?: () => void;
  onRefreshBalance?: () => void;
}

export const WalletConnection: React.FC<WalletConnectionProps> = ({ 
  showDetails = false, 
  className = '',
  onWalletConnect,
  onWalletDisconnect,
  onRefreshBalance
}) => {
  const { 
    walletState, 
    walletData, 
    connectWallet, 
    disconnectWallet, 
    refreshWalletData,
    getShortAddress 
  } = useWallet();

  const [privateKey, setPrivateKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rpcStatus, setRpcStatus] = useState<'checking' | 'healthy' | 'error'>('checking');

  // Check Helius Devnet RPC connection health
  const checkRpcHealth = async () => {
    try {
      setRpcStatus('checking');
      console.log('🔍 Checking Helius Devnet RPC health...');
      
      const testResult = await heliusService.testConnection();
      if (testResult.success) {
        setRpcStatus('healthy');
        console.log('✅ Helius Devnet RPC is healthy');
      } else {
        setRpcStatus('error');
        console.error('❌ Helius Devnet RPC test failed:', testResult.error);
      }
    } catch (error) {
      console.error('❌ Helius Devnet RPC error:', error);
      setRpcStatus('error');
    }
  };

  // Handle wallet connection
  const handleConnect = async () => {
    if (!privateKey.trim()) {
      setError('Please enter a private key');
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      console.log('🔗 Connecting wallet to Helius Devnet...');
      const success = await connectWallet('private-key', privateKey.trim());
      if (success) {
        setPrivateKey(''); // Clear private key for security
        if (onWalletConnect) {
          onWalletConnect('private-key', privateKey.trim());
        }
        console.log('✅ Wallet connected to Helius Devnet successfully');
      } else {
        setError('Failed to connect wallet to Helius Devnet');
      }
    } catch (err) {
      setError(err.message || 'Connection to Helius Devnet failed');
    } finally {
      setIsConnecting(false);
    }
  };

  // Handle wallet disconnect
  const handleDisconnect = () => {
    console.log('🔌 Disconnecting wallet from Helius Devnet...');
    disconnectWallet();
    if (onWalletDisconnect) {
      onWalletDisconnect();
    }
  };

  // Handle balance refresh using Helius
  const handleRefresh = async () => {
    console.log('🔄 Refreshing balance using Helius Devnet...');
    await refreshWalletData();
    if (onRefreshBalance) {
      onRefreshBalance();
    }
  };

  // Check RPC health on mount
  useEffect(() => {
    checkRpcHealth();
  }, []);

  const getConnectionStatus = () => {
    if (isConnecting) return { status: 'connecting', color: 'yellow', icon: Loader2 };
    if (walletState.isConnected && walletState.publicKey) return { status: 'connected', color: 'green', icon: CheckCircle };
    return { status: 'disconnected', color: 'red', icon: AlertCircle };
  };

  const connectionStatus = getConnectionStatus();
  const StatusIcon = connectionStatus.icon;

  if (!showDetails) {
    // Simple wallet button for header
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <Button 
          onClick={walletState.isConnected ? handleDisconnect : () => {}}
          className={walletState.isConnected ? "!bg-green-600 hover:!bg-green-700" : "!bg-blue-600 hover:!bg-blue-700"}
        >
          <Wallet className="w-4 h-4 mr-2" />
          {walletState.isConnected ? getShortAddress() : 'Connect Wallet'}
        </Button>
        {walletState.isConnected && (
          <Badge variant="outline" className="text-green-600 border-green-600">
            <CheckCircle className="w-3 h-3 mr-1" />
            Devnet
          </Badge>
        )}
      </div>
    );
  }

  // Detailed wallet info card
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" />
          Wallet Connection (Helius Devnet)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Connection Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Status:</span>
          <Badge 
            variant="outline" 
            className={`
              ${connectionStatus.color === 'green' ? 'text-green-600 border-green-600' : ''}
              ${connectionStatus.color === 'yellow' ? 'text-yellow-600 border-yellow-600' : ''}
              ${connectionStatus.color === 'red' ? 'text-red-600 border-red-600' : ''}
            `}
          >
            <StatusIcon className="w-3 h-3 mr-1" />
            {connectionStatus.status.charAt(0).toUpperCase() + connectionStatus.status.slice(1)}
          </Badge>
        </div>

        {/* Helius Devnet RPC Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Helius Devnet RPC:</span>
          <Badge 
            variant="outline" 
            className={`
              ${rpcStatus === 'healthy' ? 'text-green-600 border-green-600' : ''}
              ${rpcStatus === 'checking' ? 'text-yellow-600 border-yellow-600' : ''}
              ${rpcStatus === 'error' ? 'text-red-600 border-red-600' : ''}
            `}
          >
            {rpcStatus === 'checking' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {rpcStatus === 'healthy' && <CheckCircle className="w-3 h-3 mr-1" />}
            {rpcStatus === 'error' && <AlertCircle className="w-3 h-3 mr-1" />}
            {rpcStatus.charAt(0).toUpperCase() + rpcStatus.slice(1)}
          </Badge>
        </div>

        {/* Network Badge */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Network:</span>
          <Badge variant="outline" className="text-blue-600 border-blue-600">
            Solana Devnet
          </Badge>
        </div>

        {/* Wallet Address */}
        {walletState.isConnected && walletState.publicKey && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Address:</span>
            <div className="text-xs font-mono bg-gray-100 p-2 rounded break-all">
              {walletState.publicKey}
            </div>
          </div>
        )}

        {/* Balance */}
        {walletState.isConnected && (
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Balance:</span>
            <div className="text-right">
              {walletData.isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : walletData.error ? (
                <span className="text-red-500 text-sm">{walletData.error}</span>
              ) : (
                <span className="font-mono">{walletState.balance.toFixed(4)} SOL (Devnet)</span>
              )}
            </div>
          </div>
        )}

        {/* Connection Form */}
        {!walletState.isConnected ? (
          <div className="space-y-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <strong>Devnet Mode:</strong> Using Helius Devnet RPC for testing. No real funds required.
              </AlertDescription>
            </Alert>
            
            <div className="space-y-2">
              <label className="text-sm font-medium">Private Key (Base58) - Devnet</label>
              <Input
                type="password"
                placeholder="Enter your Solana devnet private key..."
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                disabled={isConnecting}
              />
            </div>
            
            <Button 
              onClick={handleConnect}
              disabled={isConnecting || !privateKey.trim()}
              className="w-full"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Connecting to Devnet...
                </>
              ) : (
                <>
                  <Wallet className="w-4 h-4 mr-2" />
                  Connect to Helius Devnet
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              onClick={handleRefresh}
              disabled={walletData.isLoading}
              variant="outline"
              size="sm"
            >
              {walletData.isLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Refresh
            </Button>
            
            <Button
              onClick={handleDisconnect}
              variant="outline"
              size="sm"
            >
              Disconnect
            </Button>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default WalletConnection;