import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { strategyEngine } from '@/services/StrategyEngine';
// PHASE 2 AUTO-TRADING - ALL ADVANCED STRATEGIES INTEGRATED
// One-click setup with ALL Phase 2 MEV strategies
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { getAllRiskProfiles } from '../config/riskProfiles';
import { autoConfigService } from '../services/autoConfigService';
import { Loader2, CheckCircle2, AlertCircle, TrendingUp, Shield, Zap, Activity, Rocket } from 'lucide-react';
import { privateKeyWallet } from '../services/privateKeyWallet';
// import { strategyEngine, StrategyOpportunity } from '../strategies/StrategyEngine';
import { realTradeExecutor } from '../services/realTradeExecutor';
import { Keypair } from '@solana/web3.js';
import { APIHealthDashboard } from './APIHealthDashboard';
import { advancedMEVScanner } from '../services/advancedMEVScanner';
export default function Phase2AutoTrading() {
    const [privateKey, setPrivateKey] = useState('');
    const [selectedRisk, setSelectedRisk] = useState('BALANCED');
    const [isConfiguring, setIsConfiguring] = useState(false);
    const [config, setConfig] = useState(null);
    const [isTrading, setIsTrading] = useState(false);
    const [error, setError] = useState('');
    const [opportunities, setOpportunities] = useState([]);
    const [totalProfit, setTotalProfit] = useState(0);
    const [tradesExecuted, setTradesExecuted] = useState(0);
    const [activeStrategies, setActiveStrategies] = useState([]);
    const profiles = getAllRiskProfiles();
    // Handle auto-configuration
    const handleConfigure = async () => {
        if (!privateKey.trim()) {
            setError('Please enter your wallet private key');
            return;
        }
        setError('');
        setIsConfiguring(true);
        try {
            // Derive wallet address from private key
            let walletAddress;
            try {
                const { Keypair } = await import('@solana/web3.js');
                const bs58 = await import('bs58');
                let keypair;
                const trimmedKey = privateKey.trim();
                if (trimmedKey.startsWith('[')) {
                    const secretKey = Uint8Array.from(JSON.parse(trimmedKey));
                    keypair = Keypair.fromSecretKey(secretKey);
                }
                else {
                    const secretKey = bs58.default.decode(trimmedKey);
                    keypair = Keypair.fromSecretKey(secretKey);
                }
                walletAddress = keypair.publicKey.toString();
                console.log('✅ Wallet derived:', walletAddress);
            }
            catch (keyError) {
                throw new Error('Invalid private key format. Use base58 string or [1,2,3...] array format.');
            }
            // Auto-configure everything!
            const autoConfig = await autoConfigService.autoConfigureBot(walletAddress, selectedRisk);
            setConfig(autoConfig);
            setIsConfiguring(false);
            if (autoConfig.readyToTrade) {
                console.log('✅ Configuration complete! Ready to start trading.');
            }
        }
        catch (err) {
            setError('Failed to configure bot: ' + err.message);
            setIsConfiguring(false);
        }
    };
    // Start ALL Phase 2 strategies with REAL TRADING
    const handleStartTrading = async () => {
        if (!config)
            return;
        setIsTrading(true);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('🚀 PHASE 2 AUTO-TRADING STARTED - REAL EXECUTION MODE');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('📊 Risk Profile:', config.profile.name);
        console.log('💰 Capital:', config.calculatedSettings.maxPositionSol.toFixed(4), 'SOL per trade');
        console.log('📈 Strategies:', config.enabledStrategies.join(', '));
        console.log('⚠️  REAL TRADING: Transactions will be sent to Solana mainnet');
        console.log('💸 Fee Check: Only profitable trades (after ALL fees) will execute');
        console.log('═══════════════════════════════════════════════════════════');
        try {
            // Connect wallet and derive keypair
            await privateKeyWallet.connectWithPrivateKey(privateKey);
            console.log('✅ Wallet connected');
            // Derive keypair for signing transactions
            const bs58 = await import('bs58');
            let keypair;
            const trimmedKey = privateKey.trim();
            if (trimmedKey.startsWith('[')) {
                const secretKey = Uint8Array.from(JSON.parse(trimmedKey));
                keypair = Keypair.fromSecretKey(secretKey);
            }
            else {
                const secretKey = bs58.default.decode(trimmedKey);
                keypair = Keypair.fromSecretKey(secretKey);
            }
            console.log('🔑 Keypair derived for transaction signing');
            console.log('🔗 Will execute as:', keypair.publicKey.toString());
            // Track enabled strategies
            const enabled = [];
            if (config.profile.enabledStrategies.backrun)
                enabled.push('Backrun');
            if (config.profile.enabledStrategies.cyclicArbitrage)
                enabled.push('Cyclic Arbitrage');
            if (config.profile.enabledStrategies.jitLiquidity)
                enabled.push('JIT Liquidity');
            if (config.profile.enabledStrategies.longTailArbitrage)
                enabled.push('Long-Tail Arbitrage');
            if (config.profile.enabledStrategies.microArbitrage)
                enabled.push('Micro Arbitrage');
            if (config.profile.enabledStrategies.crossDexArbitrage)
                enabled.push('Cross-DEX Arbitrage');
            if (config.profile.enabledStrategies.sandwich)
                enabled.push('Sandwich');
            if (config.profile.enabledStrategies.liquidation)
                enabled.push('Liquidation');
            setActiveStrategies(enabled);
            console.log('🔥 Starting ALL Phase 2 strategies...');
            enabled.forEach(s => console.log(`   ✅ ${s}`));
            // Start StrategyEngine with REAL EXECUTION CALLBACK
            advancedMEVScanner.setWallet(keypair);
            await strategyEngine.startAllStrategies(config.calculatedSettings.maxPositionSol, async (detectedOpps) => {
                // Filter opportunities by configuration
                const riskLevels = { 'ULTRA_LOW': 1, 'LOW': 2, 'MEDIUM': 3, 'HIGH': 4 };
                const maxRisk = config.profile.level === 'CONSERVATIVE' ? 2 :
                    config.profile.level === 'BALANCED' ? 3 : 4;
                const filtered = detectedOpps.filter(opp => {
                    const oppRisk = riskLevels[opp.riskLevel] || 0;
                    const meetsProfit = opp.profitUsd && opp.profitUsd >= config.profile.minProfitUsd;
                    const meetsConfidence = opp.confidence >= 0.7;
                    const meetsRisk = oppRisk <= maxRisk;
                    return meetsProfit && meetsConfidence && meetsRisk;
                });
                if (filtered.length > 0) {
                    console.log(`🎯 Found ${filtered.length} potentially profitable opportunities!`);
                    // Execute REAL trades with full fee calculation
                    for (const opp of filtered.slice(0, config.profile.maxConcurrentTrades)) {
                        console.log('');
                        console.log(`💎 Evaluating: ${opp.strategyName} - ${opp.pair}`);
                        console.log(`   Expected Profit: $${opp.profitUsd?.toFixed(4) || '0.0000'}`);
                        console.log(`   Confidence: ${(opp.confidence * 100).toFixed(1)}%`);
                        try {
                            // Execute REAL trade with profitability check
                            const SOL_MINT = 'So11111111111111111111111111111111111111112';
                            const amountSOL = opp.recommendedCapital || config.calculatedSettings.maxPositionSol * 0.5;
                            const result = await realTradeExecutor.executeArbitrageCycle(opp.outputMint, // ← tokenMint (convert to string)
                            amountSOL, // ← amountSOL (correct spelling)
                            config.profile.slippageBps, // ← slippageBps
                            keypair, // ← wallet
                            config.profile.level === 'AGGRESSIVE' // ← useJito
                            );
                            // const result = await realTradeExecutor.executeArbitrageCycle({
                            //   tokenMint: opp.outputMint,
                            //   amountSol: amountSOL,
                            //   slippageBps: config.profile.slippageBps,
                            //   wallet: keypair,
                            //   useJito: config.profile.level === 'AGGRESSIVE',
                            //   expectedCycleProfitUsd: opp.profitUsd,
                            //   minNetProfitUsd: config.profile.minProfitUsd
                            // });
                            if (result.success) {
                                console.log(`✅ REAL TRADE EXECUTED!`);
                                console.log(`   Net Profit: $${result.netProfitUSD.toFixed(4)}`);
                                console.log(`   TX Signatures: ${result.txSignatures.join(', ')}`);
                                setTotalProfit(prev => prev + result.netProfitUSD);
                                setTradesExecuted(prev => prev + 1);
                                // Add to opportunities list
                                setOpportunities(prev => [{
                                        ...opp,
                                        profitUsd: result.netProfitUSD,
                                        executed: true,
                                        txSignatures: result.txSignatures
                                    }, ...prev].slice(0, 20));
                            }
                            else {
                                console.log(`❌ Trade rejected: Not profitable after fees`);
                            }
                        }
                        catch (execError) {
                            console.error(`❌ Execution error for ${opp.pair}:`, execError);
                        }
                    }
                }
            });
            console.log('');
            console.log('✅ ALL PHASE 2 STRATEGIES ACTIVE - REAL TRADING ENABLED!');
            console.log('═══════════════════════════════════════════════════════════');
        }
        catch (err) {
            console.error('❌ Failed to start:', err);
            setError('Failed to start: ' + err.message);
            setIsTrading(false);
        }
    };
    // Stop all strategies
    const handleStopTrading = async () => {
        console.log('⏹️ Stopping all Phase 2 strategies...');
        await strategyEngine.stopAllStrategies();
        setIsTrading(false);
        setOpportunities([]);
        setActiveStrategies([]);
        console.log('✅ All strategies stopped');
    };
    // Cleanup
    useEffect(() => {
        return () => {
            if (isTrading) {
                strategyEngine.stopAllStrategies();
            }
        };
    }, [isTrading]);
    // Icon helpers
    const getRiskIcon = (level) => {
        if (level === 'CONSERVATIVE')
            return _jsx(Shield, { className: "w-5 h-5" });
        if (level === 'BALANCED')
            return _jsx(TrendingUp, { className: "w-5 h-5" });
        return _jsx(Zap, { className: "w-5 h-5" });
    };
    const getRiskColor = (level) => {
        if (level === 'CONSERVATIVE')
            return 'bg-green-500';
        if (level === 'BALANCED')
            return 'bg-blue-500';
        return 'bg-red-500';
    };
    return (_jsxs("div", { className: "container mx-auto p-6 max-w-6xl", children: [_jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-3xl", children: "\uD83D\uDE80 Phase 2 Automated MEV Bot" }), _jsx(CardDescription, { children: "All 7 advanced strategies. Auto-configured based on risk profile. One-click start." })] }), _jsxs(CardContent, { className: "space-y-6", children: [!config && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "privateKey", children: "Wallet Private Key" }), _jsx(Input, { id: "privateKey", type: "password", placeholder: "Enter your Solana wallet private key...", value: privateKey, onChange: (e) => setPrivateKey(e.target.value), className: "font-mono" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Your private key never leaves your browser. Stored locally only." })] }), _jsxs("div", { className: "space-y-3", children: [_jsx(Label, { children: "Select Risk Profile" }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4", children: profiles.map((profile) => (_jsx(Card, { className: `cursor-pointer transition-all ${selectedRisk === profile.level
                                                        ? 'ring-2 ring-primary shadow-lg'
                                                        : 'hover:bg-accent'}`, onClick: () => setSelectedRisk(profile.level), children: _jsxs(CardContent, { className: "pt-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-3", children: [_jsx("div", { className: `p-2 rounded-full ${getRiskColor(profile.level)}`, children: getRiskIcon(profile.level) }), _jsx("h3", { className: "font-bold text-lg", children: profile.name })] }), _jsx("p", { className: "text-sm text-muted-foreground mb-4", children: profile.description }), _jsxs("div", { className: "space-y-2 text-sm", children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-muted-foreground", children: "Position:" }), _jsxs("span", { className: "font-medium", children: [profile.maxPositionPercent, "%"] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-muted-foreground", children: "Daily Return:" }), _jsx("span", { className: "font-medium text-green-600", children: profile.expectedDailyReturn })] })] })] }) }, profile.level))) })] }), error && (_jsxs(Alert, { variant: "destructive", children: [_jsx(AlertCircle, { className: "h-4 w-4" }), _jsx(AlertDescription, { children: error })] })), _jsx(Button, { className: "w-full", size: "lg", onClick: handleConfigure, disabled: isConfiguring || !privateKey.trim(), children: isConfiguring ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Configuring Bot..."] })) : ('⚡ Auto-Configure Bot') })] })), config && (_jsxs(_Fragment, { children: [_jsxs(Alert, { className: config.readyToTrade ? 'border-green-500 bg-green-50' : 'border-yellow-500', children: [config.readyToTrade ? (_jsx(CheckCircle2, { className: "h-4 w-4 text-green-500" })) : (_jsx(AlertCircle, { className: "h-4 w-4 text-yellow-500" })), _jsx(AlertDescription, { children: config.readyToTrade
                                                    ? '✅ Bot configured! All Phase 2 strategies ready.'
                                                    : '⚠️ Configuration complete but warnings detected.' })] }), _jsxs(Card, { className: "bg-gradient-to-br from-blue-50 to-purple-50", children: [_jsx(CardHeader, { children: _jsx(CardTitle, { children: "Configuration Summary" }) }), _jsxs(CardContent, { className: "space-y-3", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4 text-sm", children: [_jsxs("div", { children: [_jsx("p", { className: "text-muted-foreground", children: "Risk Profile" }), _jsx("p", { className: "font-bold text-lg", children: config.profile.name })] }), _jsxs("div", { children: [_jsx("p", { className: "text-muted-foreground", children: "Balance" }), _jsxs("p", { className: "font-bold text-lg", children: [config.walletBalance.toFixed(4), " SOL"] })] }), _jsxs("div", { children: [_jsx("p", { className: "text-muted-foreground", children: "Max Position" }), _jsxs("p", { className: "font-bold", children: [config.calculatedSettings.maxPositionSol.toFixed(4), " SOL"] })] }), _jsxs("div", { children: [_jsx("p", { className: "text-muted-foreground", children: "Min Profit" }), _jsxs("p", { className: "font-bold", children: ["$", config.profile.minProfitUsd.toFixed(3)] })] })] }), _jsxs("div", { children: [_jsxs("p", { className: "text-sm text-muted-foreground mb-2", children: ["Enabled Strategies (", config.enabledStrategies.length, "):"] }), _jsx("div", { className: "flex flex-wrap gap-2", children: config.enabledStrategies.map(strategy => (_jsx(Badge, { variant: "secondary", className: "text-xs", children: strategy }, strategy))) })] })] })] }), _jsxs("div", { className: "flex gap-4", children: [isTrading ? (_jsx(Button, { className: "flex-1", size: "lg", variant: "destructive", onClick: handleStopTrading, children: "\u23F9\uFE0F Stop All Strategies" })) : (_jsx(Button, { className: "flex-1", size: "lg", onClick: handleStartTrading, disabled: !config.readyToTrade, children: "\uD83D\uDE80 Start Phase 2 Trading" })), _jsx(Button, { variant: "outline", onClick: () => {
                                                    setConfig(null);
                                                    setOpportunities([]);
                                                    setTotalProfit(0);
                                                    setTradesExecuted(0);
                                                }, disabled: isTrading, children: "Reset" })] }), isTrading && (_jsxs(_Fragment, { children: [_jsxs(Alert, { className: "border-green-500 bg-green-50", children: [_jsx(Rocket, { className: "h-4 w-4 text-green-500 animate-pulse" }), _jsxs(AlertDescription, { children: [_jsx("span", { className: "font-bold", children: "Phase 2 strategies active!" }), " Bot is monitoring ", activeStrategies.length, " strategies and auto-executing profitable trades."] })] }), _jsxs(Card, { className: "bg-gradient-to-br from-green-50 to-blue-50 border-2 border-green-300", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2", children: [_jsx(Activity, { className: "w-5 h-5 text-green-600 animate-pulse" }), "Live Phase 2 Trading"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsx(Card, { children: _jsxs(CardContent, { className: "pt-4 text-center", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Opportunities" }), _jsx("p", { className: "text-4xl font-bold text-blue-600", children: opportunities.length })] }) }), _jsx(Card, { children: _jsxs(CardContent, { className: "pt-4 text-center", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Trades" }), _jsx("p", { className: "text-4xl font-bold text-purple-600", children: tradesExecuted })] }) }), _jsx(Card, { children: _jsxs(CardContent, { className: "pt-4 text-center", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Profit" }), _jsxs("p", { className: "text-4xl font-bold text-green-600", children: ["$", totalProfit.toFixed(2)] })] }) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm font-semibold mb-2", children: "\uD83D\uDD25 Active Strategies:" }), _jsx("div", { className: "flex flex-wrap gap-2", children: activeStrategies.map(strategy => (_jsxs(Badge, { className: "bg-green-100 text-green-700", children: [_jsx(Rocket, { className: "w-3 h-3 mr-1 inline animate-pulse" }), strategy] }, strategy))) })] }), opportunities.length > 0 ? (_jsxs("div", { children: [_jsxs("p", { className: "text-sm font-semibold mb-2", children: ["\uD83C\uDFAF Recent Opportunities (", opportunities.length, "):"] }), _jsx("div", { className: "space-y-2 max-h-80 overflow-y-auto", children: opportunities.slice(0, 15).map(opp => (_jsx("div", { className: "bg-white p-3 rounded-lg border shadow-sm", children: _jsxs("div", { className: "flex justify-between items-start", children: [_jsxs("div", { className: "flex-1", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "font-semibold text-sm", children: opp.pair }), _jsx(Badge, { className: "bg-purple-100 text-purple-700 text-xs", children: opp.strategyName }), _jsx(Badge, { className: `text-xs ${opp.riskLevel === 'LOW' ? 'bg-green-100 text-green-700' :
                                                                                                            opp.riskLevel === 'MEDIUM' ? 'bg-yellow-100 text-yellow-700' :
                                                                                                                'bg-red-100 text-red-700'}`, children: opp.riskLevel })] }), _jsxs("div", { className: "flex gap-3 mt-1 text-xs text-muted-foreground", children: [_jsxs("span", { className: "text-green-600 font-semibold", children: ["$", opp.profitUsd.toFixed(4)] }), _jsxs("span", { children: [(opp.confidence * 100).toFixed(0), "% confident"] }), _jsxs("span", { children: [opp.recommendedCapital.toFixed(3), " SOL"] })] }), opp.executionPlan && opp.executionPlan.length > 0 && (_jsx("div", { className: "mt-1 text-xs text-gray-500 font-mono", children: opp.executionPlan.slice(0, 3).join(' → ') }))] }), _jsx(Badge, { className: "bg-green-500 text-white text-xs", children: "\u2705 Executed" })] }) }, opp.id))) })] })) : (_jsxs("div", { className: "text-center py-8 bg-white rounded-lg border", children: [_jsx(Activity, { className: "w-16 h-16 mx-auto text-blue-400 animate-pulse mb-3" }), _jsx("p", { className: "text-base font-semibold mb-2", children: "Monitoring Market..." }), _jsxs("p", { className: "text-sm text-muted-foreground mb-4", children: ["Bot is actively scanning ", activeStrategies.length, " Phase 2 strategies"] }), _jsx("div", { className: "max-w-xs mx-auto space-y-1", children: activeStrategies.map(s => (_jsxs("div", { className: "text-xs text-gray-600 flex items-center justify-center gap-2", children: [_jsx("div", { className: "w-2 h-2 bg-green-500 rounded-full animate-pulse" }), s] }, s))) })] }))] })] })] }))] }))] })] }), isTrading && _jsx(APIHealthDashboard, {})] }));
}
