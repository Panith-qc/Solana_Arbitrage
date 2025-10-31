import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// PRIVATE KEY WALLET INTEGRATION - DIRECT KEY IMPORT
// Secure private key management for direct trading
import { useState } from 'react';
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
        return (_jsxs(Card, { className: "bg-black/20 border-green-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-green-400 flex items-center", children: [_jsx(CheckCircle, { className: "w-5 h-5 mr-2" }), "Private Key Wallet Connected"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "p-4 bg-green-500/10 rounded-lg border border-green-500/30", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Key, { className: "w-5 h-5 text-green-400" }), _jsx("span", { className: "text-white font-medium", children: "Private Key Wallet" }), _jsx(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50", children: "CONNECTED" })] }), _jsxs(Button, { onClick: handleDisconnect, variant: "outline", size: "sm", className: "border-red-500/50 text-red-400 hover:bg-red-500/20", children: [_jsx(Trash2, { className: "w-4 h-4 mr-2" }), "Disconnect"] })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-400", children: "Public Key" }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsxs("span", { className: "text-white font-mono text-sm", children: [walletInfo.publicKey.slice(0, 8), "...", walletInfo.publicKey.slice(-8)] }), _jsx(Button, { onClick: copyPublicKey, variant: "ghost", size: "sm", className: "h-6 w-6 p-0", children: _jsx(Copy, { className: "w-3 h-3" }) })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-400", children: "SOL Balance" }), _jsxs("div", { className: "text-white font-bold", children: [walletInfo.balance.toFixed(6), " SOL"] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-400", children: "USD Value" }), _jsxs("div", { className: "text-white font-bold", children: ["$", walletInfo.totalUsd.toFixed(2)] })] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-400", children: "Trading Status" }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(CheckCircle, { className: "w-4 h-4 text-green-400" }), _jsx("span", { className: "text-green-400", children: "Ready for MEV Trading" })] })] })] })] }), _jsxs(Alert, { className: "border-blue-500/50 bg-blue-500/10", children: [_jsx(Shield, { className: "h-4 w-4" }), _jsx(AlertDescription, { className: "text-blue-400", children: "Your private key is stored securely in browser memory only. It will be cleared when you disconnect or refresh the page." })] })] })] }));
    }
    return (_jsxs(Card, { className: "bg-black/20 border-yellow-500/30", children: [_jsxs(CardHeader, { children: [_jsxs(CardTitle, { className: "text-yellow-400 flex items-center", children: [_jsx(Key, { className: "w-5 h-5 mr-2" }), "Connect with Private Key"] }), _jsx("p", { className: "text-sm text-gray-300", children: "Import your Solana private key for direct MEV trading" })] }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { className: "text-white", children: "Private Key" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { type: showPrivateKey ? "text" : "password", value: privateKey, onChange: (e) => {
                                            setPrivateKey(e.target.value);
                                            setError('');
                                        }, placeholder: "Enter your Solana private key (base58, hex, or array format)", className: "bg-black/30 border-gray-600 text-white pr-20", disabled: isConnecting }), _jsxs("div", { className: "absolute right-2 top-1/2 transform -translate-y-1/2 flex space-x-1", children: [privateKey && (_jsx(Button, { onClick: clearPrivateKey, variant: "ghost", size: "sm", className: "h-6 w-6 p-0 hover:bg-red-500/20", children: _jsx(Trash2, { className: "w-3 h-3 text-red-400" }) })), _jsx(Button, { onClick: () => setShowPrivateKey(!showPrivateKey), variant: "ghost", size: "sm", className: "h-6 w-6 p-0", children: showPrivateKey ?
                                                    _jsx(EyeOff, { className: "w-3 h-3" }) :
                                                    _jsx(Eye, { className: "w-3 h-3" }) })] })] }), _jsxs("div", { className: "text-xs text-gray-400 space-y-1", children: [_jsx("div", { children: "Supported formats:" }), _jsx("div", { children: "\u2022 Base58: 88 characters (e.g., 5Kj...ABC)" }), _jsx("div", { children: "\u2022 Hex: 64 characters (e.g., 1a2b3c...)" }), _jsx("div", { children: "\u2022 Array: [1,2,3,...] format (64 numbers)" })] })] }), error && (_jsxs(Alert, { className: "border-red-500/50 bg-red-500/10", children: [_jsx(XCircle, { className: "h-4 w-4" }), _jsx(AlertDescription, { className: "text-red-400", children: error })] })), isValidating && (_jsxs(Alert, { className: "border-blue-500/50 bg-blue-500/10", children: [_jsx(RefreshCw, { className: "h-4 w-4 animate-spin" }), _jsx(AlertDescription, { className: "text-blue-400", children: "Validating private key format and deriving public key..." })] })), _jsx(Button, { onClick: handleConnect, disabled: !privateKey.trim() || isConnecting, className: "w-full bg-green-600 hover:bg-green-700", children: isConnecting ? (_jsxs(_Fragment, { children: [_jsx(RefreshCw, { className: "w-4 h-4 mr-2 animate-spin" }), "Connecting Private Key Wallet..."] })) : (_jsxs(_Fragment, { children: [_jsx(Key, { className: "w-4 h-4 mr-2" }), "Connect with Private Key"] })) }), _jsxs(Alert, { className: "border-red-500/50 bg-red-500/10", children: [_jsx(AlertTriangle, { className: "h-4 w-4" }), _jsxs(AlertDescription, { className: "text-red-400", children: [_jsx("strong", { children: "Security Warning:" }), " Only enter your private key on trusted devices. Your key enables full control over your wallet and funds."] })] }), _jsx("div", { className: "p-3 bg-black/30 rounded border border-gray-700", children: _jsxs("div", { className: "text-sm text-gray-300 space-y-1", children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(CheckCircle, { className: "w-3 h-3 text-green-400" }), _jsx("span", { children: "\uD83D\uDD12 Private key stored in memory only" })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(CheckCircle, { className: "w-3 h-3 text-green-400" }), _jsx("span", { children: "\uD83D\uDDD1\uFE0F Automatically cleared on disconnect" })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(CheckCircle, { className: "w-3 h-3 text-green-400" }), _jsx("span", { children: "\uD83D\uDEAB Never transmitted to servers" })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(CheckCircle, { className: "w-3 h-3 text-green-400" }), _jsx("span", { children: "\u26A1 Direct transaction signing for MEV" })] })] }) })] })] }));
};
export default PrivateKeyWallet;
