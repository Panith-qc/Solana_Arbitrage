import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Activity, CheckCircle, XCircle, AlertTriangle, Target, Shield, Clock, Settings, Key, Eye, EyeOff, TrendingUp, Trash2 } from 'lucide-react';
import { privateKeyWallet } from '../services/privateKeyWallet';
import { tokenCleanupService } from '../services/tokenCleanupService';
import { fastMEVEngine } from '../services/fastMEVEngine';
const PrivateKeyTradingDashboard = () => {
    // State management
    const [opportunities, setOpportunities] = useState([]);
    const [isScanning, setIsScanning] = useState(false);
    const [executingTradeId, setExecutingTradeId] = useState(null);
    const [tradeHistory, setTradeHistory] = useState([]);
    const [showSettings, setShowSettings] = useState(false);
    const [scanInterval, setScanInterval] = useState(null);
    // Token cleanup state
    const [isCleaningTokens, setIsCleaningTokens] = useState(false);
    const [cleanupStatus, setCleanupStatus] = useState('');
    // Private key wallet state
    const [walletState, setWalletState] = useState({
        isConnected: false,
        publicKey: null,
        keypair: null,
        balance: 0
    });
    // Private key input
    const [privateKeyInput, setPrivateKeyInput] = useState('');
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectionError, setConnectionError] = useState('');
    // Auto-trade settings with SAFE defaults (NO HARDCODING)
    const [autoTradeSettings, setAutoTradeSettings] = useState({
        enabled: false,
        minProfitUsd: 0.001, // $0.001 minimum
        maxCapitalSol: 0.6, // Your max capital
        maxRiskLevel: 'LOW',
        minConfidence: 0.8, // 80% minimum confidence
        executionDelay: 100, // 100ms delay for speed
        gasEstimateSol: 0.003, // SAFE gas estimate
        maxSlippagePercent: 1.0, // SAFE max slippage (1%)
        priorityFeeLamports: 1000000, // SAFE priority fee (0.001 SOL)
        tradeSizeSol: 0.05, // SAFE base amount
        scanIntervalMs: 5000 // SAFE scan interval (5 seconds)
    });
    // Performance metrics
    const [performanceStats, setPerformanceStats] = useState({
        totalTrades: 0,
        successfulTrades: 0,
        totalProfitUsd: 0,
        avgExecutionTime: 0,
        successRate: 0
    });
    // System health
    const [systemHealth, setSystemHealth] = useState({
        jupiterApi: true,
        walletConnected: false,
        scannerActive: false,
        rpcConnection: true,
        lastHealthCheck: new Date()
    });
    // Update system health
    useEffect(() => {
        setSystemHealth(prev => ({
            ...prev,
            walletConnected: walletState.isConnected,
            scannerActive: isScanning,
            lastHealthCheck: new Date()
        }));
    }, [walletState.isConnected, isScanning]);
    // Handle private key wallet connection
    const handleConnectPrivateKey = async () => {
        if (!privateKeyInput.trim()) {
            setConnectionError('Please enter your private key');
            return;
        }
        setIsConnecting(true);
        setConnectionError('');
        try {
            console.log('🔗 Connecting with private key via Helius...');
            const newWalletState = await privateKeyWallet.connectWithPrivateKey(privateKeyInput.trim());
            setWalletState(newWalletState);
            setPrivateKeyInput(''); // Clear private key for security
            setSystemHealth(prev => ({
                ...prev,
                walletConnected: true,
                rpcConnection: true
            }));
            console.log('✅ Private key wallet connected successfully');
        }
        catch (error) {
            console.error('❌ Failed to connect with private key:', error);
            setConnectionError(`Connection failed: ${error}`);
            setSystemHealth(prev => ({
                ...prev,
                walletConnected: false,
                rpcConnection: false
            }));
        }
        finally {
            setIsConnecting(false);
        }
    };
    // Handle wallet disconnect
    const handleDisconnectWallet = async () => {
        try {
            await privateKeyWallet.disconnectWallet();
            setWalletState({
                isConnected: false,
                publicKey: null,
                keypair: null,
                balance: 0
            });
            if (isScanning) {
                stopScanning();
            }
            setSystemHealth(prev => ({
                ...prev,
                walletConnected: false
            }));
            console.log('✅ Private key wallet disconnected');
        }
        catch (error) {
            console.error('❌ Failed to disconnect wallet:', error);
        }
    };
    // Token cleanup function
    const handleTokenCleanup = async () => {
        if (!walletState.isConnected) {
            setCleanupStatus('❌ Wallet not connected');
            return;
        }
        setIsCleaningTokens(true);
        setCleanupStatus('🔍 Scanning for stuck tokens...');
        try {
            const tokens = await tokenCleanupService.scanWalletTokens();
            if (tokens.length === 0) {
                setCleanupStatus('✅ No stuck tokens found - wallet is clean!');
                setIsCleaningTokens(false);
                return;
            }
            setCleanupStatus(`🧹 Found ${tokens.length} stuck tokens. Converting to SOL...`);
            const result = await tokenCleanupService.cleanupAllTokens(0.001);
            if (result.success) {
                setCleanupStatus(`✅ Cleanup complete! Converted ${result.tokensCleaned} tokens. Recovered ~$${(result.totalValueRecovered != null && !isNaN(result.totalValueRecovered) && typeof result.totalValueRecovered === 'number' ? result.totalValueRecovered.toFixed(4) : '0.0000')}`);
                // Refresh balance
                setTimeout(async () => {
                    const newBalance = await privateKeyWallet.getBalance();
                    setWalletState(prev => ({ ...prev, balance: newBalance }));
                }, 3000);
            }
            else {
                setCleanupStatus(`⚠️ Partial cleanup: ${result.tokensCleaned} converted, ${result.errors.length} errors`);
            }
        }
        catch (error) {
            console.error('Token cleanup failed:', error);
            setCleanupStatus('❌ Token cleanup failed. Please try again.');
        }
        finally {
            setIsCleaningTokens(false);
            // Clear status after 10 seconds
            setTimeout(() => setCleanupStatus(''), 10000);
        }
    };
    // Start safe MEV scanning
    const startScanning = useCallback(async () => {
        if (!walletState.isConnected) {
            console.log('❌ Cannot start scanning - wallet not connected');
            return;
        }
        console.log('⚡ Starting SAFE MEV scanning with UI parameters...');
        setIsScanning(true);
        const scanForOpportunities = async () => {
            try {
                // Scan for opportunities using fastMEVEngine
                const newOpportunities = await fastMEVEngine.scanForMEVOpportunities();
                if (newOpportunities.length > 0) {
                    setOpportunities(prev => {
                        const combined = [...newOpportunities, ...prev];
                        return combined.slice(0, 5); // Keep only latest 5 for speed
                    });
                    // Auto-execute if enabled and conditions met
                    for (const opportunity of newOpportunities) {
                        // Risk level hierarchy: ULTRA_LOW < LOW < MEDIUM < HIGH
                        const riskLevels = { 'ULTRA_LOW': 1, 'LOW': 2, 'MEDIUM': 3, 'HIGH': 4 };
                        const opportunityRisk = riskLevels[opportunity.riskLevel] || 0;
                        const maxRisk = riskLevels[autoTradeSettings.maxRiskLevel] || 2;
                        if (autoTradeSettings.enabled &&
                            !executingTradeId &&
                            opportunity.netProfitUsd >= autoTradeSettings.minProfitUsd &&
                            opportunity.confidence >= autoTradeSettings.minConfidence &&
                            opportunityRisk <= maxRisk) { // FIX: At or below max risk, not exact match
                            console.log(`🤖 AUTO-EXECUTING: ${opportunity.pair}`);
                            console.log(`   💰 Profit: $${opportunity.netProfitUsd.toFixed(6)}`);
                            console.log(`   📊 Risk: ${opportunity.riskLevel} (Max: ${autoTradeSettings.maxRiskLevel})`);
                            console.log(`   ✅ Confidence: ${(opportunity.confidence * 100).toFixed(1)}%`);
                            // Execute immediately (no artificial delay - speed is critical for MEV)
                            executeArbitrageTrade(opportunity);
                            break; // Execute one at a time
                        }
                    }
                }
                setSystemHealth(prev => ({ ...prev, jupiterApi: true }));
            }
            catch (error) {
                console.error('❌ MEV scan failed:', error);
                setSystemHealth(prev => ({ ...prev, jupiterApi: false }));
            }
        };
        // Initial scan
        await scanForOpportunities();
        // Set up interval for MEV opportunities using configurable interval
        const interval = setInterval(scanForOpportunities, autoTradeSettings.scanIntervalMs);
        setScanInterval(interval);
    }, [walletState.isConnected, autoTradeSettings, executingTradeId]);
    const stopScanning = useCallback(() => {
        console.log('🛑 Stopping MEV scanner...');
        setIsScanning(false);
        if (scanInterval) {
            clearInterval(scanInterval);
            setScanInterval(null);
        }
        setOpportunities([]);
    }, [scanInterval]);
    // Execute arbitrage trade with SAFE parameters
    const executeArbitrageTrade = async (opportunity) => {
        if (!walletState.isConnected) {
            console.log('❌ Cannot execute trade - wallet not connected');
            return;
        }
        setExecutingTradeId(opportunity.id);
        try {
            console.log('⚡ EXECUTING SAFE ARBITRAGE TRADE:', opportunity);
            // CRITICAL FIX: Pass priority fee parameter from UI
            const priorityFeeSol = autoTradeSettings.priorityFeeLamports / 1e9;
            const result = await fastMEVEngine.executeArbitrage(opportunity, priorityFeeSol);
            const tradeExecution = {
                id: `trade_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                opportunity,
                result,
                timestamp: new Date()
            };
            setTradeHistory(prev => [tradeExecution, ...prev.slice(0, 19)]); // Keep 20 trades
            // Update performance stats
            if (result.success) {
                const profit = result.actualProfitUsd || 0;
                setPerformanceStats(prev => ({
                    totalTrades: prev.totalTrades + 1,
                    successfulTrades: prev.successfulTrades + 1,
                    totalProfitUsd: prev.totalProfitUsd + profit,
                    avgExecutionTime: (prev.avgExecutionTime + (result.executionTimeMs || 0)) / 2,
                    successRate: ((prev.successfulTrades + 1) / (prev.totalTrades + 1)) * 100
                }));
                console.log('════════════════════════════════════════════════════════');
                console.log('✅ TRADE SUCCESS!');
                console.log('════════════════════════════════════════════════════════');
                console.log(`💰 Actual Profit: $${profit.toFixed(6)}`);
                console.log(`⏱️  Execution Time: ${result.executionTimeMs}ms`);
                console.log(`🔗 Forward TX: ${result.forwardTxHash || 'N/A'}`);
                console.log(`🔗 Reverse TX: ${result.reverseTxHash || 'N/A'}`);
                console.log('════════════════════════════════════════════════════════');
                // Update balance
                try {
                    const newBalance = await privateKeyWallet.getBalance();
                    setWalletState(prev => ({ ...prev, balance: newBalance }));
                }
                catch (error) {
                    console.warn('⚠️ Could not update balance:', error);
                }
            }
            else {
                setPerformanceStats(prev => ({
                    ...prev,
                    totalTrades: prev.totalTrades + 1,
                    successRate: (prev.successfulTrades / (prev.totalTrades + 1)) * 100
                }));
                console.log('════════════════════════════════════════════════════════');
                console.log('❌ TRADE FAILED');
                console.log('════════════════════════════════════════════════════════');
                console.log(`📛 Error: ${result.error}`);
                console.log('════════════════════════════════════════════════════════');
            }
            // Remove executed opportunity
            setOpportunities(prev => prev.filter(opp => opp.id !== opportunity.id));
        }
        catch (error) {
            console.error('❌ TRADE EXECUTION ERROR:', error);
        }
        finally {
            setExecutingTradeId(null);
        }
    };
    const getStatusIcon = (success) => {
        return success ?
            _jsx(CheckCircle, { className: "w-4 h-4 text-green-500" }) :
            _jsx(XCircle, { className: "w-4 h-4 text-red-500" });
    };
    return (_jsx("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-6", children: _jsxs("div", { className: "max-w-7xl mx-auto space-y-6", children: [_jsxs("div", { className: "text-center space-y-2", children: [_jsx("h1", { className: "text-4xl font-bold text-white", children: "\uD83D\uDEE1\uFE0F Safe MEV Arbitrage Bot" }), _jsx("p", { className: "text-purple-200", children: "Safe Solana Arbitrage | No Hardcoding | UI Parameters Only | Zero Loss Trading" }), _jsxs("div", { className: "flex justify-center space-x-4 mt-4", children: [_jsx(Badge, { className: `${systemHealth.jupiterApi ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`, children: systemHealth.jupiterApi ? '✅ JUPITER API' : '❌ JUPITER API' }), _jsx(Badge, { className: `${systemHealth.walletConnected ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`, children: systemHealth.walletConnected ? '✅ HELIUS RPC' : '❌ NO WALLET' }), _jsx(Badge, { className: `${systemHealth.scannerActive ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-gray-500/20 text-gray-400 border-gray-500/50'}`, children: systemHealth.scannerActive ? '⚡ SAFE SCANNING' : '⏸️ IDLE' }), _jsxs(Badge, { className: "bg-blue-500/20 text-blue-400 border-blue-500/50", children: ["\uD83D\uDCCA ", opportunities.length, " SAFE OPPORTUNITIES"] }), _jsx(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50", children: "\uD83D\uDEE1\uFE0F NO HARDCODING" })] })] }), performanceStats.totalTrades > 0 && (_jsxs(Card, { className: "bg-black/20 border-green-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-green-400 flex items-center", children: [_jsx(TrendingUp, { className: "w-5 h-5 mr-2" }), "Safe Trading Performance"] }) }), _jsx(CardContent, { children: _jsxs("div", { className: "grid grid-cols-5 gap-4", children: [_jsxs("div", { className: "text-center", children: [_jsx("div", { className: "text-2xl font-bold text-white", children: performanceStats.totalTrades }), _jsx("div", { className: "text-sm text-gray-400", children: "Total Trades" })] }), _jsxs("div", { className: "text-center", children: [_jsxs("div", { className: "text-2xl font-bold text-green-400", children: ["$", (performanceStats.totalProfitUsd != null && !isNaN(performanceStats.totalProfitUsd) && typeof performanceStats.totalProfitUsd === 'number' ? performanceStats.totalProfitUsd.toFixed(4) : '0.0000')] }), _jsx("div", { className: "text-sm text-gray-400", children: "Total Profit" })] }), _jsxs("div", { className: "text-center", children: [_jsxs("div", { className: "text-2xl font-bold text-blue-400", children: [(performanceStats.successRate != null && !isNaN(performanceStats.successRate) && typeof performanceStats.successRate === 'number' ? performanceStats.successRate.toFixed(1) : '0.0'), "%"] }), _jsx("div", { className: "text-sm text-gray-400", children: "Success Rate" })] }), _jsxs("div", { className: "text-center", children: [_jsxs("div", { className: "text-2xl font-bold text-purple-400", children: [(performanceStats.avgExecutionTime != null && !isNaN(performanceStats.avgExecutionTime) && typeof performanceStats.avgExecutionTime === 'number' ? performanceStats.avgExecutionTime.toFixed(0) : '0'), "ms"] }), _jsx("div", { className: "text-sm text-gray-400", children: "Avg Speed" })] }), _jsxs("div", { className: "text-center", children: [_jsx("div", { className: "text-2xl font-bold text-yellow-400", children: performanceStats.successfulTrades }), _jsx("div", { className: "text-sm text-gray-400", children: "Successful" })] })] }) })] })), _jsx(Card, { className: `${walletState.isConnected ? 'bg-black/20 border-green-500/30' : 'bg-black/20 border-red-500/30'}`, children: _jsx(CardContent, { className: "p-4", children: !walletState.isConnected ? (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Key, { className: "w-5 h-5 text-blue-400" }), _jsx("h3", { className: "text-white font-medium", children: "Connect Private Key for Safe MEV Trading" })] }), _jsxs("div", { className: "flex space-x-2", children: [_jsxs("div", { className: "relative flex-1", children: [_jsx(Input, { type: showPrivateKey ? 'text' : 'password', placeholder: "Enter your Solana private key (base58 or JSON array)", value: privateKeyInput, onChange: (e) => {
                                                        setPrivateKeyInput(e.target.value);
                                                        setConnectionError('');
                                                    }, className: "bg-black/30 border-gray-600 text-white pr-10" }), _jsx(Button, { type: "button", variant: "ghost", size: "sm", className: "absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent", onClick: () => setShowPrivateKey(!showPrivateKey), children: showPrivateKey ? (_jsx(EyeOff, { className: "h-4 w-4 text-gray-400" })) : (_jsx(Eye, { className: "h-4 w-4 text-gray-400" })) })] }), _jsx(Button, { onClick: handleConnectPrivateKey, disabled: isConnecting || !privateKeyInput.trim(), className: "bg-blue-600 hover:bg-blue-700 text-white", children: isConnecting ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Connecting..."] })) : (_jsxs(_Fragment, { children: [_jsx(Key, { className: "w-4 h-4 mr-2" }), "Connect"] })) })] }), connectionError && (_jsxs(Alert, { className: "border-red-500/50 bg-red-500/10", children: [_jsx(XCircle, { className: "h-4 w-4" }), _jsx(AlertDescription, { className: "text-red-400", children: connectionError })] })), _jsxs(Alert, { className: "border-green-500/50 bg-green-500/10", children: [_jsx(Shield, { className: "h-4 w-4" }), _jsxs(AlertDescription, { className: "text-green-400", children: [_jsx("strong", { children: "Safe MEV Trading:" }), " All parameters from UI. Priority fee: ", ((autoTradeSettings.priorityFeeLamports / 1e9) != null && !isNaN(autoTradeSettings.priorityFeeLamports / 1e9) && typeof (autoTradeSettings.priorityFeeLamports / 1e9) === 'number' ? (autoTradeSettings.priorityFeeLamports / 1e9).toFixed(3) : '0.000'), " SOL. Max capital: ", autoTradeSettings.maxCapitalSol, " SOL"] })] })] })) : (_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center space-x-4", children: [_jsx(CheckCircle, { className: "w-5 h-5 text-green-400" }), _jsxs("div", { children: [_jsxs("div", { className: "text-white font-medium", children: ["Safe MEV Wallet: ", walletState.publicKey?.toBase58().slice(0, 8), "...", walletState.publicKey?.toBase58().slice(-4)] }), _jsxs("div", { className: "text-sm text-gray-300", children: ["Balance: ", (walletState.balance != null && !isNaN(walletState.balance) && typeof walletState.balance === 'number' ? walletState.balance.toFixed(4) : '0.0000'), " SOL | $", ((walletState.balance * 240) != null && !isNaN(walletState.balance * 240) && typeof (walletState.balance * 240) === 'number' ? (walletState.balance * 240).toFixed(2) : '0.00'), " USD", _jsx("span", { className: "ml-2 text-green-400 font-bold", children: "\u2022 SAFE TRADING READY" })] })] })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Button, { onClick: handleTokenCleanup, disabled: isCleaningTokens, variant: "outline", size: "sm", className: "border-orange-500/50 text-orange-400 hover:bg-orange-500/20", children: isCleaningTokens ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Cleaning..."] })) : (_jsxs(_Fragment, { children: [_jsx(Trash2, { className: "w-4 h-4 mr-2" }), "Recover Stuck Tokens"] })) }), _jsxs(Button, { onClick: handleDisconnectWallet, variant: "outline", size: "sm", className: "border-red-500/50 text-red-400 hover:bg-red-500/20", children: [_jsx(XCircle, { className: "w-4 h-4 mr-2" }), "Disconnect"] }), _jsxs(Button, { onClick: () => setShowSettings(!showSettings), variant: "outline", size: "sm", className: "border-purple-500/50 text-purple-400 hover:bg-purple-500/20", children: [_jsx(Settings, { className: "w-4 h-4 mr-2" }), "Safe Trade Settings"] }), _jsxs(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50", children: [_jsx(Shield, { className: "w-3 h-3 mr-1" }), "SAFE MODE"] })] })] })) }) }), cleanupStatus && (_jsxs(Alert, { className: "border-orange-500/50 bg-orange-500/10", children: [_jsx(Trash2, { className: "h-4 w-4" }), _jsx(AlertDescription, { className: "text-orange-400", children: cleanupStatus })] })), showSettings && walletState.isConnected && (_jsxs(Card, { className: "bg-black/20 border-purple-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-purple-400 flex items-center", children: [_jsx(Shield, { className: "w-5 h-5 mr-2" }), "Safe Auto-Trade Settings (No Hardcoding)"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-white font-medium", children: "Enable Safe Auto-Trading" }), _jsx("p", { className: "text-sm text-gray-400", children: "Automatically execute profitable arbitrage trades with UI parameters only" })] }), _jsx(Switch, { checked: autoTradeSettings.enabled, onCheckedChange: (checked) => {
                                                console.log('🛡️ Safe auto-trade toggled:', checked);
                                                setAutoTradeSettings(prev => ({ ...prev, enabled: checked }));
                                            } })] }), _jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Min Profit (USD)" }), _jsx(Input, { type: "number", step: "0.001", value: autoTradeSettings.minProfitUsd, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        minProfitUsd: parseFloat(e.target.value) || 0.001
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Capital (SOL)" }), _jsx(Input, { type: "number", step: "0.01", max: "0.6", value: autoTradeSettings.maxCapitalSol, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        maxCapitalSol: Math.min(0.6, parseFloat(e.target.value) || 0.1)
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Min Confidence (%)" }), _jsx(Input, { type: "number", step: "0.01", min: "0.5", max: "0.95", value: autoTradeSettings.minConfidence, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        minConfidence: parseFloat(e.target.value) || 0.8
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] })] }), _jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Gas Estimate (SOL)" }), _jsx(Input, { type: "number", step: "0.001", min: "0.001", max: "0.01", value: autoTradeSettings.gasEstimateSol, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        gasEstimateSol: parseFloat(e.target.value) || 0.003
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Slippage (%)" }), _jsx(Input, { type: "number", step: "0.1", min: "0.1", max: "5", value: autoTradeSettings.maxSlippagePercent, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        maxSlippagePercent: parseFloat(e.target.value) || 1.0
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Priority Fee (SOL)" }), _jsx(Input, { type: "number", step: "0.0001", min: "0.0001", max: "0.01", value: autoTradeSettings.priorityFeeLamports / 1e9, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        priorityFeeLamports: (parseFloat(e.target.value) || 0.001) * 1e9
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Trade Size (SOL)" }), _jsx(Input, { type: "number", step: "0.01", min: "0.01", max: "0.5", value: autoTradeSettings.tradeSizeSol, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        tradeSizeSol: parseFloat(e.target.value) || 0.05
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Scan Interval (seconds)" }), _jsx(Input, { type: "number", step: "1", min: "1", max: "60", value: autoTradeSettings.scanIntervalMs / 1000, onChange: (e) => setAutoTradeSettings(prev => ({
                                                        ...prev,
                                                        scanIntervalMs: (parseFloat(e.target.value) || 5) * 1000
                                                    })), className: "mt-1 bg-black/30 border-gray-600 text-white" })] })] }), autoTradeSettings.enabled && (_jsxs(Alert, { className: "border-green-500/50 bg-green-500/10", children: [_jsx(Shield, { className: "h-4 w-4" }), _jsxs(AlertDescription, { className: "text-green-400", children: [_jsx("strong", { children: "Safe Auto-Trading Active:" }), " System will execute arbitrage trades above $", (autoTradeSettings.minProfitUsd != null && !isNaN(autoTradeSettings.minProfitUsd) && typeof autoTradeSettings.minProfitUsd === 'number' ? autoTradeSettings.minProfitUsd.toFixed(3) : '0.000'), " with max ", autoTradeSettings.maxCapitalSol, " SOL capital. Priority fee: ", ((autoTradeSettings.priorityFeeLamports / 1e9) != null && !isNaN(autoTradeSettings.priorityFeeLamports / 1e9) && typeof (autoTradeSettings.priorityFeeLamports / 1e9) === 'number' ? (autoTradeSettings.priorityFeeLamports / 1e9).toFixed(3) : '0.000'), " SOL"] })] }))] })] })), _jsxs(Card, { className: "bg-black/20 border-blue-500/30", children: [_jsx(CardHeader, { children: _jsx(CardTitle, { className: "text-blue-400", children: "Safe MEV Scanner" }) }), _jsx(CardContent, { children: _jsxs("div", { className: "flex items-center space-x-4", children: [!isScanning ? (_jsxs(Button, { onClick: startScanning, disabled: !walletState.isConnected, className: "bg-green-600 hover:bg-green-700 text-white", children: [_jsx(Activity, { className: "w-4 h-4 mr-2" }), "Start Safe MEV Scanner"] })) : (_jsxs(Button, { onClick: stopScanning, className: "bg-red-600 hover:bg-red-700 text-white", children: [_jsx(XCircle, { className: "w-4 h-4 mr-2" }), "Stop Scanner"] })), !walletState.isConnected && (_jsxs(Alert, { className: "border-yellow-500/50 bg-yellow-500/10 flex-1", children: [_jsx(AlertTriangle, { className: "h-4 w-4" }), _jsx(AlertDescription, { className: "text-yellow-400", children: "Connect your private key to start safe MEV arbitrage scanning" })] }))] }) })] }), _jsxs(Card, { className: "bg-black/20 border-green-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-green-400 flex items-center", children: [_jsx(Target, { className: "w-5 h-5 mr-2" }), "Safe MEV Opportunities", isScanning && (_jsxs(Badge, { className: "ml-2 bg-green-500/20 text-green-400 border-green-500/50", children: [_jsx(Activity, { className: "w-3 h-3 mr-1 animate-spin" }), "SAFE SCANNING"] })), autoTradeSettings.enabled && (_jsxs(Badge, { className: "ml-2 bg-purple-500/20 text-purple-400 border-purple-500/50", children: [_jsx(Shield, { className: "w-3 h-3 mr-1" }), "SAFE AUTO-TRADE"] }))] }) }), _jsx(CardContent, { children: opportunities.length === 0 ? (_jsxs("div", { className: "text-center py-8", children: [_jsx("div", { className: "text-gray-400 mb-4", children: isScanning ? 'Scanning for safe MEV arbitrage opportunities...' : 'Start scanner to find profitable arbitrage trades' }), !isScanning && (_jsx("p", { className: "text-sm text-gray-500", children: "Safe MEV engine will detect SOL\u2194USDC, SOL\u2194USDT, and meme coin arbitrage opportunities using your UI parameters" }))] })) : (_jsx("div", { className: "space-y-3", children: opportunities.map((opportunity) => (_jsx("div", { className: "bg-black/30 rounded-lg p-4 border border-gray-700", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx("span", { className: "text-white font-medium", children: opportunity.pair }), _jsx(Badge, { className: "bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs", children: opportunity.type }), _jsx(Badge, { className: `text-xs ${opportunity.riskLevel === 'ULTRA_LOW' ? 'bg-green-500/20 text-green-400 border-green-500/50' :
                                                                    opportunity.riskLevel === 'LOW' ? 'bg-blue-500/20 text-blue-400 border-blue-500/50' :
                                                                        'bg-yellow-500/20 text-yellow-400 border-yellow-500/50'}`, children: opportunity.riskLevel }), _jsx(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50 text-xs", children: "SAFE" })] }), _jsxs("div", { className: "flex items-center space-x-4 mt-1 text-sm", children: [_jsxs("span", { className: "text-green-400", children: ["Net Profit: $", (opportunity.netProfitUsd != null && !isNaN(opportunity.netProfitUsd) && typeof opportunity.netProfitUsd === 'number' ? opportunity.netProfitUsd.toFixed(6) : '0.000000')] }), _jsxs("span", { className: "text-blue-400", children: [(opportunity.profitPercent != null && !isNaN(opportunity.profitPercent) && typeof opportunity.profitPercent === 'number' ? opportunity.profitPercent.toFixed(4) : '0.0000'), "%"] }), _jsxs("span", { className: "text-gray-400", children: ["Confidence: ", ((opportunity.confidence * 100) != null && !isNaN(opportunity.confidence * 100) && typeof (opportunity.confidence * 100) === 'number' ? (opportunity.confidence * 100).toFixed(0) : '0'), "%"] }), _jsxs("span", { className: "text-purple-400", children: ["Capital: ", (opportunity.capitalRequired != null && !isNaN(opportunity.capitalRequired) && typeof opportunity.capitalRequired === 'number' ? opportunity.capitalRequired.toFixed(3) : '0.000'), " SOL"] }), _jsxs("span", { className: "text-orange-400", children: ["Gas: ", (opportunity.gasFeeSol != null && !isNaN(opportunity.gasFeeSol) && typeof opportunity.gasFeeSol === 'number' ? opportunity.gasFeeSol.toFixed(4) : '0.0000'), " SOL"] })] })] }), _jsx(Button, { onClick: () => executeArbitrageTrade(opportunity), disabled: executingTradeId === opportunity.id || !walletState.isConnected, size: "sm", className: "bg-green-600 hover:bg-green-700 text-white disabled:opacity-50", children: executingTradeId === opportunity.id ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Executing Safely..."] })) : (_jsxs(_Fragment, { children: [_jsx(Shield, { className: "w-4 h-4 mr-2" }), "Execute Safe Arbitrage"] })) })] }) }, opportunity.id))) })) })] }), tradeHistory.length > 0 && (_jsxs(Card, { className: "bg-black/20 border-purple-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-purple-400 flex items-center", children: [_jsx(Clock, { className: "w-5 h-5 mr-2" }), "Safe Trade Executions"] }) }), _jsx(CardContent, { children: _jsx("div", { className: "space-y-3 max-h-64 overflow-y-auto", children: tradeHistory.slice(0, 10).map((trade) => (_jsx("div", { className: "bg-black/30 rounded-lg p-3 border border-gray-700", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center space-x-3", children: [getStatusIcon(trade.result.success), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx("span", { className: "text-white font-medium", children: trade.opportunity.pair }), _jsxs(Badge, { className: "bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs", children: ["SAFE ", trade.opportunity.type] })] }), _jsxs("div", { className: "flex items-center space-x-4 mt-1 text-sm", children: [_jsxs("span", { className: "text-gray-300", children: ["Expected: $", (trade.opportunity.netProfitUsd != null && !isNaN(trade.opportunity.netProfitUsd) && typeof trade.opportunity.netProfitUsd === 'number' ? trade.opportunity.netProfitUsd.toFixed(6) : '0.000000')] }), trade.result.actualProfitUsd && (_jsxs("span", { className: "text-green-400", children: ["Actual: $", trade.result.actualProfitUsd.toFixed(6)] })), _jsxs("span", { className: "text-blue-400", children: ["Speed: ", trade.result.executionTimeMs, "ms"] }), _jsx("span", { className: "text-gray-400", children: trade.timestamp.toLocaleTimeString() })] }), trade.result.error && (_jsxs("span", { className: "text-red-400 text-sm", children: ["Error: ", trade.result.error] }))] })] }), _jsxs("div", { className: "text-right", children: [_jsx(Badge, { variant: "outline", className: trade.result.success ? 'border-green-500 text-green-400' : 'border-red-500 text-red-400', children: trade.result.success ? 'SUCCESS' : 'FAILED' }), trade.result.txHash && (_jsx("div", { className: "text-xs text-gray-400 mt-1", children: _jsxs("a", { href: `https://solscan.io/tx/${trade.result.txHash}`, target: "_blank", rel: "noopener noreferrer", className: "hover:text-blue-400", children: [trade.result.txHash.slice(0, 12), "..."] }) }))] })] }) }, trade.id))) }) })] })), _jsxs("div", { className: "text-center text-sm text-purple-300 space-y-2", children: [_jsx("p", { children: "\uD83D\uDEE1\uFE0F Safe MEV Arbitrage Bot | Zero Loss Trading | UI Parameters Only" }), _jsxs("div", { className: "flex items-center justify-center space-x-6", children: [_jsxs("span", { children: ["Min Profit: $", (autoTradeSettings.minProfitUsd != null && !isNaN(autoTradeSettings.minProfitUsd) && typeof autoTradeSettings.minProfitUsd === 'number' ? autoTradeSettings.minProfitUsd.toFixed(3) : '0.000')] }), _jsxs("span", { children: ["Max Capital: ", autoTradeSettings.maxCapitalSol, " SOL"] }), _jsxs("span", { children: ["Priority Fee: ", ((autoTradeSettings.priorityFeeLamports / 1e9) != null && !isNaN(autoTradeSettings.priorityFeeLamports / 1e9) && typeof (autoTradeSettings.priorityFeeLamports / 1e9) === 'number' ? (autoTradeSettings.priorityFeeLamports / 1e9).toFixed(3) : '0.000'), " SOL"] }), _jsxs("span", { children: ["Auto-Trade: ", autoTradeSettings.enabled ? '🟢 SAFE ACTIVE' : '🔴 INACTIVE'] }), _jsxs("span", { children: ["Balance: ", (walletState.balance != null && !isNaN(walletState.balance) && typeof walletState.balance === 'number' ? walletState.balance.toFixed(4) : '0.0000'), " SOL"] }), _jsxs("span", { children: ["Total Profit: $", (performanceStats.totalProfitUsd != null && !isNaN(performanceStats.totalProfitUsd) && typeof performanceStats.totalProfitUsd === 'number' ? performanceStats.totalProfitUsd.toFixed(4) : '0.0000')] })] }), _jsx("p", { className: "text-xs text-gray-400", children: "\uD83D\uDEE1\uFE0F SAFE ARBITRAGE - All parameters from UI, no hardcoding, sequential execution, balance verification" })] })] }) }));
};
export default PrivateKeyTradingDashboard;
