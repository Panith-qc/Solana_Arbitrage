import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Alert, AlertDescription } from './ui/alert';
import { Wallet, AlertCircle, CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import { useWallet } from '../hooks/useWallet';
import { heliusService } from '../services/heliusService';
export const WalletConnection = ({ showDetails = false, className = '', onWalletConnect, onWalletDisconnect, onRefreshBalance }) => {
    const { walletState, walletData, connectWallet, disconnectWallet, refreshWalletData, getShortAddress } = useWallet();
    const [privateKey, setPrivateKey] = useState('');
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState(null);
    const [rpcStatus, setRpcStatus] = useState('checking');
    // Check Helius Devnet RPC connection health
    const checkRpcHealth = async () => {
        try {
            setRpcStatus('checking');
            console.log('🔍 Checking Helius Devnet RPC health...');
            const testResult = await heliusService.testConnection();
            if (testResult.success) {
                setRpcStatus('healthy');
                console.log('✅ Helius Devnet RPC is healthy');
            }
            else {
                setRpcStatus('error');
                console.error('❌ Helius Devnet RPC test failed:', testResult.error);
            }
        }
        catch (error) {
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
            }
            else {
                setError('Failed to connect wallet to Helius Devnet');
            }
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Connection to Helius Devnet failed';
            setError(errorMessage);
        }
        finally {
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
        if (isConnecting)
            return { status: 'connecting', color: 'yellow', icon: Loader2 };
        if (walletState.isConnected && walletState.publicKey)
            return { status: 'connected', color: 'green', icon: CheckCircle };
        return { status: 'disconnected', color: 'red', icon: AlertCircle };
    };
    const connectionStatus = getConnectionStatus();
    const StatusIcon = connectionStatus.icon;
    if (!showDetails) {
        // Simple wallet button for header
        return (_jsxs("div", { className: `flex items-center gap-2 ${className}`, children: [_jsxs(Button, { onClick: walletState.isConnected ? handleDisconnect : () => { }, className: walletState.isConnected ? "!bg-green-600 hover:!bg-green-700" : "!bg-blue-600 hover:!bg-blue-700", children: [_jsx(Wallet, { className: "w-4 h-4 mr-2" }), walletState.isConnected ? getShortAddress() : 'Connect Wallet'] }), walletState.isConnected && (_jsxs(Badge, { variant: "outline", className: "text-green-600 border-green-600", children: [_jsx(CheckCircle, { className: "w-3 h-3 mr-1" }), "Devnet"] }))] }));
    }
    // Detailed wallet info card
    return (_jsxs(Card, { className: className, children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2", children: [_jsx(Wallet, { className: "w-5 h-5" }), "Wallet Connection (Helius Devnet)"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-sm font-medium", children: "Status:" }), _jsxs(Badge, { variant: "outline", className: `
              ${connectionStatus.color === 'green' ? 'text-green-600 border-green-600' : ''}
              ${connectionStatus.color === 'yellow' ? 'text-yellow-600 border-yellow-600' : ''}
              ${connectionStatus.color === 'red' ? 'text-red-600 border-red-600' : ''}
            `, children: [_jsx(StatusIcon, { className: "w-3 h-3 mr-1" }), connectionStatus.status.charAt(0).toUpperCase() + connectionStatus.status.slice(1)] })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-sm font-medium", children: "Helius Devnet RPC:" }), _jsxs(Badge, { variant: "outline", className: `
              ${rpcStatus === 'healthy' ? 'text-green-600 border-green-600' : ''}
              ${rpcStatus === 'checking' ? 'text-yellow-600 border-yellow-600' : ''}
              ${rpcStatus === 'error' ? 'text-red-600 border-red-600' : ''}
            `, children: [rpcStatus === 'checking' && _jsx(Loader2, { className: "w-3 h-3 mr-1 animate-spin" }), rpcStatus === 'healthy' && _jsx(CheckCircle, { className: "w-3 h-3 mr-1" }), rpcStatus === 'error' && _jsx(AlertCircle, { className: "w-3 h-3 mr-1" }), rpcStatus.charAt(0).toUpperCase() + rpcStatus.slice(1)] })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-sm font-medium", children: "Network:" }), _jsx(Badge, { variant: "outline", className: "text-blue-600 border-blue-600", children: "Solana Devnet" })] }), walletState.isConnected && walletState.publicKey && (_jsxs("div", { className: "space-y-2", children: [_jsx("span", { className: "text-sm font-medium", children: "Address:" }), _jsx("div", { className: "text-xs font-mono bg-gray-100 p-2 rounded break-all", children: walletState.publicKey })] })), walletState.isConnected && (_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-sm font-medium", children: "Balance:" }), _jsx("div", { className: "text-right", children: walletData.isLoading ? (_jsx(Loader2, { className: "w-4 h-4 animate-spin" })) : walletData.error ? (_jsx("span", { className: "text-red-500 text-sm", children: walletData.error })) : (_jsxs("span", { className: "font-mono", children: [walletState.balance.toFixed(4), " SOL (Devnet)"] })) })] })), !walletState.isConnected ? (_jsxs("div", { className: "space-y-4", children: [_jsxs(Alert, { children: [_jsx(AlertCircle, { className: "h-4 w-4" }), _jsxs(AlertDescription, { children: [_jsx("strong", { children: "Devnet Mode:" }), " Using Helius Devnet RPC for testing. No real funds required."] })] }), _jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "text-sm font-medium", children: "Private Key (Base58) - Devnet" }), _jsx(Input, { type: "password", placeholder: "Enter your Solana devnet private key...", value: privateKey, onChange: (e) => setPrivateKey(e.target.value), disabled: isConnecting })] }), _jsx(Button, { onClick: handleConnect, disabled: isConnecting || !privateKey.trim(), className: "w-full", children: isConnecting ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "w-4 h-4 mr-2 animate-spin" }), "Connecting to Devnet..."] })) : (_jsxs(_Fragment, { children: [_jsx(Wallet, { className: "w-4 h-4 mr-2" }), "Connect to Helius Devnet"] })) })] })) : (_jsxs("div", { className: "flex gap-2", children: [_jsxs(Button, { onClick: handleRefresh, disabled: walletData.isLoading, variant: "outline", size: "sm", children: [walletData.isLoading ? (_jsx(Loader2, { className: "w-4 h-4 animate-spin" })) : (_jsx(RefreshCw, { className: "w-4 h-4" })), "Refresh"] }), _jsx(Button, { onClick: handleDisconnect, variant: "outline", size: "sm", children: "Disconnect" })] })), error && (_jsxs(Alert, { variant: "destructive", children: [_jsx(AlertCircle, { className: "h-4 w-4" }), _jsx(AlertDescription, { children: error })] }))] })] }));
};
export default WalletConnection;
