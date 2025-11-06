import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DollarSign, TrendingUp, Zap, Clock, Target, AlertTriangle, Activity } from 'lucide-react';
const RealMEVOpportunities = ({ opportunities, isScanning, onExecuteTrade, executingTradeId, autoTradingEnabled }) => {
    const getTypeIcon = (type) => {
        switch (type) {
            case 'SANDWICH': return _jsx(Target, { className: "w-4 h-4" });
            case 'ARBITRAGE': return _jsx(TrendingUp, { className: "w-4 h-4" });
            case 'LIQUIDATION': return _jsx(AlertTriangle, { className: "w-4 h-4" });
            default: return _jsx(DollarSign, { className: "w-4 h-4" });
        }
    };
    const getTypeColor = (type) => {
        switch (type) {
            case 'SANDWICH': return 'bg-purple-500/20 text-purple-400 border-purple-500/50';
            case 'ARBITRAGE': return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
            case 'LIQUIDATION': return 'bg-orange-500/20 text-orange-400 border-orange-500/50';
            default: return 'bg-gray-500/20 text-gray-400 border-gray-500/50';
        }
    };
    const getRiskColor = (risk) => {
        switch (risk) {
            case 'LOW': return 'bg-green-500/20 text-green-400 border-green-500/50';
            case 'MEDIUM': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
            case 'HIGH': return 'bg-red-500/20 text-red-400 border-red-500/50';
            default: return 'bg-gray-500/20 text-gray-400 border-gray-500/50';
        }
    };
    const formatTimeAgo = (timestamp) => {
        const seconds = Math.floor((new Date().getTime() - timestamp.getTime()) / 1000);
        if (seconds < 60)
            return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return `${minutes}m ago`;
        return timestamp.toLocaleTimeString();
    };
    // Sort opportunities by execution priority and profit
    const sortedOpportunities = [...opportunities].sort((a, b) => {
        const priorityA = a.executionPriority || 0;
        const priorityB = b.executionPriority || 0;
        if (priorityA !== priorityB)
            return priorityB - priorityA;
        return b.profitUsd - a.profitUsd;
    });
    return (_jsxs(Card, { className: "bg-black/20 border-yellow-500/30", children: [_jsxs(CardHeader, { children: [_jsxs(CardTitle, { className: "text-yellow-400 flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center", children: [_jsx(DollarSign, { className: "w-5 h-5 mr-2" }), "Real MEV Opportunities"] }), _jsxs("div", { className: "flex items-center space-x-2", children: [isScanning && (_jsxs("div", { className: "flex items-center space-x-2", children: [_jsx("div", { className: "w-2 h-2 bg-green-500 rounded-full animate-pulse" }), _jsx("span", { className: "text-sm text-green-400", children: "Live Scanning" })] })), autoTradingEnabled && (_jsxs(Badge, { className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/50", children: [_jsx(Zap, { className: "w-3 h-3 mr-1" }), "AUTO"] }))] })] }), _jsx("p", { className: "text-sm text-gray-300", children: "Real-time MEV opportunities with accurate profit calculations (NO MOCK DATA)" })] }), _jsx(CardContent, { children: sortedOpportunities.length === 0 ? (_jsxs("div", { className: "text-center py-12", children: [_jsx(TrendingUp, { className: "w-16 h-16 text-gray-500 mx-auto mb-4" }), _jsx("p", { className: "text-gray-400 text-lg mb-2", children: isScanning ?
                                '🔍 Scanning for real MEV opportunities...' :
                                '⏹️ Scanner stopped - No opportunities available' }), _jsx("p", { className: "text-sm text-gray-500 mb-4", children: "Monitoring: Sandwich, Arbitrage, and Liquidation opportunities" }), _jsxs("div", { className: "flex justify-center space-x-4 text-xs text-gray-600", children: [_jsx("span", { children: "Min Sandwich: $0.05" }), _jsx("span", { children: "Min Arbitrage: $0.02" }), _jsx("span", { children: "Min Liquidation: $0.10" })] }), _jsx("p", { className: "text-xs text-red-400 mt-4", children: "\uD83D\uDD34 NO MOCK DATA - Only real profitable opportunities appear here" })] })) : (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "grid grid-cols-4 gap-4 p-4 bg-black/30 rounded-lg border border-gray-700", children: [_jsxs("div", { className: "text-center", children: [_jsx("div", { className: "text-2xl font-bold text-green-400", children: sortedOpportunities.length }), _jsx("div", { className: "text-xs text-gray-400", children: "Total Opportunities" })] }), _jsxs("div", { className: "text-center", children: [_jsxs("div", { className: "text-2xl font-bold text-yellow-400", children: ["$", sortedOpportunities.reduce((sum, opp) => sum + opp.profitUsd, 0).toFixed(3)] }), _jsx("div", { className: "text-xs text-gray-400", children: "Total Profit Potential" })] }), _jsxs("div", { className: "text-center", children: [_jsx("div", { className: "text-2xl font-bold text-blue-400", children: sortedOpportunities.filter(opp => opp.riskLevel === 'LOW').length }), _jsx("div", { className: "text-xs text-gray-400", children: "Low Risk" })] }), _jsxs("div", { className: "text-center", children: [_jsx("div", { className: "text-2xl font-bold text-purple-400", children: sortedOpportunities.filter(opp => opp.type === 'SANDWICH').length }), _jsx("div", { className: "text-xs text-gray-400", children: "Sandwich Ops" })] })] }), _jsx("div", { className: "space-y-3 max-h-96 overflow-y-auto", children: sortedOpportunities.map((opportunity, index) => (_jsxs("div", { className: "bg-black/30 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition-colors", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center space-x-4", children: [_jsxs("div", { className: "flex items-center space-x-2", children: [getTypeIcon(opportunity.type), _jsx("span", { className: "text-white font-bold", children: opportunity.pair }), index === 0 && (_jsx(Badge, { className: "bg-gold-500/20 text-yellow-300 border-yellow-500/50 text-xs", children: "TOP" }))] }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsx(Badge, { className: `${getTypeColor(opportunity.type)} text-xs`, children: opportunity.type }), _jsx(Badge, { className: `${getRiskColor(opportunity.riskLevel)} text-xs`, children: opportunity.riskLevel }), _jsx(Badge, { className: "bg-green-500/20 text-green-400 border-green-500/50 text-xs", children: "REAL" })] })] }), _jsx(Button, { onClick: () => onExecuteTrade(opportunity), disabled: executingTradeId === opportunity.id, size: "sm", className: "bg-green-600 hover:bg-green-700 text-white", children: executingTradeId === opportunity.id ? (_jsxs(_Fragment, { children: [_jsx(Activity, { className: "w-4 h-4 mr-2 animate-spin" }), "Executing..."] })) : (_jsxs(_Fragment, { children: [_jsx(Zap, { className: "w-4 h-4 mr-2" }), "Execute Trade"] })) })] }), _jsxs("div", { className: "mt-3 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm", children: [_jsxs("div", { children: [_jsx("div", { className: "text-gray-400", children: "Profit" }), _jsxs("div", { className: "flex items-center space-x-2", children: [_jsxs("span", { className: "text-green-400 font-bold", children: ["+", opportunity.profitPercent.toFixed(3), "%"] }), _jsxs("span", { className: "text-gray-300", children: ["$", opportunity.profitUsd.toFixed(4)] })] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-gray-400", children: "Confidence" }), _jsxs("div", { className: "text-white font-medium", children: [opportunity.confidence, "%"] })] }), _jsxs("div", { children: [_jsx("div", { className: "text-gray-400", children: "Size" }), _jsxs("div", { className: "text-white", children: ["$", (opportunity.inputAmount * 245 / 1e9).toFixed(2)] })] }), _jsxs("div", { children: [_jsxs("div", { className: "text-gray-400 flex items-center", children: [_jsx(Clock, { className: "w-3 h-3 mr-1" }), "Time"] }), _jsx("div", { className: "text-white", children: formatTimeAgo(opportunity.timestamp) })] })] }), opportunity.type === 'SANDWICH' && (_jsx("div", { className: "mt-2 p-2 bg-purple-500/10 rounded border border-purple-500/30", children: _jsx("div", { className: "text-xs text-purple-300", children: "\uD83C\uDFAF Sandwich Strategy: Frontrun \u2192 Target Transaction \u2192 Backrun" }) })), opportunity.executionPriority && opportunity.executionPriority > 100 && (_jsxs("div", { className: "mt-2 flex items-center text-xs text-yellow-400", children: [_jsx(AlertTriangle, { className: "w-3 h-3 mr-1" }), "High Priority Execution Recommended"] }))] }, opportunity.id))) })] })) })] }));
};
export default RealMEVOpportunities;
