import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { fastMEVEngine } from '@/services/fastMEVEngine';
// AUTO-TRADING SETUP COMPONENT
// Simple one-click setup for automated trading
// User just enters wallet, selects risk, and clicks START!
import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { getAllRiskProfiles } from '../config/riskProfiles';
import { autoConfigService } from '../services/autoConfigService';
import { Loader2, CheckCircle2, AlertCircle, TrendingUp, Shield, Zap } from 'lucide-react';
import { privateKeyWallet } from '../services/privateKeyWallet';
export default function AutoTradingSetup() {
    const [privateKey, setPrivateKey] = useState('');
    const [selectedRisk, setSelectedRisk] = useState('BALANCED');
    const [isConfiguring, setIsConfiguring] = useState(false);
    const [config, setConfig] = useState(null);
    const [isTrading, setIsTrading] = useState(false);
    const [error, setError] = useState('');
    const [opportunities, setOpportunities] = useState([]);
    const [scanInterval, setScanInterval] = useState(null);
    const [totalProfit, setTotalProfit] = useState(0);
    const [tradesExecuted, setTradesExecuted] = useState(0);
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
                // Import Solana web3 for wallet derivation
                const { Keypair } = await import('@solana/web3.js');
                const bs58 = await import('bs58');
                // Decode private key (supports both base58 and JSON array formats)
                let keypair;
                const trimmedKey = privateKey.trim();
                if (trimmedKey.startsWith('[')) {
                    // JSON array format [1,2,3,...]
                    const secretKey = Uint8Array.from(JSON.parse(trimmedKey));
                    keypair = Keypair.fromSecretKey(secretKey);
                }
                else {
                    // Base58 format
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
            // Show success
            if (autoConfig.readyToTrade) {
                console.log('✅ Configuration complete! Ready to start trading.');
            }
        }
        catch (err) {
            setError('Failed to configure bot: ' + err.message);
            setIsConfiguring(false);
        }
    };
    // Start auto-trading
    const handleStartTrading = async () => {
        if (!config)
            return;
        setIsTrading(true);
        console.log('🚀 Starting automated trading with config:', config);
        try {
            // Import and setup wallet from private key
            const { Keypair } = await import('@solana/web3.js');
            const bs58 = await import('bs58');
            let secretKey;
            const trimmedKey = privateKey.trim();
            if (trimmedKey.startsWith('[')) {
                secretKey = Uint8Array.from(JSON.parse(trimmedKey));
            }
            else {
                secretKey = bs58.default.decode(trimmedKey);
            }
            const keypair = Keypair.fromSecretKey(secretKey);
            // Connect the wallet
            await privateKeyWallet.connectWithPrivateKey(privateKey);
            console.log('✅ Wallet connected for trading');
            // Start MEV scanner with configured parameters
            const scanIntervalMs = config.profile.scanIntervalMs;
            const interval = setInterval(async () => {
                try {
                    console.log('🔍 Scanning for MEV opportunities...');
                    // Scan for opportunities using fastMEVEngine
                    const detectedOpportunities = await fastMEVEngine.scanForMEVOpportunities();
                    setOpportunities(detectedOpportunities);
                    if (detectedOpportunities.length > 0) {
                        console.log(`✅ Found ${detectedOpportunities.length} opportunities`);
                        // Auto-execute best opportunities
                        for (const opp of detectedOpportunities.slice(0, config.profile.maxConcurrentTrades)) {
                            if (opp.netProfitUsd >= config.profile.minProfitUsd) {
                                console.log(`⚡ Auto-executing: ${opp.pair} for $${opp.netProfitUsd.toFixed(4)} profit`);
                                try {
                                    const result = await fastMEVEngine.executeArbitrage(opp, config.profile.priorityFeeLamports / 1e9);
                                    if (result.success) {
                                        console.log(`✅ Trade successful! Profit: $${result.actualProfitUsd?.toFixed(4)}`);
                                        setTotalProfit(prev => prev + (result.actualProfitUsd || 0));
                                        setTradesExecuted(prev => prev + 1);
                                    }
                                    else {
                                        console.log(`❌ Trade failed: ${result.error}`);
                                    }
                                }
                                catch (execError) {
                                    console.error('❌ Execution error:', execError);
                                }
                            }
                        }
                    }
                }
                catch (scanError) {
                    console.error('❌ Scan error:', scanError);
                }
            }, scanIntervalMs);
            setScanInterval(interval);
            console.log(`✅ Trading bot started! Scanning every ${scanIntervalMs}ms`);
        }
        catch (err) {
            console.error('❌ Failed to start trading:', err);
            setError('Failed to start trading: ' + err.message);
            setIsTrading(false);
        }
    };
    // Stop trading
    const handleStopTrading = () => {
        if (scanInterval) {
            clearInterval(scanInterval);
            setScanInterval(null);
        }
        setIsTrading(false);
        console.log('⏹️ Trading stopped');
    };
    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (scanInterval) {
                clearInterval(scanInterval);
            }
        };
    }, [scanInterval]);
    // Get risk icon
    const getRiskIcon = (level) => {
        if (level === 'CONSERVATIVE')
            return _jsx(Shield, { className: "w-5 h-5" });
        if (level === 'BALANCED')
            return _jsx(TrendingUp, { className: "w-5 h-5" });
        return _jsx(Zap, { className: "w-5 h-5" });
    };
    // Get risk color
    const getRiskColor = (level) => {
        if (level === 'CONSERVATIVE')
            return 'bg-green-500';
        if (level === 'BALANCED')
            return 'bg-blue-500';
        return 'bg-red-500';
    };
    return (_jsxs("div", { className: "container mx-auto p-6 max-w-4xl", children: [_jsxs(Card, { children: [_jsxs(CardHeader, { children: [_jsx(CardTitle, { className: "text-3xl", children: "\uD83E\uDD16 Automated MEV Trading Bot" }), _jsx(CardDescription, { children: "One-click setup. No manual configuration. Just select risk level and start trading." })] }), _jsxs(CardContent, { className: "space-y-6", children: [!config && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "space-y-2", children: [_jsx(Label, { htmlFor: "privateKey", children: "Wallet Private Key" }), _jsx(Input, { id: "privateKey", type: "password", placeholder: "Enter your Solana wallet private key...", value: privateKey, onChange: (e) => setPrivateKey(e.target.value), className: "font-mono" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Your private key never leaves your browser. Stored locally only." })] }), _jsxs("div", { className: "space-y-3", children: [_jsx(Label, { children: "Select Risk Profile" }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4", children: profiles.map((profile) => (_jsx(Card, { className: `cursor-pointer transition-all ${selectedRisk === profile.level
                                                        ? 'ring-2 ring-primary'
                                                        : 'hover:bg-accent'}`, onClick: () => setSelectedRisk(profile.level), children: _jsxs(CardContent, { className: "pt-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-3", children: [_jsx("div", { className: `p-2 rounded-full ${getRiskColor(profile.level)}`, children: getRiskIcon(profile.level) }), _jsx("h3", { className: "font-bold text-lg", children: profile.name })] }), _jsx("p", { className: "text-sm text-muted-foreground mb-4", children: profile.description }), _jsxs("div", { className: "space-y-2 text-sm", children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-muted-foreground", children: "Position Size:" }), _jsxs("span", { className: "font-medium", children: [profile.maxPositionPercent, "%"] })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-muted-foreground", children: "Daily Trades:" }), _jsx("span", { className: "font-medium", children: profile.expectedDailyTrades })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-muted-foreground", children: "Success Rate:" }), _jsx("span", { className: "font-medium", children: profile.expectedSuccessRate })] }), _jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-muted-foreground", children: "Daily Return:" }), _jsx("span", { className: "font-medium text-green-600", children: profile.expectedDailyReturn })] })] })] }) }, profile.level))) })] }), error && (_jsxs(Alert, { variant: "destructive", children: [_jsx(AlertCircle, { className: "h-4 w-4" }), _jsx(AlertDescription, { children: error })] })), _jsx(Button, { className: "w-full", size: "lg", onClick: handleConfigure, disabled: isConfiguring || !privateKey.trim(), children: isConfiguring ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }), "Configuring Bot..."] })) : ('⚡ Auto-Configure Bot') })] })), config && (_jsxs(_Fragment, { children: [_jsxs(Alert, { className: config.readyToTrade ? 'border-green-500' : 'border-yellow-500', children: [config.readyToTrade ? (_jsx(CheckCircle2, { className: "h-4 w-4 text-green-500" })) : (_jsx(AlertCircle, { className: "h-4 w-4 text-yellow-500" })), _jsx(AlertDescription, { children: config.readyToTrade
                                                    ? '✅ Bot configured successfully! Ready to start automated trading.'
                                                    : '⚠️ Configuration complete but warnings detected. Review below.' })] }), _jsxs(Card, { className: "bg-accent", children: [_jsx(CardHeader, { children: _jsx(CardTitle, { className: "text-lg", children: "Configuration Summary" }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Risk Profile" }), _jsx("p", { className: "font-bold", children: config.profile.name })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Wallet Balance" }), _jsxs("p", { className: "font-bold", children: [config.walletBalance.toFixed(4), " SOL"] })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Max Position" }), _jsxs("p", { className: "font-bold", children: [config.calculatedSettings.maxPositionSol.toFixed(4), " SOL"] })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Daily Limit" }), _jsxs("p", { className: "font-bold", children: [config.calculatedSettings.dailyLimitSol.toFixed(4), " SOL"] })] })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground mb-2", children: "Enabled Strategies" }), _jsx("div", { className: "flex flex-wrap gap-2", children: config.enabledStrategies.map((strategy) => (_jsx(Badge, { variant: "secondary", children: strategy }, strategy))) })] }), config.warnings.length > 0 && (_jsxs("div", { children: [_jsx("p", { className: "text-sm text-muted-foreground mb-2", children: "\u26A0\uFE0F Warnings" }), _jsx("ul", { className: "space-y-1", children: config.warnings.map((warning, i) => (_jsx("li", { className: "text-sm text-yellow-600", children: warning }, i))) })] }))] })] }), _jsxs("div", { className: "flex gap-4", children: [!isTrading ? (_jsx(Button, { className: "flex-1", size: "lg", onClick: handleStartTrading, disabled: !config.readyToTrade, children: "\uD83D\uDE80 Start Automated Trading" })) : (_jsx(Button, { className: "flex-1", size: "lg", variant: "destructive", onClick: handleStopTrading, children: "\u23F9\uFE0F Stop Trading" })), _jsx(Button, { variant: "outline", onClick: () => setConfig(null), disabled: isTrading, children: "Reset" })] }), isTrading && (_jsxs(Alert, { className: "border-green-500 bg-green-50", children: [_jsx(CheckCircle2, { className: "h-4 w-4 text-green-500" }), _jsxs(AlertDescription, { children: [_jsx("span", { className: "font-bold", children: "Bot is trading!" }), " Monitoring for opportunities and executing trades automatically. Expected: ", config.profile.expectedDailyTrades, "."] })] }))] }))] })] }), !config && (_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4 mt-6", children: [_jsx(Card, { children: _jsxs(CardContent, { className: "pt-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-2", children: [_jsx(Shield, { className: "w-6 h-6 text-green-500" }), _jsx("h3", { className: "font-bold", children: "Safe & Secure" })] }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Private keys never leave your browser. All trades executed securely on-chain." })] }) }), _jsx(Card, { children: _jsxs(CardContent, { className: "pt-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-2", children: [_jsx(Zap, { className: "w-6 h-6 text-yellow-500" }), _jsx("h3", { className: "font-bold", children: "Fully Automated" })] }), _jsx("p", { className: "text-sm text-muted-foreground", children: "No manual configuration needed. Bot auto-sizes positions based on your balance." })] }) }), _jsx(Card, { children: _jsxs(CardContent, { className: "pt-6", children: [_jsxs("div", { className: "flex items-center gap-3 mb-2", children: [_jsx(TrendingUp, { className: "w-6 h-6 text-blue-500" }), _jsx("h3", { className: "font-bold", children: "Proven Strategies" })] }), _jsx("p", { className: "text-sm text-muted-foreground", children: "7 Phase 2 MEV strategies working 24/7 to capture profitable opportunities." })] }) })] }))] }));
}
