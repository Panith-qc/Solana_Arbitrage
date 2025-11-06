// CAPITAL OPTIMIZER - SMART CAPITAL ALLOCATION FOR MEV TRADING
// Optimizes trade sizes based on available capital and risk tolerance
class CapitalOptimizer {
    constructor() {
        Object.defineProperty(this, "active", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        }); // Changed from isActive to active to avoid conflict
        Object.defineProperty(this, "strategies", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                'MICRO_MEV': {
                    strategy: 'MICRO_MEV',
                    maxTradeSize: 0.1,
                    focusAreas: ['Micro Arbitrage', 'Low Risk Opportunities'],
                    riskLevel: 'LOW',
                    recommendedMinProfit: 0.0001
                },
                'SMALL_CAPITAL': {
                    strategy: 'SMALL_CAPITAL',
                    maxTradeSize: 0.5,
                    focusAreas: ['Arbitrage', 'Price Recovery'],
                    riskLevel: 'MEDIUM',
                    recommendedMinProfit: 0.001
                },
                'MEDIUM_CAPITAL': {
                    strategy: 'MEDIUM_CAPITAL',
                    maxTradeSize: 2.0,
                    focusAreas: ['Sandwich', 'Arbitrage', 'Liquidations'],
                    riskLevel: 'MEDIUM',
                    recommendedMinProfit: 0.01
                },
                'HIGH_CAPITAL': {
                    strategy: 'HIGH_CAPITAL',
                    maxTradeSize: 10.0,
                    focusAreas: ['Advanced Sandwich', 'Large Arbitrage', 'MEV Bundles'],
                    riskLevel: 'HIGH',
                    recommendedMinProfit: 0.1
                }
            }
        });
    }
    async start() {
        console.log('🚀 STARTING CAPITAL OPTIMIZER...');
        this.active = true;
        console.log('✅ CAPITAL OPTIMIZER ACTIVE');
    }
    async stop() {
        console.log('🛑 STOPPING CAPITAL OPTIMIZER...');
        this.active = false;
        console.log('✅ CAPITAL OPTIMIZER STOPPED');
    }
    getOptimalStrategy(availableCapital) {
        if (availableCapital <= 0.5) {
            return this.strategies['MICRO_MEV'];
        }
        else if (availableCapital <= 2.0) {
            return this.strategies['SMALL_CAPITAL'];
        }
        else if (availableCapital <= 10.0) {
            return this.strategies['MEDIUM_CAPITAL'];
        }
        else {
            return this.strategies['HIGH_CAPITAL'];
        }
    }
    recommendTradeSize(availableCapital, expectedProfit, riskLevel) {
        const strategy = this.getOptimalStrategy(availableCapital);
        // Calculate safe trade size (max 20% of available capital)
        const maxSafeSize = Math.min(strategy.maxTradeSize, availableCapital * 0.2);
        // Risk-adjusted sizing
        const riskMultiplier = riskLevel === 'LOW' ? 1.0 : riskLevel === 'MEDIUM' ? 0.7 : 0.4;
        const recommendedSize = maxSafeSize * riskMultiplier;
        // Check if trade meets minimum profit threshold
        const meetsMinProfit = expectedProfit >= strategy.recommendedMinProfit;
        // Check if we have enough capital
        const hasCapital = availableCapital >= recommendedSize;
        if (!meetsMinProfit) {
            return {
                canTrade: false,
                recommendedSize: 0,
                reason: `Profit $${(expectedProfit != null && !isNaN(expectedProfit) && typeof expectedProfit === 'number' ? expectedProfit.toFixed(6) : '0.000000')} below minimum $${(strategy.recommendedMinProfit != null && !isNaN(strategy.recommendedMinProfit) && typeof strategy.recommendedMinProfit === 'number' ? strategy.recommendedMinProfit.toFixed(6) : '0.000000')}`,
                confidence: 0
            };
        }
        if (!hasCapital) {
            return {
                canTrade: false,
                recommendedSize: 0,
                reason: `Insufficient capital: need ${(recommendedSize != null && !isNaN(recommendedSize) && typeof recommendedSize === 'number' ? recommendedSize.toFixed(3) : '0.000')} SOL, have ${(availableCapital != null && !isNaN(availableCapital) && typeof availableCapital === 'number' ? availableCapital.toFixed(3) : '0.000')} SOL`,
                confidence: 0
            };
        }
        // Calculate confidence based on profit-to-risk ratio
        const profitRatio = expectedProfit / recommendedSize;
        const confidence = Math.min(95, Math.max(10, profitRatio * 1000));
        return {
            canTrade: true,
            recommendedSize,
            reason: `Safe trade size for ${strategy.strategy} strategy`,
            confidence
        };
    }
    isActive() {
        return this.active; // Fixed: now returns the correct property
    }
}
export const capitalOptimizer = new CapitalOptimizer();
