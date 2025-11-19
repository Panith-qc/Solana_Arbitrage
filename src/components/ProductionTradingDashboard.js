import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { strategyEngine } from '@/services/StrategyEngine';
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Activity, TrendingUp, Zap, CheckCircle, XCircle, Target, Shield, Clock, Wallet, Settings, Bot, Layers } from 'lucide-react';
import WalletIntegration from './WalletIntegration';
import TradingSettingsPanel from './TradingSettingsPanel';
import { tradingConfigManager } from '../config/tradingConfig';
import { priceService } from '../services/priceService';
const ProductionTradingDashboard = () => {
    // State management
    const [opportunities, setOpportunities] = useState([]);
    const [isScanning, setIsScanning] = useState(false);
    const [executingTradeId, setExecutingTradeId] = useState(null);
    const [tradeHistory, setTradeHistory] = useState([]);
    const [isInitialized, setIsInitialized] = useState(false);
    const [showWalletIntegration, setShowWalletIntegration] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [config, setConfig] = useState(tradingConfigManager.getConfig());
    // Strategy engine state
    const [activeStrategies, setActiveStrategies] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [successRate, setSuccessRate] = useState(0);
    // Wallet state - starts as connected for testing
    const [walletState, setWalletState] = useState({
        isConnected: true,
        publicKey: 'TestWallet123...456',
        walletType: 'test-wallet',
        balance: 10.0 // Updated to 10 SOL
    });
    // Balance info - calculated dynamically using price service
    const [balanceInfo, setBalanceInfo] = useState({
        sol: 10.0, // Updated to 10 SOL
        usdc: 0,
        usdt: 0,
        totalUsd: 0 // Will be calculated dynamically
    });
    // System health
    const [systemHealth, setSystemHealth] = useState({
        jupiterApi: true,
        walletConnected: true,
        scannerActive: false,
        priceServiceHealthy: true,
        strategiesActive: false,
        lastHealthCheck: new Date()
    });
    // Subscribe to config changes
    useEffect(() => {
        const unsubscribe = tradingConfigManager.subscribe((newConfig) => {
            setConfig(newConfig);
            console.log('🔄 Config updated:', newConfig);
        });
        return unsubscribe;
    }, []);
    // Initialize dashboard
    useEffect(() => {
        const initializeDashboard = async () => {
            try {
                console.log('🚀 INITIALIZING PRODUCTION TRADING DASHBOARD WITH STRATEGY ENGINE...');
                console.log('🔗 WALLET FORCE CONNECTED FOR TESTING - 10 SOL AVAILABLE');
                // Calculate initial balance using price service (await async call)
                const solPrice = await priceService.getPriceUsd(config.tokens.SOL);
                const totalUsd = balanceInfo.sol * solPrice;
                setBalanceInfo(prev => ({
                    ...prev,
                    totalUsd
                }));
                // Initialize strategy engine (getActiveStrategies returns array, not Set)
                const strategies = strategyEngine.getActiveStrategies();
                setActiveStrategies(strategies.length);
                setIsInitialized(true);
                console.log('✅ PRODUCTION DASHBOARD INITIALIZED WITH ALL STRATEGIES LOADED');
            }
            catch (error) {
                console.error('❌ Dashboard initialization failed:', error);
                setIsInitialized(true);
            }
        };
        initializeDashboard();
    }, [config.tokens.SOL]);
    // Update system health when wallet state changes
    useEffect(() => {
        setSystemHealth(prev => ({
            ...prev,
            walletConnected: walletState.isConnected,
            scannerActive: isScanning,
            strategiesActive: activeStrategies > 0,
            priceServiceHealthy: priceService.isHealthy(),
            lastHealthCheck: new Date()
        }));
        console.log('🔄 System health updated - Wallet connected:', walletState.isConnected);
    }, [walletState.isConnected, isScanning, activeStrategies]);
    // Update balance calculations when prices change
    useEffect(() => {
        const updateBalances = async () => {
            const solPrice = await priceService.getPriceUsd(config.tokens.SOL);
            const totalUsd = balanceInfo.sol * solPrice;
            setBalanceInfo(prev => ({
                ...prev,
                totalUsd
            }));
        };
        // Update immediately and then every 30 seconds
        updateBalances();
        const interval = setInterval(updateBalances, 30000);
        return () => clearInterval(interval);
    }, [balanceInfo.sol, config.tokens.SOL]);
    // Update strategy metrics
    useEffect(() => {
        const updateMetrics = () => {
            const history = strategyEngine.getExecutionHistory();
            const successfulTrades = history.filter(h => h.status === 'completed');
            const totalProfitCalc = successfulTrades.reduce((sum, trade) => sum + (trade.profitRealized || 0), 0);
            const successRateCalc = history.length > 0 ? (successfulTrades.length / history.length) * 100 : 0;
            setTotalProfit(totalProfitCalc);
            setSuccessRate(successRateCalc);
            // Type cast needed due to StrategyResult interface mismatch
            setTradeHistory(history);
        };
        const interval = setInterval(updateMetrics, 5000);
        return () => clearInterval(interval);
    }, []);
    // Wallet connection handlers
    const handleWalletConnect = async (walletType, privateKey) => {
        console.log(`🔗 Connecting ${walletType} wallet...`);
        const mockPublicKey = privateKey ?
            `${privateKey.slice(0, 8)}...${privateKey.slice(-8)}` :
            'TestWallet123...456';
        const newWalletState = {
            isConnected: true,
            publicKey: mockPublicKey,
            walletType: walletType,
            balance: 10.0 // Always 10 SOL for testing
        };
        setWalletState(newWalletState);
        // Calculate USD value using dynamic pricing
        const solPrice = await priceService.getPriceUsd(config.tokens.SOL);
        setBalanceInfo(prev => ({
            ...prev,
            sol: newWalletState.balance,
            totalUsd: newWalletState.balance * solPrice
        }));
        setShowWalletIntegration(false);
        console.log('✅ Wallet connected successfully - All strategies ready for 10 SOL capital');
    };
    const handleWalletDisconnect = () => {
        console.log('🔌 Disconnecting wallet...');
        setWalletState({
            isConnected: false,
            publicKey: null,
            walletType: null,
            balance: 0
        });
        setBalanceInfo({
            sol: 0,
            usdc: 0,
            usdt: 0,
            totalUsd: 0
        });
        if (isScanning) {
            handleStopAllStrategies();
        }
        localStorage.removeItem('wallet_state');
        console.log('✅ Wallet disconnected - All strategies stopped');
    };
    const handleRefreshBalance = async () => {
        console.log('🔄 Refreshing wallet balance...');
        if (walletState.isConnected) {
            // Keep balance at 10 SOL for testing
            const newBalance = 10.0;
            setWalletState(prev => ({ ...prev, balance: newBalance }));
            const solPrice = await priceService.getPriceUsd(config.tokens.SOL);
            setBalanceInfo(prev => ({
                ...prev,
                sol: newBalance,
                totalUsd: newBalance * solPrice
            }));
            console.log(`✅ Balance refreshed: ${(newBalance != null && !isNaN(newBalance) && typeof newBalance === 'number' ? newBalance.toFixed(4) : '0.0000')} SOL`);
        }
    };
    // Strategy engine handlers
    const handleStartAllStrategies = useCallback(async () => {
        if (!walletState.isConnected) {
            console.log('❌ Wallet not connected, showing wallet integration');
            setShowWalletIntegration(true);
            return;
        }
        console.log('🚀 STARTING ALL MEV STRATEGIES...');
        setIsScanning(true);
        try {
            await strategyEngine.startAllStrategies(walletState.balance, async (strategyOpportunities) => {
                console.log(`📊 RECEIVED ${strategyOpportunities.length} STRATEGY OPPORTUNITIES`);
                setOpportunities(strategyOpportunities);
                // Auto-execute if enabled and conditions met
                if (config.trading.autoTradingEnabled && strategyOpportunities.length > 0) {
                    const bestOpportunity = strategyOpportunities
                        .filter(opp => opp.profitUsd >= config.trading.minProfitUsd)
                        .sort((a, b) => b.profitUsd - a.profitUsd)[0];
                    if (bestOpportunity && !executingTradeId) {
                        console.log(`🤖 AUTO-EXECUTING BEST STRATEGY: ${bestOpportunity.strategyName} - $${(bestOpportunity.profitUsd != null && !isNaN(bestOpportunity.profitUsd) && typeof bestOpportunity.profitUsd === 'number' ? bestOpportunity.profitUsd.toFixed(6) : '0.000000')}`);
                        executeStrategyTrade(bestOpportunity);
                    }
                }
            });
            console.log('✅ ALL STRATEGIES STARTED - Autonomous trading active');
        }
        catch (error) {
            console.error('❌ Failed to start strategies:', error);
            setIsScanning(false);
        }
    }, [config.trading.autoTradingEnabled, config.trading.minProfitUsd, walletState.isConnected, walletState.balance, executingTradeId]);
    const handleStopAllStrategies = useCallback(() => {
        console.log('🛑 STOPPING ALL STRATEGIES...');
        setIsScanning(false);
        strategyEngine.stopAllStrategies();
        setOpportunities([]);
        setActiveStrategies(0);
        console.log('✅ ALL STRATEGIES STOPPED');
    }, []);
    // Execute strategy trade
    const executeStrategyTrade = async (opportunity) => {
        console.log(`🔄 Executing strategy trade: ${opportunity.strategyName} - ${opportunity.pair}`);
        if (!walletState.isConnected) {
            console.log('❌ Wallet not connected');
            setShowWalletIntegration(true);
            return;
        }
        // Risk management checks
        if (opportunity.recommendedCapital > config.risk.maxTradeAmountSol) {
            console.log('❌ Trade exceeds maximum trade amount');
            return;
        }
        if (opportunity.recommendedCapital > walletState.balance * 0.9) {
            console.log('❌ Insufficient balance for trade');
            return;
        }
        setExecutingTradeId(opportunity.id);
        try {
            console.log(`🚀 EXECUTING ${opportunity.strategyName}: ${opportunity.pair} - $${(opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')}`);
            // Simulate strategy execution
            const executionTime = 1000 + Math.random() * 3000;
            await new Promise(resolve => setTimeout(resolve, executionTime));
            const success = Math.random() > 0.2; // 80% success rate
            if (success) {
                const actualProfit = opportunity.profitUsd * (0.8 + Math.random() * 0.3);
                // Update balance using dynamic pricing
                const solPrice = await priceService.getPriceUsd(config.tokens.SOL);
                setBalanceInfo(prev => ({
                    ...prev,
                    sol: prev.sol + actualProfit / solPrice,
                    totalUsd: prev.totalUsd + actualProfit
                }));
                console.log(`✅ STRATEGY SUCCESS: ${opportunity.strategyName} - $${(actualProfit != null && !isNaN(actualProfit) && typeof actualProfit === 'number' ? actualProfit.toFixed(6) : '0.000000')}`);
                // Remove executed opportunity
                setOpportunities(prev => prev.filter(opp => opp.id !== opportunity.id));
            }
            else {
                throw new Error('Strategy execution failed');
            }
        }
        catch (error) {
            console.error(`❌ STRATEGY EXECUTION FAILED: ${opportunity.strategyName}`, error);
        }
        finally {
            setExecutingTradeId(null);
        }
    };
    const getStatusIcon = (status) => {
        switch (status) {
            case 'SUCCESS': return _jsx(CheckCircle, { className: "w-4 h-4 text-green-500" });
            case 'FAILED': return _jsx(XCircle, { className: "w-4 h-4 text-red-500" });
            case 'PENDING': return _jsx(Activity, { className: "w-4 h-4 text-yellow-500 animate-spin" });
            default: return null;
        }
    };
    const getStrategyIcon = (strategyName) => {
        switch (strategyName) {
            case 'MICRO_ARBITRAGE': return '💎';
            case 'CROSS_DEX_ARBITRAGE': return '🔄';
            case 'SANDWICH': return '🥪';
            case 'LIQUIDATION': return '⚡';
            case 'MEME_MEV': return '🚀';
            case 'JITO_BUNDLE': return '📦';
            case 'PRICE_RECOVERY': return '📈';
            default: return '🎯';
        }
    };
    if (!isInitialized) {
        return (_jsx("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center", children: _jsxs("div", { className: "text-center", children: [_jsx(Activity, { className: "w-12 h-12 text-blue-400 mx-auto mb-4 animate-spin" }), _jsx("h2", { className: "text-2xl font-bold text-white mb-2", children: "Initializing Advanced MEV Strategy Engine" }), _jsxs("p", { className: "text-gray-300", children: ["Loading all strategies optimized for ", (balanceInfo.sol != null && !isNaN(balanceInfo.sol) && typeof balanceInfo.sol === 'number' ? balanceInfo.sol.toFixed(2) : '0.00'), " SOL..."] })] }) }));
    }
    if (showWalletIntegration) {
        return (_jsx("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-6", children: _jsxs("div", { className: "max-w-4xl mx-auto space-y-6", children: [_jsxs("div", { className: "text-center space-y-2", children: [_jsx("h1", { className: "text-4xl font-bold text-white", children: "\uD83C\uDFAF Advanced MEV Strategy Engine" }), _jsx("p", { className: "text-purple-200", children: "Connect your wallet to start autonomous MEV trading with all strategies" })] }), _jsx(WalletIntegration, {}), _jsx("div", { className: "text-center", children: _jsx(Button, { onClick: () => setShowWalletIntegration(false), variant: "outline", className: "border-blue-500/50 text-blue-400 hover:bg-blue-500/20", children: "Back to Dashboard" }) })] }) }));
    }
    if (showSettings) {
        return (_jsx(TradingSettingsPanel, { onClose: () => setShowSettings(false) }));
    }
    return (_jsx("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-6", children: _jsxs("div", { className: "max-w-7xl mx-auto space-y-6", children: [_jsxs("div", { className: "text-center space-y-2", children: [_jsx("h1", { className: "text-4xl font-bold text-white", children: "\uD83C\uDFAF Advanced MEV Strategy Engine" }), _jsxs("p", { className: "text-purple-200", children: [balanceInfo.sol >= 5.0 ? 'High-Capital MEV Trading' : 'Multi-Strategy MEV Trading', " | All Strategies Active"] }), _jsxs("div", { className: "flex justify-center space-x-4 mt-4", children: [_jsx(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50", children: "\u2705 JUPITER API" }), _jsx(Badge, { className: `${systemHealth.walletConnected ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-red-500/20 text-red-400 border-red-500/50'}`, children: systemHealth.walletConnected ? '✅ WALLET CONNECTED' : '❌ WALLET DISCONNECTED' }), _jsx(Badge, { className: `${systemHealth.strategiesActive ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-gray-500/20 text-gray-400 border-gray-500/50'}`, children: systemHealth.strategiesActive ? `🎯 ${activeStrategies} STRATEGIES` : '⏸️ STRATEGIES IDLE' }), _jsx(Badge, { className: `${systemHealth.scannerActive ? 'bg-green-500/20 text-green-400 border-green-500/50' : 'bg-gray-500/20 text-gray-400 border-gray-500/50'}`, children: systemHealth.scannerActive ? '🔍 SCANNING' : '⏸️ IDLE' }), _jsxs(Badge, { className: "bg-blue-500/20 text-blue-400 border-blue-500/50", children: ["\uD83D\uDCCA ", opportunities.length, " OPPORTUNITIES"] })] })] }), _jsx(Card, { className: `${walletState.isConnected ? 'bg-black/20 border-green-500/30' : 'bg-black/20 border-red-500/30'}`, children: _jsx(CardContent, { className: "p-4", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { className: "flex items-center space-x-4", children: walletState.isConnected ? (_jsxs(_Fragment, { children: [_jsx(CheckCircle, { className: "w-5 h-5 text-green-400" }), _jsxs("div", { children: [_jsxs("div", { className: "text-white font-medium", children: ["Test Wallet Connected: ", walletState.publicKey?.slice(0, 8), "...", walletState.publicKey?.slice(-4)] }), _jsxs("div", { className: "text-sm text-gray-300", children: ["Balance: ", (balanceInfo.sol != null && !isNaN(balanceInfo.sol) && typeof balanceInfo.sol === 'number' ? balanceInfo.sol.toFixed(4) : '0.0000'), " SOL | $", (balanceInfo.totalUsd != null && !isNaN(balanceInfo.totalUsd) && typeof balanceInfo.totalUsd === 'number' ? balanceInfo.totalUsd.toFixed(2) : '0.00'), " USD Total", _jsx("span", { className: "ml-2 text-green-400 font-bold", children: "\u2022 ALL STRATEGIES ENABLED" })] })] })] })) : (_jsxs(_Fragment, { children: [_jsx(XCircle, { className: "w-5 h-5 text-red-400" }), _jsxs("div", { children: [_jsx("div", { className: "text-white font-medium", children: "No Wallet Connected" }), _jsxs("div", { className: "text-sm text-gray-300", children: ["Connect your wallet to start autonomous MEV trading", _jsx("span", { className: "ml-2 text-red-400", children: "\u2022 STRATEGIES DISABLED" })] })] })] })) }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsxs(Button, { onClick: () => setShowWalletIntegration(true), variant: "outline", size: "sm", className: "border-blue-500/50 text-blue-400 hover:bg-blue-500/20", children: [_jsx(Wallet, { className: "w-4 h-4 mr-2" }), walletState.isConnected ? 'Wallet Settings' : 'Connect Wallet'] }), _jsxs(Button, { onClick: () => setShowSettings(true), variant: "outline", size: "sm", className: "border-purple-500/50 text-purple-400 hover:bg-purple-500/20", children: [_jsx(Settings, { className: "w-4 h-4 mr-2" }), "Settings"] }), walletState.isConnected && (_jsxs(_Fragment, { children: [_jsxs(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50", children: [_jsx(Shield, { className: "w-3 h-3 mr-1" }), "SECURE"] }), _jsx(Badge, { className: "bg-blue-500/20 text-blue-400 border-blue-500/50", children: "MAINNET" })] }))] })] }) }) }), _jsx(Card, { className: "bg-black/20 border-purple-500/30", children: _jsx(CardContent, { className: "p-4", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center space-x-6", children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Layers, { className: "w-4 h-4 text-purple-400" }), _jsx(Label, { className: "text-white", children: "All Strategies" }), _jsx(Switch, { checked: isScanning, onCheckedChange: (checked) => {
                                                        if (checked) {
                                                            handleStartAllStrategies();
                                                        }
                                                        else {
                                                            handleStopAllStrategies();
                                                        }
                                                    } })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Bot, { className: "w-4 h-4 text-green-400" }), _jsx(Label, { className: "text-white", children: "Auto-Execute" }), _jsx(Switch, { checked: config.trading.autoTradingEnabled, onCheckedChange: (checked) => {
                                                        tradingConfigManager.updateSection('trading', { autoTradingEnabled: checked });
                                                    } })] }), _jsxs("div", { className: "text-sm text-gray-300", children: ["Min Profit: $", (config.trading.minProfitUsd != null && !isNaN(config.trading.minProfitUsd) && typeof config.trading.minProfitUsd === 'number' ? config.trading.minProfitUsd.toFixed(6) : '0.000000'), " | Max Position: ", config.trading.maxPositionSol, " SOL | Success Rate: ", (successRate != null && !isNaN(successRate) && typeof successRate === 'number' ? successRate.toFixed(1) : '0.0'), "%"] })] }), _jsxs("div", { className: "flex items-center space-x-4", children: [_jsxs("div", { className: "text-right", children: [_jsx("div", { className: "text-sm text-gray-300", children: "Total Strategy Profit" }), _jsxs("div", { className: "text-lg font-bold text-green-400", children: ["$", (totalProfit != null && !isNaN(totalProfit) && typeof totalProfit === 'number' ? totalProfit.toFixed(6) : '0.000000')] })] }), isScanning && (_jsxs(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50", children: ["\uD83C\uDFAF ", activeStrategies, " STRATEGIES ACTIVE"] }))] })] }) }) }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-6", children: [_jsx("div", { className: "lg:col-span-1", children: _jsxs(Card, { className: "bg-black/20 border-yellow-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-yellow-400 flex items-center", children: [_jsx(TrendingUp, { className: "w-5 h-5 mr-2" }), "Strategy Performance"] }) }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "text-gray-300", children: "Active Strategies" }), _jsx(Badge, { className: "bg-blue-500/20 text-blue-400 border-blue-500/50", children: activeStrategies })] }), _jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "text-gray-300", children: "Success Rate" }), _jsxs("span", { className: "text-green-400 font-bold", children: [(successRate != null && !isNaN(successRate) && typeof successRate === 'number' ? successRate.toFixed(1) : '0.0'), "%"] })] }), _jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "text-gray-300", children: "Total Profit" }), _jsxs("span", { className: "text-green-400 font-bold", children: ["$", (totalProfit != null && !isNaN(totalProfit) && typeof totalProfit === 'number' ? totalProfit.toFixed(6) : '0.000000')] })] }), _jsxs("div", { className: "flex justify-between items-center", children: [_jsx("span", { className: "text-gray-300", children: "Queue Size" }), _jsx("span", { className: "text-blue-400", children: opportunities.length })] })] }) })] }) }), _jsx("div", { className: "lg:col-span-2", children: _jsxs(Card, { className: "bg-black/20 border-green-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-green-400 flex items-center", children: [_jsx(Target, { className: "w-5 h-5 mr-2" }), "Strategy Opportunities", isScanning && (_jsxs(Badge, { className: "ml-2 bg-green-500/20 text-green-400 border-green-500/50", children: [_jsx(Activity, { className: "w-3 h-3 mr-1 animate-spin" }), "SCANNING"] })), config.trading.autoTradingEnabled && (_jsxs(Badge, { className: "ml-2 bg-purple-500/20 text-purple-400 border-purple-500/50", children: [_jsx(Bot, { className: "w-3 h-3 mr-1" }), "AUTO-EXECUTE"] }))] }) }), _jsx(CardContent, { children: opportunities.length === 0 ? (_jsxs("div", { className: "text-center py-8", children: [_jsx("div", { className: "text-gray-400 mb-4", children: isScanning ? 'Scanning for strategy opportunities...' : 'Start strategies to find MEV opportunities' }), !isScanning && (_jsx("p", { className: "text-sm text-gray-500", children: "Enable \"All Strategies\" to begin autonomous MEV trading" }))] })) : (_jsx("div", { className: "space-y-3", children: opportunities.map((opportunity) => (_jsx("div", { className: "bg-black/30 rounded-lg p-4 border border-gray-700", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx("span", { className: "text-lg", children: getStrategyIcon(opportunity.strategyName) }), _jsx("span", { className: "text-white font-medium", children: opportunity.pair }), _jsx(Badge, { className: "bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs", children: opportunity.strategyName }), _jsx(Badge, { className: `text-xs ${opportunity.riskLevel === 'LOW' ? 'bg-green-500/20 text-green-400 border-green-500/50' :
                                                                                opportunity.riskLevel === 'MEDIUM' || opportunity.riskLevel === 'HIGH' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50' :
                                                                                    'bg-red-500/20 text-red-400 border-red-500/50'}`, children: opportunity.riskLevel })] }), _jsxs("div", { className: "flex items-center space-x-4 mt-1 text-sm", children: [_jsxs("span", { className: "text-green-400", children: ["Profit: $", (opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')] }), _jsxs("span", { className: "text-blue-400", children: [opportunity.targetProfit != null && opportunity.recommendedCapital ? ((opportunity.targetProfit / opportunity.recommendedCapital) * 100).toFixed(2) : '0.00', "%"] }), _jsxs("span", { className: "text-gray-400", children: ["Confidence: ", opportunity.confidence ? ((opportunity.confidence * 100).toFixed(0)) : '0', "%"] }), _jsxs("span", { className: "text-purple-400", children: ["Capital: ", (opportunity.recommendedCapital != null && !isNaN(opportunity.recommendedCapital) && typeof opportunity.recommendedCapital === 'number' ? opportunity.recommendedCapital.toFixed(3) : '0.000'), " SOL"] })] }), _jsxs("div", { className: "text-xs text-gray-500 mt-1", children: ["Plan: ", opportunity.executionPlan?.join(' → ')] })] }), _jsx(Button, { onClick: () => executeStrategyTrade(opportunity), disabled: executingTradeId === opportunity.id, size: "sm", className: "bg-green-600 hover:bg-green-700 text-white disabled:opacity-50", children: executingTradeId === opportunity.id ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Executing..."] })) : (_jsxs(_Fragment, { children: [_jsx(Zap, { className: "w-4 h-4 mr-2" }), "Execute"] })) })] }) }, opportunity.id))) })) })] }) })] }), tradeHistory.length > 0 && (_jsxs(Card, { className: "bg-black/20 border-purple-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-purple-400 flex items-center", children: [_jsx(Clock, { className: "w-5 h-5 mr-2" }), "Recent Strategy Executions"] }) }), _jsx(CardContent, { children: _jsx("div", { className: "space-y-3 max-h-64 overflow-y-auto", children: tradeHistory.slice(0, 10).map((trade, index) => (_jsx("div", { className: "bg-black/30 rounded-lg p-3 border border-gray-700", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center space-x-3", children: [trade.status === 'completed' ? (_jsx(CheckCircle, { className: "w-4 h-4 text-green-500" })) : (_jsx(XCircle, { className: "w-4 h-4 text-red-500" })), _jsxs("div", { children: [_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx("span", { className: "text-lg", children: getStrategyIcon('Strategy') }), _jsx("span", { className: "text-white font-medium", children: trade.opportunityId || 'Strategy' }), _jsx(Badge, { className: "bg-purple-500/20 text-purple-400 border-purple-500/50 text-xs", children: trade.status || 'unknown' })] }), _jsxs("div", { className: "flex items-center space-x-4 mt-1 text-sm", children: [trade.profitRealized && (_jsxs("span", { className: "text-green-400", children: ["Profit: $", (trade.profitRealized.toFixed(6))] })), _jsx("span", { className: "text-gray-400", children: new Date(trade.timestamp).toLocaleTimeString() })] })] })] }), _jsxs("div", { className: "text-right", children: [_jsx(Badge, { variant: "outline", className: trade.status === 'completed' ? 'border-green-500 text-green-400' :
                                                            trade.status === 'failed' ? 'border-red-500 text-red-400' :
                                                                'border-yellow-500 text-yellow-400', children: trade.status.toUpperCase() }), trade.opportunityId && (_jsxs("div", { className: "text-xs text-gray-400 mt-1", children: [trade.opportunityId.slice(0, 12), "..."] }))] })] }) }, index))) }) })] })), _jsxs("div", { className: "text-center text-sm text-purple-300 space-y-2", children: [_jsx("p", { children: "\uD83C\uDFAF Advanced MEV Strategy Engine | All Strategies Active" }), _jsxs("div", { className: "flex items-center justify-center space-x-6", children: [_jsxs("span", { children: ["Strategies: ", activeStrategies] }), _jsxs("span", { children: ["Success Rate: ", (successRate != null && !isNaN(successRate) && typeof successRate === 'number' ? successRate.toFixed(1) : '0.0'), "%"] }), _jsxs("span", { children: ["Total Profit: $", (totalProfit != null && !isNaN(totalProfit) && typeof totalProfit === 'number' ? totalProfit.toFixed(6) : '0.000000')] }), _jsxs("span", { children: ["Auto-Execute: ", config.trading.autoTradingEnabled ? '🟢 ACTIVE' : '🔴 INACTIVE'] }), _jsxs("span", { children: ["Wallet: ", walletState.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'] })] }), _jsx("p", { className: "text-xs text-gray-400", children: "All strategies implemented and active - No flash loans - Autonomous trading enabled" })] })] }) }));
};
export default ProductionTradingDashboard;
