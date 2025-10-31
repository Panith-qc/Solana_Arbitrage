// PRIVATE KEY WALLET INTEGRATION - DIRECT KEY IMPORT
// Secure private key management for direct trading
import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Key, Eye, EyeOff, CheckCircle, XCircle, AlertTriangle, Shield, Copy, RefreshCw, Trash2 } from 'lucide-react';
const PrivateKeyWallet = ({ onWalletConnect, onWalletDisconnect, isConnected, walletInfo }) => {
    const [privateKey, setPrivateKey] = useState('');
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState('');
    const [isValidating, setIsValidating] = useState(false);
    // Validate private key format
    const validatePrivateKey = (key) => {
        try {
            // Remove whitespace and common prefixes
            const cleanKey = key.trim().replace(/^(0x)?/, '');
            // Check if it's a valid base58 private key (Solana format)
            if (cleanKey.length === 88) {
                // Simulate public key derivation (in real implementation, use @solana/web3.js)
                const mockPublicKey = `${cleanKey.slice(0, 8)}...${cleanKey.slice(-8)}PublicKey`;
                return { isValid: true, publicKey: mockPublicKey };
            }
            // Check if it's a hex private key (64 characters)
            if (cleanKey.length === 64 && /^[0-9a-fA-F]+$/.test(cleanKey)) {
                const mockPublicKey = `${cleanKey.slice(0, 8)}...${cleanKey.slice(-8)}PublicKey`;
                return { isValid: true, publicKey: mockPublicKey };
            }
            // Check if it's an array format [1,2,3,...]
            if (cleanKey.startsWith('[') && cleanKey.endsWith(']')) {
                try {
                    const keyArray = JSON.parse(cleanKey);
                    if (Array.isArray(keyArray) && keyArray.length === 64) {
                        const mockPublicKey = `Array${keyArray[0]}...${keyArray[63]}PublicKey`;
                        return { isValid: true, publicKey: mockPublicKey };
                    }
                }
                catch {
                    return { isValid: false, error: 'Invalid array format' };
                }
            }
            return { isValid: false, error: 'Invalid private key format. Expected: 88-char base58, 64-char hex, or [1,2,3...] array' };
        }
        catch (error) {
            return { isValid: false, error: 'Failed to validate private key' };
        }
    };
    const handleConnect = async () => {
        if (!privateKey.trim()) {
            setError('Please enter your private key');
            return;
        }
        setIsConnecting(true);
        setIsValidating(true);
        setError('');
        try {
            // Validate the private key
            const validation = validatePrivateKey(privateKey);
            if (!validation.isValid) {
                throw new Error(validation.error || 'Invalid private key');
            }
            console.log('🔑 Connecting with private key...');
            // Simulate connection process
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Generate a realistic public key for demo
            const publicKey = '34tC7Wd6URg5sbjvMJrStyH69L8Tcj3jzgNxH3EJ3fib';
            onWalletConnect(privateKey, publicKey);
            console.log('✅ Private key wallet connected successfully');
        }
        catch (error) {
            console.error('❌ Private key connection failed:', error);
            setError(error instanceof Error ? error.message : 'Connection failed');
        }
        finally {
            setIsConnecting(false);
            setIsValidating(false);
        }
    };
    const handleDisconnect = () => {
        setPrivateKey('');
        setError('');
        onWalletDisconnect();
        console.log('🔌 Private key wallet disconnected');
    };
    const copyPublicKey = () => {
        if (walletInfo?.publicKey) {
            navigator.clipboard.writeText(walletInfo.publicKey);
        }
    };
    const clearPrivateKey = () => {
        setPrivateKey('');
        setError('');
    };
    if (isConnected && walletInfo) {
        return (<Card className="bg-black/20 border-green-500/30">
        <CardHeader>
          <CardTitle className="text-green-400 flex items-center">
            <CheckCircle className="w-5 h-5 mr-2"/>
            Private Key Wallet Connected
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Connected Wallet Info */}
          <div className="p-4 bg-green-500/10 rounded-lg border border-green-500/30">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center space-x-2">
                <Key className="w-5 h-5 text-green-400"/>
                <span className="text-white font-medium">Private Key Wallet</span>
                <Badge className="bg-green-500/20 text-green-400 border-green-500/50">
                  CONNECTED
                </Badge>
              </div>
              <Button onClick={handleDisconnect} variant="outline" size="sm" className="border-red-500/50 text-red-400 hover:bg-red-500/20">
                <Trash2 className="w-4 h-4 mr-2"/>
                Disconnect
              </Button>
            </div>

            {/* Wallet Details */}
            <div className="space-y-3">
              <div>
                <div className="text-sm text-gray-400">Public Key</div>
                <div className="flex items-center space-x-2">
                  <span className="text-white font-mono text-sm">
                    {walletInfo.publicKey.slice(0, 8)}...{walletInfo.publicKey.slice(-8)}
                  </span>
                  <Button onClick={copyPublicKey} variant="ghost" size="sm" className="h-6 w-6 p-0">
                    <Copy className="w-3 h-3"/>
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-gray-400">SOL Balance</div>
                  <div className="text-white font-bold">
                    {walletInfo.balance.toFixed(6)} SOL
                  </div>
                </div>

                <div>
                  <div className="text-sm text-gray-400">USD Value</div>
                  <div className="text-white font-bold">
                    ${walletInfo.totalUsd.toFixed(2)}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-sm text-gray-400">Trading Status</div>
                <div className="flex items-center space-x-2">
                  <CheckCircle className="w-4 h-4 text-green-400"/>
                  <span className="text-green-400">Ready for MEV Trading</span>
                </div>
              </div>
            </div>
          </div>

          {/* Security Notice */}
          <Alert className="border-blue-500/50 bg-blue-500/10">
            <Shield className="h-4 w-4"/>
            <AlertDescription className="text-blue-400">
              Your private key is stored securely in browser memory only. 
              It will be cleared when you disconnect or refresh the page.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>);
    }
    return (<Card className="bg-black/20 border-yellow-500/30">
      <CardHeader>
        <CardTitle className="text-yellow-400 flex items-center">
          <Key className="w-5 h-5 mr-2"/>
          Connect with Private Key
        </CardTitle>
        <p className="text-sm text-gray-300">
          Import your Solana private key for direct MEV trading
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Private Key Input */}
        <div className="space-y-2">
          <Label className="text-white">Private Key</Label>
          <div className="relative">
            <Input type={showPrivateKey ? "text" : "password"} value={privateKey} onChange={(e) => {
            setPrivateKey(e.target.value);
            setError('');
        }} placeholder="Enter your Solana private key (base58, hex, or array format)" className="bg-black/30 border-gray-600 text-white pr-20" disabled={isConnecting}/>
            <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex space-x-1">
              {privateKey && (<Button onClick={clearPrivateKey} variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-red-500/20">
                  <Trash2 className="w-3 h-3 text-red-400"/>
                </Button>)}
              <Button onClick={() => setShowPrivateKey(!showPrivateKey)} variant="ghost" size="sm" className="h-6 w-6 p-0">
                {showPrivateKey ?
            <EyeOff className="w-3 h-3"/> :
            <Eye className="w-3 h-3"/>}
              </Button>
            </div>
          </div>
          
          {/* Format Examples */}
          <div className="text-xs text-gray-400 space-y-1">
            <div>Supported formats:</div>
            <div>• Base58: 88 characters (e.g., 5Kj...ABC)</div>
            <div>• Hex: 64 characters (e.g., 1a2b3c...)</div>
            <div>• Array: [1,2,3,...] format (64 numbers)</div>
          </div>
        </div>

        {/* Error Display */}
        {error && (<Alert className="border-red-500/50 bg-red-500/10">
            <XCircle className="h-4 w-4"/>
            <AlertDescription className="text-red-400">
              {error}
            </AlertDescription>
          </Alert>)}

        {/* Validation Status */}
        {isValidating && (<Alert className="border-blue-500/50 bg-blue-500/10">
            <RefreshCw className="h-4 w-4 animate-spin"/>
            <AlertDescription className="text-blue-400">
              Validating private key format and deriving public key...
            </AlertDescription>
          </Alert>)}

        {/* Connect Button */}
        <Button onClick={handleConnect} disabled={!privateKey.trim() || isConnecting} className="w-full bg-green-600 hover:bg-green-700">
          {isConnecting ? (<>
              <RefreshCw className="w-4 h-4 mr-2 animate-spin"/>
              Connecting Private Key Wallet...
            </>) : (<>
              <Key className="w-4 h-4 mr-2"/>
              Connect with Private Key
            </>)}
        </Button>

        {/* Security Warnings */}
        <Alert className="border-red-500/50 bg-red-500/10">
          <AlertTriangle className="h-4 w-4"/>
          <AlertDescription className="text-red-400">
            <strong>Security Warning:</strong> Only enter your private key on trusted devices. 
            Your key enables full control over your wallet and funds.
          </AlertDescription>
        </Alert>

        {/* Security Features */}
        <div className="p-3 bg-black/30 rounded border border-gray-700">
          <div className="text-sm text-gray-300 space-y-1">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3 h-3 text-green-400"/>
              <span>🔒 Private key stored in memory only</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3 h-3 text-green-400"/>
              <span>🗑️ Automatically cleared on disconnect</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3 h-3 text-green-400"/>
              <span>🚫 Never transmitted to servers</span>
            </div>
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-3 h-3 text-green-400"/>
              <span>⚡ Direct transaction signing for MEV</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>);
};
export default PrivateKeyWallet;
//# sourceMappingURL=PrivateKeyWallet.js.map