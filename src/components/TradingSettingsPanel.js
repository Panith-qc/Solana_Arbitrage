import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// COMPREHENSIVE TRADING SETTINGS PANEL
// All parameters configurable through UI
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Settings, DollarSign, Clock, Shield, Zap, RefreshCw, AlertTriangle, CheckCircle, Save, RotateCcw } from 'lucide-react';
import { tradingConfigManager } from '../config/tradingConfig';
const TradingSettingsPanel = ({ onClose }) => {
    const [config, setConfig] = useState(tradingConfigManager.getConfig());
    const [hasChanges, setHasChanges] = useState(false);
    const [validationErrors, setValidationErrors] = useState([]);
    const [prices, setPrices] = useState({});
    useEffect(() => {
        // Subscribe to config changes
        const unsubscribe = tradingConfigManager.subscribe((newConfig) => {
            setConfig(newConfig);
        });
        // Update prices periodically
        const priceInterval = setInterval(() => {
            setPrices({});
        }, 5000);
        return () => {
            unsubscribe();
            clearInterval(priceInterval);
        };
    }, []);
    const updateConfig = (updates) => {
        const newConfig = { ...config, ...updates };
        setConfig(newConfig);
        setHasChanges(true);
        // Validate
        const validation = tradingConfigManager.validateConfig();
        setValidationErrors(validation.errors);
    };
    const updateSection = (section, updates) => {
        const newConfig = {
            ...config,
            [section]: { ...config[section], ...updates }
        };
        setConfig(newConfig);
        setHasChanges(true);
    };
    const saveChanges = () => {
        const validation = tradingConfigManager.validateConfig();
        if (!validation.isValid) {
            setValidationErrors(validation.errors);
            return;
        }
        tradingConfigManager.updateConfig(config);
        setHasChanges(false);
        setValidationErrors([]);
        console.log('✅ Trading settings saved');
    };
    const resetToDefaults = () => {
        tradingConfigManager.resetToDefaults();
        setHasChanges(false);
        setValidationErrors([]);
    };
    const formatPrice = (price) => {
        if (price < 0.001)
            return price.toFixed(8);
        if (price < 1)
            return price.toFixed(6);
        return price.toFixed(2);
    };
    return (_jsx("div", { className: "fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4", children: _jsxs(Card, { className: "w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-black/90 border-purple-500/30", children: [_jsx(CardHeader, { children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs(CardTitle, { className: "text-purple-400 flex items-center", children: [_jsx(Settings, { className: "w-5 h-5 mr-2" }), "Trading Settings"] }), _jsxs("div", { className: "flex items-center space-x-2", children: [hasChanges && (_jsx(Badge, { className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/50", children: "Unsaved Changes" })), _jsx(Button, { onClick: onClose, variant: "outline", size: "sm", children: "Close" })] })] }) }), _jsxs(CardContent, { children: [_jsxs(Tabs, { defaultValue: "trading", className: "space-y-6", children: [_jsxs(TabsList, { className: "grid w-full grid-cols-5", children: [_jsx(TabsTrigger, { value: "trading", children: "Trading" }), _jsx(TabsTrigger, { value: "prices", children: "Prices" }), _jsx(TabsTrigger, { value: "scanner", children: "Scanner" }), _jsx(TabsTrigger, { value: "risk", children: "Risk" }), _jsx(TabsTrigger, { value: "apis", children: "APIs" })] }), _jsx(TabsContent, { value: "trading", className: "space-y-4", children: _jsxs(Card, { className: "bg-black/20 border-green-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-green-400 flex items-center", children: [_jsx(DollarSign, { className: "w-4 h-4 mr-2" }), "Trading Parameters"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Min Profit (USD)" }), _jsx("input", { type: "number", step: "0.0001", value: config.trading.minProfitUsd, onChange: (e) => updateSection('trading', {
                                                                            minProfitUsd: parseFloat(e.target.value) || 0.0001
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Position (SOL)" }), _jsx("input", { type: "number", step: "0.01", value: config.trading.maxPositionSol, onChange: (e) => updateSection('trading', {
                                                                            maxPositionSol: parseFloat(e.target.value) || 0.1
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Slippage (Basis Points)" }), _jsxs("div", { className: "mt-2", children: [_jsx(Slider, { value: [config.trading.slippageBps], onValueChange: ([value]) => updateSection('trading', { slippageBps: value }), min: 1, max: 500, step: 1, className: "w-full" }), _jsxs("div", { className: "text-sm text-gray-400 mt-1", children: [config.trading.slippageBps, " BPS (", (config.trading.slippageBps / 100).toFixed(2), "%)"] })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Priority Fee (Lamports)" }), _jsx("input", { type: "number", step: "1000", value: config.trading.priorityFeeLamports, onChange: (e) => updateSection('trading', {
                                                                            priorityFeeLamports: parseInt(e.target.value) || 200000
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" }), _jsxs("div", { className: "text-sm text-gray-400 mt-1", children: ["~", (config.trading.priorityFeeLamports / 1e9).toFixed(6), " SOL"] })] })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { className: "text-white", children: "Auto Trading" }), _jsx(Switch, { checked: config.trading.autoTradingEnabled, onCheckedChange: (checked) => updateSection('trading', { autoTradingEnabled: checked }) })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { className: "text-white", children: "Enable Arbitrage" }), _jsx(Switch, { checked: config.trading.enableArbitrage, onCheckedChange: (checked) => updateSection('trading', { enableArbitrage: checked }) })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { className: "text-white", children: "Enable Micro MEV" }), _jsx(Switch, { checked: config.trading.enableMicroMev, onCheckedChange: (checked) => updateSection('trading', { enableMicroMev: checked }) })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { className: "text-white", children: "Enable Sandwich" }), _jsx(Switch, { checked: config.trading.enableSandwich, onCheckedChange: (checked) => updateSection('trading', { enableSandwich: checked }) })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { className: "text-white", children: "Enable Liquidation" }), _jsx(Switch, { checked: config.trading.enableLiquidation, onCheckedChange: (checked) => updateSection('trading', { enableLiquidation: checked }) })] })] })] })] })] }) }), _jsx(TabsContent, { value: "prices", className: "space-y-4", children: _jsxs(Card, { className: "bg-black/20 border-blue-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-blue-400 flex items-center", children: [_jsx(RefreshCw, { className: "w-4 h-4 mr-2" }), "Price Configuration"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Price Refresh Interval (ms)" }), _jsx("input", { type: "number", step: "1000", value: config.prices.refreshIntervalMs, onChange: (e) => updateSection('prices', {
                                                                            refreshIntervalMs: parseInt(e.target.value) || 30000
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" }), _jsxs("div", { className: "text-sm text-gray-400 mt-1", children: [(config.prices.refreshIntervalMs / 1000).toFixed(0), " seconds"] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Price Age (ms)" }), _jsx("input", { type: "number", step: "1000", value: config.prices.maxPriceAgeMs, onChange: (e) => updateSection('prices', {
                                                                            maxPriceAgeMs: parseInt(e.target.value) || 60000
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" }), _jsxs("div", { className: "text-sm text-gray-400 mt-1", children: [(config.prices.maxPriceAgeMs / 1000).toFixed(0), " seconds"] })] })] }), _jsxs("div", { className: "space-y-3", children: [_jsx(Label, { className: "text-white", children: "Current Prices" }), _jsx("div", { className: "grid grid-cols-3 gap-3", children: Object.entries(config.tokens).map(([symbol, mint]) => {
                                                                    const priceData = prices[mint];
                                                                    const isStale = priceData ?
                                                                        (Date.now() - priceData.timestamp) > config.prices.maxPriceAgeMs :
                                                                        true;
                                                                    return (_jsxs("div", { className: "bg-black/30 rounded p-3 border border-gray-700", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("span", { className: "text-white font-medium", children: symbol }), isStale ? (_jsx(AlertTriangle, { className: "w-4 h-4 text-yellow-400" })) : (_jsx(CheckCircle, { className: "w-4 h-4 text-green-400" }))] }), _jsxs("div", { className: "text-sm text-gray-300", children: ["$", priceData ? formatPrice(priceData.price) : 'N/A'] }), priceData && (_jsx("div", { className: "text-xs text-gray-400", children: new Date(priceData.timestamp).toLocaleTimeString() }))] }, symbol));
                                                                }) })] })] })] }) }), _jsx(TabsContent, { value: "scanner", className: "space-y-4", children: _jsxs(Card, { className: "bg-black/20 border-yellow-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-yellow-400 flex items-center", children: [_jsx(Clock, { className: "w-4 h-4 mr-2" }), "Scanner Configuration"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Scan Interval (ms)" }), _jsx("input", { type: "number", step: "100", value: config.scanner.scanIntervalMs, onChange: (e) => updateSection('scanner', {
                                                                            scanIntervalMs: parseInt(e.target.value) || 1200
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Token Check Delay (ms)" }), _jsx("input", { type: "number", step: "50", value: config.scanner.tokenCheckDelayMs, onChange: (e) => updateSection('scanner', {
                                                                            tokenCheckDelayMs: parseInt(e.target.value) || 200
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Circuit Breaker Threshold" }), _jsx("input", { type: "number", step: "1", value: config.scanner.circuitBreakerFailureThreshold, onChange: (e) => updateSection('scanner', {
                                                                            circuitBreakerFailureThreshold: parseInt(e.target.value) || 5
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Recovery Timeout (ms)" }), _jsx("input", { type: "number", step: "1000", value: config.scanner.circuitBreakerRecoveryTimeoutMs, onChange: (e) => updateSection('scanner', {
                                                                            circuitBreakerRecoveryTimeoutMs: parseInt(e.target.value) || 30000
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Opportunities" }), _jsx("input", { type: "number", step: "1", value: config.scanner.maxOpportunities, onChange: (e) => updateSection('scanner', {
                                                                            maxOpportunities: parseInt(e.target.value) || 10
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Profit Capture Rate" }), _jsxs("div", { className: "mt-2", children: [_jsx(Slider, { value: [config.scanner.profitCaptureRate * 100], onValueChange: ([value]) => updateSection('scanner', { profitCaptureRate: value / 100 }), min: 10, max: 100, step: 5, className: "w-full" }), _jsxs("div", { className: "text-sm text-gray-400 mt-1", children: [(config.scanner.profitCaptureRate * 100).toFixed(0), "%"] })] })] })] })] })] }) }), _jsx(TabsContent, { value: "risk", className: "space-y-4", children: _jsxs(Card, { className: "bg-black/20 border-red-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-red-400 flex items-center", children: [_jsx(Shield, { className: "w-4 h-4 mr-2" }), "Risk Management"] }) }), _jsxs(CardContent, { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Trade Amount (SOL)" }), _jsx("input", { type: "number", step: "0.1", value: config.risk.maxTradeAmountSol, onChange: (e) => updateSection('risk', {
                                                                            maxTradeAmountSol: parseFloat(e.target.value) || 1.0
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Daily Loss (SOL)" }), _jsx("input", { type: "number", step: "0.01", value: config.risk.maxDailyLossSol, onChange: (e) => updateSection('risk', {
                                                                            maxDailyLossSol: parseFloat(e.target.value) || 0.1
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Stop Loss (%)" }), _jsx("input", { type: "number", step: "0.1", value: config.risk.stopLossPercent, onChange: (e) => updateSection('risk', {
                                                                            stopLossPercent: parseFloat(e.target.value) || 5.0
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Max Concurrent Trades" }), _jsx("input", { type: "number", step: "1", value: config.risk.maxConcurrentTrades, onChange: (e) => updateSection('risk', {
                                                                            maxConcurrentTrades: parseInt(e.target.value) || 3
                                                                        }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Cooldown Between Trades (ms)" }), _jsx("input", { type: "number", step: "1000", value: config.risk.cooldownBetweenTradesMs, onChange: (e) => updateSection('risk', {
                                                                    cooldownBetweenTradesMs: parseInt(e.target.value) || 5000
                                                                }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" }), _jsxs("div", { className: "text-sm text-gray-400 mt-1", children: [(config.risk.cooldownBetweenTradesMs / 1000).toFixed(0), " seconds"] })] })] })] }) }), _jsx(TabsContent, { value: "apis", className: "space-y-4", children: _jsxs(Card, { className: "bg-black/20 border-purple-500/30", children: [_jsx(CardHeader, { children: _jsxs(CardTitle, { className: "text-purple-400 flex items-center", children: [_jsx(Zap, { className: "w-4 h-4 mr-2" }), "API Configuration"] }) }), _jsx(CardContent, { className: "space-y-4", children: _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Jupiter Quote API" }), _jsx("input", { type: "url", value: config.apis.jupiterQuote, onChange: (e) => updateSection('apis', { jupiterQuote: e.target.value }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Jupiter Swap API" }), _jsx("input", { type: "url", value: config.apis.jupiterSwap, onChange: (e) => updateSection('apis', { jupiterSwap: e.target.value }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Jupiter Price API" }), _jsx("input", { type: "url", value: config.apis.jupiterPrice, onChange: (e) => updateSection('apis', { jupiterPrice: e.target.value }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-white", children: "Solscan Base URL" }), _jsx("input", { type: "url", value: config.apis.solscanBase, onChange: (e) => updateSection('apis', { solscanBase: e.target.value }), className: "w-full mt-1 px-3 py-2 bg-black/30 border border-gray-600 rounded text-white" })] })] }) })] }) })] }), validationErrors.length > 0 && (_jsxs(Alert, { className: "border-red-500/50 bg-red-500/10", children: [_jsx(AlertTriangle, { className: "h-4 w-4" }), _jsxs(AlertDescription, { className: "text-red-400", children: [_jsx("strong", { children: "Configuration Errors:" }), _jsx("ul", { className: "mt-2 space-y-1", children: validationErrors.map((error, index) => (_jsxs("li", { children: ["\u2022 ", error] }, index))) })] })] })), _jsxs("div", { className: "flex items-center justify-between pt-4 border-t border-gray-700", children: [_jsxs(Button, { onClick: resetToDefaults, variant: "outline", className: "border-red-500/50 text-red-400 hover:bg-red-500/20", children: [_jsx(RotateCcw, { className: "w-4 h-4 mr-2" }), "Reset to Defaults"] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Button, { onClick: onClose, variant: "outline", children: "Cancel" }), _jsxs(Button, { onClick: saveChanges, disabled: !hasChanges || validationErrors.length > 0, className: "bg-green-600 hover:bg-green-700", children: [_jsx(Save, { className: "w-4 h-4 mr-2" }), "Save Changes"] })] })] })] })] }) }));
};
export default TradingSettingsPanel;
