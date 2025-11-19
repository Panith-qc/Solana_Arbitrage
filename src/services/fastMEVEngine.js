// ⚠️ MOCK SERVICE - DISABLED FOR REAL TRADING
// This service returned fake/hardcoded opportunities
// Use realTradeExecutor for actual Solana trades
export const fastMEVEngine = {
    async scanForMEVOpportunities() {
        console.warn('⚠️ fastMEVEngine is DISABLED - this was a mock service');
        console.warn('⚠️ For REAL trading, opportunity detection should use live market data');
        // Return empty array instead of fake data
        return [];
    },
    async executeArbitrage(opportunity, priorityFeeSol) {
        console.error('❌ fastMEVEngine.executeArbitrage is DISABLED - this was a mock');
        console.error('❌ Use realTradeExecutor.executeArbitrageCycle() for REAL trades');
        return {
            success: false,
            netProfitUSD: 0,
            txSignatures: [],
            error: 'Mock service disabled - use realTradeExecutor for real trading'
        };
    }
};
