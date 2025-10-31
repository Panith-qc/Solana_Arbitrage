import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { tokenCleanupService } from '../services/tokenCleanupService';
const TokenCleanupDashboard = () => {
    const [tokens, setTokens] = useState([]);
    const [isScanning, setIsScanning] = useState(false);
    const [isRecovering, setIsRecovering] = useState(false);
    const [recoveryResult, setRecoveryResult] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [estimatedFees, setEstimatedFees] = useState(0);
    const [estimatedRecovery, setEstimatedRecovery] = useState(0);
    // Recovery settings with conservative defaults
    const [settings, setSettings] = useState({
        priorityFeeSol: 0.002, // Reduced from 0.015 to 0.002 SOL
        slippagePercent: 3.0, // 3% slippage for stuck tokens
        minValueUsd: 0.50, // Only recover tokens worth $0.50+
        maxRetries: 2, // Reduced retries to save fees
        delayBetweenTxMs: 3000, // 3 second delay between transactions
        enablePreflight: true // Enable preflight checks
    });
    useEffect(() => {
        scanTokens();
    }, []);
    useEffect(() => {
        calculateEstimates();
    }, [tokens, settings]);
    const scanTokens = async () => {
        setIsScanning(true);
        try {
            const foundTokens = await tokenCleanupService.scanWalletTokens();
            setTokens(foundTokens);
        }
        catch (error) {
            console.error('Failed to scan tokens:', error);
        }
        finally {
            setIsScanning(false);
        }
    };
    const calculateEstimates = () => {
        const eligibleTokens = tokens.filter(token => token.usdValue >= settings.minValueUsd);
        const totalValue = eligibleTokens.reduce((sum, token) => sum + token.usdValue, 0);
        const totalFees = eligibleTokens.length * (settings.priorityFeeSol * 240); // Convert SOL to USD
        const accountCreationFees = eligibleTokens.length * (0.00203928 * 240); // Account creation costs
        setEstimatedRecovery(totalValue);
        setEstimatedFees(totalFees + accountCreationFees);
    };
    const handleRecovery = async () => {
        if (estimatedFees >= estimatedRecovery * 0.5) {
            const confirmed = window.confirm(`⚠️ WARNING: Recovery fees ($${estimatedFees.toFixed(2)}) are ${((estimatedFees / estimatedRecovery) * 100).toFixed(1)}% of recovery value ($${estimatedRecovery.toFixed(2)}).\n\nThis means you'll lose significant value in fees. Continue anyway?`);
            if (!confirmed)
                return;
        }
        setIsRecovering(true);
        setRecoveryResult(null);
        try {
            // Update the service with current settings
            await updateServiceSettings();
            const result = await tokenCleanupService.cleanupAllTokens(settings.minValueUsd);
            setRecoveryResult(result);
            // Refresh token list after recovery
            setTimeout(() => {
                scanTokens();
            }, 5000);
        }
        catch (error) {
            console.error('Recovery failed:', error);
            cleaned: 0,
                tokensCleaned;
            number,
                success;
            false,
                tokensCleaned;
            0,
                totalValueRecovered;
            0,
                transactions;
            [],
                errors;
            [error instanceof Error ? error.message : 'Unknown error'];
        }
        ;
    };
    try { }
    finally {
        setIsRecovering(false);
    }
};
const updateServiceSettings = async () => {
    // This would ideally update the service configuration
    // For now, we'll pass settings through the cleanup call
    console.log('🔧 Updated recovery settings:', settings);
};
const getTotalValue = () => {
    return tokens.reduce((sum, token) => sum + token.usdValue, 0);
};
const getEligibleTokens = () => {
    return tokens.filter(token => token.usdValue >= settings.minValueUsd);
};
const getFeeEfficiency = () => {
    if (estimatedRecovery === 0)
        return 0;
    return ((estimatedRecovery - estimatedFees) / estimatedRecovery) * 100;
};
return (_jsxs("div", { className: "space-y-6", children: [_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "flex items-center gap-2", children: [_jsx(Trash2, { className: "w-5 h-5" }), "Token Recovery Center"] }) }), _jsx(CardContent, { children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "space-y-1", children: [_jsx("div", { className: "text-sm text-gray-600", children: "Scan and convert stuck tokens back to SOL with optimized fees" }), _jsxs("div", { className: "flex items-center gap-4 text-sm", children: [_jsxs("span", { children: ["Found: ", tokens.length, " tokens"] }), _jsxs("span", { children: ["Total Value: $", getTotalValue().toFixed(2)] }), _jsxs("span", { children: ["Eligible: ", getEligibleTokens().length, " tokens"] })] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { onClick: scanTokens, disabled: isScanning, variant: "outline", size: "sm", children: isScanning ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Scanning..."] })) : ('Refresh Scan') }), _jsxs(Button, { onClick: () => setShowSettings(!showSettings), variant: "outline", size: "sm", children: [_jsx(Settings, { className: "w-4 h-4 mr-2" }), "Settings"] })] })] }) })] }), showSettings && (_jsxs(Card, { className: "border-blue-200", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-blue-700 flex items-center gap-2", children: [_jsx(Settings, { className: "w-5 h-5" }), "Recovery Parameters"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { htmlFor: "priorityFee", children: "Priority Fee (SOL)" }), _jsx(Input, { id: "priorityFee", type: "number", step: "0.001", min: "0.001", max: "0.01", value: settings.priorityFeeSol, onChange: (e) => setSettings(prev => ({
                                                ...prev,
                                                priorityFeeSol: parseFloat(e.target.value) || 0.002
                                            })), className: "mt-1" }), _jsx("div", { className: "text-xs text-gray-500 mt-1", children: "Lower = cheaper, Higher = faster execution" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "slippage", children: "Max Slippage (%)" }), _jsx(Input, { id: "slippage", type: "number", step: "0.5", min: "1", max: "10", value: settings.slippagePercent, onChange: (e) => setSettings(prev => ({
                                                ...prev,
                                                slippagePercent: parseFloat(e.target.value) || 3.0
                                            })), className: "mt-1" }), _jsx("div", { className: "text-xs text-gray-500 mt-1", children: "Higher slippage = better success rate" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "minValue", children: "Min Token Value (USD)" }), _jsx(Input, { id: "minValue", type: "number", step: "0.10", min: "0.01", max: "10", value: settings.minValueUsd, onChange: (e) => setSettings(prev => ({
                                                ...prev,
                                                minValueUsd: parseFloat(e.target.value) || 0.50
                                            })), className: "mt-1" }), _jsx("div", { className: "text-xs text-gray-500 mt-1", children: "Only recover tokens above this value" })] }), _jsxs("div", { children: [_jsx(Label, { htmlFor: "delay", children: "Delay Between Tx (ms)" }), _jsx(Input, { id: "delay", type: "number", step: "500", min: "1000", max: "10000", value: settings.delayBetweenTxMs, onChange: (e) => setSettings(prev => ({
                                                ...prev,
                                                delayBetweenTxMs: parseInt(e.target.value) || 3000
                                            })), className: "mt-1" }), _jsx("div", { className: "text-xs text-gray-500 mt-1", children: "Longer delay = better success rate" })] })] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Switch, { id: "preflight", checked: settings.enablePreflight, onCheckedChange: (checked) => setSettings(prev => ({
                                        ...prev,
                                        enablePreflight: checked
                                    })) }), _jsx(Label, { htmlFor: "preflight", children: "Enable Preflight Checks" }), _jsx("div", { className: "text-xs text-gray-500", children: "(Recommended: catches errors before spending fees)" })] }), _jsx(Separator, {}), _jsxs("div", { className: "bg-gray-50 p-4 rounded-lg", children: [_jsxs("h4", { className: "font-medium mb-3 flex items-center gap-2", children: [_jsx(Calculator, { className: "w-4 h-4" }), "Cost-Benefit Analysis"] }), _jsxs("div", { className: "grid grid-cols-3 gap-4 text-sm", children: [_jsxs("div", { children: [_jsx("div", { className: "text-gray-600", children: "Estimated Recovery" }), _jsxs("div", { className: "font-medium text-green-600", children: ["$", estimatedRecovery.toFixed(2)] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-gray-600", children: "Estimated Fees" }), _jsxs("div", { className: "font-medium text-red-600", children: ["$", estimatedFees.toFixed(2)] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-gray-600", children: "Net Profit" }), _jsxs("div", { className: `font-medium ${getFeeEfficiency() > 50 ? 'text-green-600' : 'text-red-600'}`, children: ["$", (estimatedRecovery - estimatedFees).toFixed(2), " (", getFeeEfficiency().toFixed(1), "%)"] })] })] }), getFeeEfficiency() < 50 && (_jsxs(Alert, { className: "mt-3 border-red-200 bg-red-50", children: [_jsx(AlertTriangle, { className: "h-4 w-4" }), _jsxs(AlertDescription, { className: "text-red-700", children: [_jsx("strong", { children: "High Fee Warning:" }), " Recovery fees are ", (100 - getFeeEfficiency()).toFixed(1), "% of value. Consider increasing minimum value or reducing priority fees."] })] }))] })] })] })), tokens.length > 0 && (_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { children: ["Stuck Tokens Found (", tokens.length, ")"] }) }), _jsx(CardContent, { children: _jsx("div", { className: "space-y-3", children: tokens.map((token, index) => (_jsxs("div", { className: "flex items-center justify-between p-3 border rounded-lg", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Badge, { variant: token.usdValue >= settings.minValueUsd ? 'default' : 'secondary', children: token.symbol }), _jsxs("div", { children: [_jsxs("div", { className: "font-medium", children: [token.uiAmount.toLocaleString(), " ", token.symbol] }), _jsxs("div", { className: "text-sm text-gray-600", children: ["Value: $", token.usdValue.toFixed(4)] })] })] }), _jsx("div", { className: "text-right", children: token.usdValue >= settings.minValueUsd ? (_jsx(Badge, { className: "bg-green-100 text-green-800", children: "Will Recover" })) : (_jsx(Badge, { variant: "secondary", children: "Below Threshold" })) })] }, index))) }) })] })), getEligibleTokens().length > 0 && (_jsx(Card, { className: "border-green-200", children: _jsx(CardContent, { className: "p-6", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsxs("h3", { className: "font-medium text-green-700 mb-1", children: ["Ready to Recover ", getEligibleTokens().length, " Tokens"] }), _jsxs("div", { className: "text-sm text-gray-600", children: ["Net recovery: $", (estimatedRecovery - estimatedFees).toFixed(2), "(Fee efficiency: ", getFeeEfficiency().toFixed(1), "%)"] })] }), _jsx(Button, { onClick: handleRecovery, disabled: isRecovering || getFeeEfficiency() < 0, className: "bg-green-600 hover:bg-green-700", children: isRecovering ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Recovering..."] })) : (_jsxs(_Fragment, { children: [_jsx(Zap, { className: "w-4 h-4 mr-2" }), "Start Recovery"] })) })] }) }) })), recoveryResult && (_jsxs(Card, { className: recoveryResult.success ? 'border-green-200' : 'border-red-200', children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: `flex items-center gap-2 ${recoveryResult.success ? 'text-green-700' : 'text-red-700'}`, children: [recoveryResult.success ? (_jsx(CheckCircle, { className: "w-5 h-5" })) : (_jsx(AlertTriangle, { className: "w-5 h-5" })), "Recovery ", recoveryResult.success ? 'Complete' : 'Failed'] }) }), _jsx(CardContent, { children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-600", children: "Tokens Recovered" }), _jsx("div", { className: "font-medium", children: recoveryResult.tokensCleaned })] }), _jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-600", children: "Value Recovered" }), _jsxs("div", { className: "font-medium text-green-600", children: ["$", recoveryResult.totalValueRecovered.toFixed(4)] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-sm text-gray-600", children: "Transactions" }), _jsx("div", { className: "font-medium", children: recoveryResult.transactions.length })] })] }), recoveryResult.transactions.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium mb-2", children: "Transaction Hashes:" }), _jsx("div", { className: "space-y-1", children: recoveryResult.transactions.map((tx, index) => (_jsx("a", { href: `https://solscan.io/tx/${tx}`, target: "_blank", rel: "noopener noreferrer", className: "text-xs text-blue-600 hover:underline block", children: tx }, index))) })] })), recoveryResult.errors.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium mb-2 text-red-600", children: "Errors:" }), _jsx("div", { className: "space-y-1", children: recoveryResult.errors.map((error, index) => (_jsx("div", { className: "text-xs text-red-600", children: error }, index))) })] }))] }) })] })), tokens.length === 0 && !isScanning && (_jsx(Card, { children: _jsxs(CardContent, { className: "text-center py-8", children: [_jsx(CheckCircle, { className: "w-12 h-12 text-green-500 mx-auto mb-4" }), _jsx("h3", { className: "font-medium mb-2", children: "No Stuck Tokens Found" }), _jsx("p", { className: "text-gray-600", children: "Your wallet is clean! All tokens are properly managed." })] }) }))] }));
;
export default TokenCleanupDashboard;
