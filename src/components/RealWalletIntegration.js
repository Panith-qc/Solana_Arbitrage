import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Wallet, Key, AlertTriangle, CheckCircle, RefreshCw, Shield, DollarSign } from 'lucide-react';
const RealWalletIntegration = ({ walletState, onWalletConnect, onWalletDisconnect, onRefreshBalance }) => {
    const [privateKey, setPrivateKey] = useState('');
    const [isConnecting, setIsConnecting] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState('');
    const handleConnect = async () => {
        if (!privateKey.trim()) {
            setError('Please enter your private key');
            return;
        }
        setIsConnecting(true);
        setError('');
        try {
            const success = await onWalletConnect(privateKey.trim());
            if (success) {
                setPrivateKey(''); // Clear private key from UI
            }
            else {
                setError('Failed to connect wallet. Please check your private key.');
            }
        }
        catch (error) {
            setError('Connection failed. Please try again.');
        }
        finally {
            setIsConnecting(false);
        }
    };
    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            await onRefreshBalance();
        }
        catch (error) {
            console.error('Refresh failed:', error);
        }
        finally {
            setIsRefreshing(false);
        }
    };
    const handleDisconnect = () => {
        onWalletDisconnect();
        setPrivateKey('');
        setError('');
    };
    if (walletState.isConnected) {
        return (<Card className="bg-black/20 border-green-500/30">
        <CardHeader>
          <CardTitle className="text-green-400 flex items-center">
            <CheckCircle className="w-5 h-5 mr-2"/>
            Wallet Connected - REAL TRADING ACTIVE
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-medium text-green-800">
                  {walletState.publicKey?.slice(0, 8)}...{walletState.publicKey?.slice(-8)}
                </div>
                <div className="text-sm text-green-600">Solana Mainnet</div>
              </div>
              <div className="flex items-center space-x-2">
                <Badge className="bg-green-500/20 text-green-700 border-green-500/50">
                  <Shield className="w-3 h-3 mr-1"/>
                  LIVE
                </Badge>
                <Badge className="bg-blue-500/20 text-blue-700 border-blue-500/50">
                  MAINNET
                </Badge>
              </div>
            </div>
            
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <DollarSign className="w-4 h-4 text-green-600"/>
                <span className="font-bold text-green-800">
                  {walletState.balance.toFixed(4)} SOL
                </span>
                <span className="text-sm text-green-600">
                  (${(walletState.balance * 222.12).toFixed(2)})
                </span>
              </div>
              
              <div className="flex space-x-2">
                <Button onClick={handleRefresh} disabled={isRefreshing} size="sm" variant="outline" className="border-green-500/50 text-green-600 hover:bg-green-500/20">
                  <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? 'animate-spin' : ''}`}/>
                  Refresh
                </Button>
                
                <Button onClick={handleDisconnect} size="sm" variant="destructive">
                  Disconnect
                </Button>
              </div>
            </div>
          </div>

          <Alert className="border-green-500/50 bg-green-500/10">
            <CheckCircle className="h-4 w-4"/>
            <AlertDescription className="text-green-700">
              <strong>Ready for Real Trading:</strong> Your wallet is connected to Solana mainnet. 
              All trades will use real SOL and execute actual transactions.
            </AlertDescription>
          </Alert>

          {walletState.balance < 0.01 && (<Alert className="border-red-500/50 bg-red-500/10">
              <AlertTriangle className="h-4 w-4"/>
              <AlertDescription className="text-red-700">
                <strong>Low Balance Warning:</strong> You need at least 0.01 SOL to execute MEV trades. 
                Please add more SOL to your wallet.
              </AlertDescription>
            </Alert>)}
        </CardContent>
      </Card>);
    }
    return (<Card className="bg-black/20 border-blue-500/30">
      <CardHeader>
        <CardTitle className="text-blue-400 flex items-center">
          <Wallet className="w-5 h-5 mr-2"/>
          Connect Real Solana Wallet
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert className="border-yellow-500/50 bg-yellow-500/10">
          <AlertTriangle className="h-4 w-4"/>
          <AlertDescription className="text-yellow-700">
            <strong>Real Trading Warning:</strong> This will connect to Solana mainnet for actual trading. 
            Only use funds you can afford to lose. MEV trading involves risks.
          </AlertDescription>
        </Alert>

        <div className="space-y-3">
          <Label htmlFor="privateKey" className="text-white">
            Solana Private Key (Base58 or Array Format)
          </Label>
          <Textarea id="privateKey" placeholder="Enter your Solana private key (e.g., [123,45,67,...] or base58 string)" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} className="bg-black/30 border-gray-600 text-white min-h-[100px]"/>
          <div className="text-xs text-gray-400">
            Your private key is used locally and never sent to any server.
          </div>
        </div>

        {error && (<Alert className="border-red-500/50 bg-red-500/10">
            <AlertTriangle className="h-4 w-4"/>
            <AlertDescription className="text-red-400">
              {error}
            </AlertDescription>
          </Alert>)}

        <Button onClick={handleConnect} disabled={isConnecting || !privateKey.trim()} className="w-full bg-blue-600 hover:bg-blue-700 text-white">
          <Key className="w-4 h-4 mr-2"/>
          {isConnecting ? 'Connecting to Mainnet...' : 'Connect Real Wallet'}
        </Button>

        <div className="text-xs text-gray-400 space-y-1">
          <p>• This connects to Solana mainnet for real trading</p>
          <p>• Minimum 0.01 SOL required for MEV trading</p>
          <p>• All transactions will cost real SOL in fees</p>
          <p>• Private key is stored locally and encrypted</p>
        </div>
      </CardContent>
    </Card>);
};
export default RealWalletIntegration;
//# sourceMappingURL=RealWalletIntegration.js.map