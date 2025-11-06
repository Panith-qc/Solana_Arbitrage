import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { multiAPIService } from '../services/multiAPIQuoteService';
export const APIHealthDashboard = () => {
    const [health, setHealth] = useState([]);
    const [isVisible, setIsVisible] = useState(true);
    useEffect(() => {
        // Update health every second
        const interval = setInterval(() => {
            setHealth(multiAPIService.getHealthReport());
        }, 1000);
        return () => clearInterval(interval);
    }, []);
    const getStatusColor = (status) => {
        switch (status) {
            case 'HEALTHY': return 'text-green-500';
            case 'DEGRADED': return 'text-yellow-500';
            case 'PAUSED': return 'text-orange-500';
            case 'FAILED': return 'text-red-500';
            default: return 'text-gray-500';
        }
    };
    const getStatusIcon = (status) => {
        switch (status) {
            case 'HEALTHY': return '✅';
            case 'DEGRADED': return '⚠️';
            case 'PAUSED': return '⏸️';
            case 'FAILED': return '❌';
            default: return '❓';
        }
    };
    if (!isVisible) {
        return (_jsx("button", { onClick: () => setIsVisible(true), className: "fixed bottom-4 right-4 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg hover:bg-gray-700 transition-colors z-50", children: "\uD83D\uDCE1 Show API Health" }));
    }
    return (_jsxs("div", { className: "fixed bottom-4 right-4 bg-gray-900 text-white rounded-lg shadow-2xl p-4 max-w-2xl z-50 border border-gray-700", children: [_jsxs("div", { className: "flex justify-between items-center mb-3", children: [_jsxs("h3", { className: "text-lg font-bold flex items-center gap-2", children: [_jsx("span", { className: "text-2xl", children: "\uD83D\uDCE1" }), "API Health Monitor"] }), _jsx("button", { onClick: () => setIsVisible(false), className: "text-gray-400 hover:text-white transition-colors", children: "\u2715" })] }), _jsx("div", { className: "space-y-2 max-h-96 overflow-y-auto", children: health.length === 0 ? (_jsx("div", { className: "text-gray-400 text-center py-4", children: "No API data yet..." })) : (health.map((api, index) => (_jsxs("div", { className: `p-3 rounded-lg border ${api.status === 'HEALTHY'
                        ? 'bg-green-900/20 border-green-700/50'
                        : api.status === 'DEGRADED'
                            ? 'bg-yellow-900/20 border-yellow-700/50'
                            : api.status === 'PAUSED'
                                ? 'bg-orange-900/20 border-orange-700/50'
                                : 'bg-red-900/20 border-red-700/50'}`, children: [_jsxs("div", { className: "flex justify-between items-start mb-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "text-xl", children: getStatusIcon(api.status) }), _jsx("span", { className: "font-semibold", children: api.name })] }), _jsx("span", { className: `text-sm font-bold ${getStatusColor(api.status)}`, children: api.status })] }), _jsxs("div", { className: "grid grid-cols-2 gap-2 text-sm", children: [_jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Success Rate:" }), _jsx("span", { className: "ml-2 font-mono text-green-400", children: api.successRate })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Avg Latency:" }), _jsx("span", { className: "ml-2 font-mono text-blue-400", children: api.avgLatency })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Calls:" }), _jsxs("span", { className: "ml-2 font-mono text-purple-400", children: [api.successfulCalls, "/", api.totalCalls] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-gray-400", children: "Rate Limit:" }), _jsx("span", { className: "ml-2 font-mono text-orange-400", children: api.callsThisMinute })] })] }), api.consecutiveFailures > 0 && (_jsxs("div", { className: "mt-2 text-xs text-red-400", children: ["\u26A0\uFE0F ", api.consecutiveFailures, " consecutive failures"] })), api.pauseRemaining && (_jsxs("div", { className: "mt-2 text-xs text-orange-400", children: ["\u23F8\uFE0F Paused for ", api.pauseRemaining] })), api.lastError && api.status !== 'HEALTHY' && (_jsxs("div", { className: "mt-2 text-xs text-gray-400 truncate", title: api.lastError, children: ["Last error: ", api.lastError] }))] }, index)))) }), _jsx("div", { className: "mt-3 pt-3 border-t border-gray-700 text-xs text-gray-400", children: "Updates every 1 second \u2022 Best API auto-selected" })] }));
};
