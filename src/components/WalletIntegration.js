import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Wallet, RefreshCw, TrendingUp, DollarSign, Clock } from 'lucide-react';
import { productionWalletManager } from '@/services/productionWalletManager';
const WalletIntegration = () => {
    const [walletState, setWalletState] = useState({
        isConnected: false,
        publicKey: null,
        walletType: null
    });
    const [balanceInfo, setBalanceInfo] = useState({
        sol: 0,
        usdc: 0,
        usdt: 0,
        totalUsd: 0
    });
    const [performanceMetrics, setPerformanceMetrics] = useState({
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
    const [connectionError, setConnectionError] = useState(null);
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
        }
        catch (error) {
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
        }
        catch (error) {
            console.error('❌ Wallet connection failed:', error);
            setConnectionError(error instanceof Error ? error.message : 'Failed to connect wallet');
        }
        finally {
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
        }
        catch (error) {
            console.error('❌ Balance refresh failed:', error);
            setConnectionError(error instanceof Error ? error.message : 'Failed to refresh balance');
        }
        finally {
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
        }
        catch (error) {
            console.error('❌ Disconnect failed:', error);
            setConnectionError(error instanceof Error ? error.message : 'Failed to disconnect wallet');
        }
    };
    // Format public key for display
    const formatPublicKey = (key) => {
        if (!key)
            return 'Not connected';
        return `${key.slice(0, 4)}...${key.slice(-4)}`;
    };
    // Format balance with safe number handling
    const formatBalance = (value) => {
        if (typeof value !== 'number' || isNaN(value))
            return '0.00';
        return value.toFixed(6);
    };
    // Format USD with safe number handling
    const formatUsd = (value) => {
        if (typeof value !== 'number' || isNaN(value))
            return '0.00';
        return value.toFixed(2);
    };
    // Format percentage with safe number handling
    const formatPercentage = (value) => {
        if (typeof value !== 'number' || isNaN(value))
            return '0.0';
        return value.toFixed(1);
    };
    // Update wallet state on component mount
    useEffect(() => {
        updateWalletState();
        // Set up periodic updates
        const interval = setInterval(updateWalletState, 5000);
        return () => clearInterval(interval);
    }, []);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2", children: [_jsx(Wallet, { className: "h-5 w-5" }), "Wallet Connection"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [!walletState.isConnected ? (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx("label", { className: "text-sm font-medium", children: "Private Key (Base58)" }), _jsx(Input, { type: "password", placeholder: "Enter your Solana private key...", value: privateKey, onChange: (e) => setPrivateKey(e.target.value), disabled: isConnecting })] }), _jsx(Button, { onClick: connectWallet, disabled: isConnecting || !privateKey.trim(), className: "w-full", children: isConnecting ? (_jsxs(_Fragment, { children: [_jsx(RefreshCw, { className: "mr-2 h-4 w-4 animate-spin" }), "Connecting..."] })) : (_jsxs(_Fragment, { children: [_jsx(Wallet, { className: "mr-2 h-4 w-4" }), "Connect Wallet"] })) })] })) : (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Connected Wallet" }), _jsx("p", { className: "font-mono text-sm", children: formatPublicKey(walletState.publicKey) })] }), _jsx(Badge, { variant: "outline", className: "bg-green-50 text-green-700 border-green-200", children: "Connected" })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: refreshBalance, disabled: isRefreshing, variant: "outline", size: "sm", children: isRefreshing ? (_jsxs(_Fragment, { children: [_jsx(RefreshCw, { className: "mr-2 h-4 w-4 animate-spin" }), "Refreshing..."] })) : (_jsxs(_Fragment, { children: [_jsx(RefreshCw, { className: "mr-2 h-4 w-4" }), "Refresh"] })) }), _jsx(Button, { onClick: disconnectWallet, variant: "outline", size: "sm", children: "Disconnect" })] })] })), connectionError && (_jsx(Alert, { variant: "destructive", children: _jsx(AlertDescription, { children: connectionError }) }))] })] }), walletState.isConnected && (_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2", children: [_jsx(DollarSign, { className: "h-5 w-5" }), "Wallet Balance"] }) }), _jsx(CardContent, { children: _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4", children: [_jsxs("div", { className: "text-center p-4 bg-blue-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "SOL Balance" }), _jsx("p", { className: "text-2xl font-bold text-blue-600", children: formatBalance(balanceInfo.sol) }), _jsx("p", { className: "text-xs text-muted-foreground", children: "SOL" })] }), _jsxs("div", { className: "text-center p-4 bg-green-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "USDC Balance" }), _jsx("p", { className: "text-2xl font-bold text-green-600", children: formatUsd(balanceInfo.usdc) }), _jsx("p", { className: "text-xs text-muted-foreground", children: "USDC" })] }), _jsxs("div", { className: "text-center p-4 bg-purple-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "USDT Balance" }), _jsx("p", { className: "text-2xl font-bold text-purple-600", children: formatUsd(balanceInfo.usdt) }), _jsx("p", { className: "text-xs text-muted-foreground", children: "USDT" })] }), _jsxs("div", { className: "text-center p-4 bg-orange-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Total USD Value" }), _jsxs("p", { className: "text-2xl font-bold text-orange-600", children: ["$", formatUsd(balanceInfo.totalUsd)] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "USD" })] })] }) })] })), walletState.isConnected && (_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2", children: [_jsx(TrendingUp, { className: "h-5 w-5" }), "Trading Performance"] }) }), _jsxs(CardContent, { children: [_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4", children: [_jsxs("div", { className: "text-center p-4 bg-slate-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Total Trades" }), _jsx("p", { className: "text-2xl font-bold", children: performanceMetrics.totalTrades || 0 })] }), _jsxs("div", { className: "text-center p-4 bg-green-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Successful Trades" }), _jsx("p", { className: "text-2xl font-bold text-green-600", children: performanceMetrics.successfulTrades || 0 })] }), _jsxs("div", { className: "text-center p-4 bg-blue-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Win Rate" }), _jsxs("p", { className: "text-2xl font-bold text-blue-600", children: [formatPercentage(performanceMetrics.winRate), "%"] })] }), _jsxs("div", { className: "text-center p-4 bg-purple-50 rounded-lg", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Total Profit" }), _jsxs("p", { className: "text-2xl font-bold text-purple-600", children: ["$", formatUsd(performanceMetrics.totalProfit)] })] })] }), performanceMetrics.lastTradeTime && (_jsx("div", { className: "mt-4 pt-4 border-t", children: _jsxs("div", { className: "flex items-center gap-2 text-sm text-muted-foreground", children: [_jsx(Clock, { className: "h-4 w-4" }), "Last Trade: ", new Date(performanceMetrics.lastTradeTime).toLocaleString()] }) }))] })] }))] }));
};
export default WalletIntegration;
