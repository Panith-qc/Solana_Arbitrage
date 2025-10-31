// TRADING CONFIGURATION - CENTRALIZED SETTINGS
// All trading parameters, token addresses, and API endpoints
// UPDATED: Optimized for 10 SOL capital with no artificial limitations
// ENHANCED CONFIGURATION - OPTIMIZED FOR 10 SOL CAPITAL
export const DEFAULT_TRADING_CONFIG = {
    prices: {
        solUsd: 0, // Will be fetched dynamically
        jupUsd: 0,
        bonkUsd: 0,
        wifUsd: 0,
        usdcUsd: 1.0,
        refreshIntervalMs: 30000, // 30 seconds
        maxPriceAgeMs: 60000, // 1 minute
    },
    trading: {
        // ENHANCED: Meaningful profit thresholds for 10 SOL capital
        minProfitUsd: 0.005, // $0.005 minimum (capture more opportunities)
        maxPositionSol: 5.0, // Use up to 50% of capital per trade (5 SOL)
        slippageBps: 100, // 1.0% slippage for better execution
        priorityFeeLamports: 500000, // Higher priority for faster execution
        autoTradingEnabled: true, // Enable auto-trading by default
        riskLevel: 'MEDIUM', // Balanced risk for better returns
        enableSandwich: true, // Enable all strategies
        enableArbitrage: true,
        enableLiquidation: true,
        enableMicroMev: true,
    },
    scanner: {
        scanIntervalMs: 5000, // OPTIMAL: 5 seconds = 120 calls/min (20% under 150 limit)
        circuitBreakerFailureThreshold: 5,
        circuitBreakerRecoveryTimeoutMs: 30000, // 30 seconds
        maxOpportunities: 5, // Allow more opportunities
        tokenCheckDelayMs: 0, // OPTIMIZED: No delay - batching handles everything
        profitCaptureRate: 0.8, // 80% profit capture rate
    },
    tokens: {
        SOL: 'So11111111111111111111111111111111111111112',
        USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    },
    apis: {
        // Use Jupiter Ultra V1 base for quotes (GET /ultra/v1/order)
        jupiterQuote: 'https://lite-api.jup.ag/ultra/v1',
        // Legacy V6 swap endpoint (POST /v6/swap) - proxy via backend
        jupiterSwap: 'https://lite-api.jup.ag/v6/swap',
        // Price V3 endpoint base (GET /price/v3/price)
        jupiterPrice: 'https://lite-api.jup.ag/price/v3',
        solscanBase: 'https://solscan.io',
        corsProxies: [
            'https://api.allorigins.win/raw?url=',
            'https://cors-anywhere.herokuapp.com/',
            'https://thingproxy.freeboard.io/fetch/',
            'https://api.codetabs.com/v1/proxy?quest='
        ],
    },
    risk: {
        // ENHANCED: Risk management optimized for 10 SOL capital
        maxTradeAmountSol: 8.0, // Allow up to 80% of capital (8 SOL)
        maxDailyLossSol: 2.0, // 20% daily loss limit (2 SOL)
        stopLossPercent: 3.0, // Tighter stop loss for capital preservation
        maxConcurrentTrades: 5, // Multiple simultaneous trades
        cooldownBetweenTradesMs: 1000, // 1 second cooldown for faster execution
    },
};
// Configuration manager class
class TradingConfigManager {
    constructor() {
        Object.defineProperty(this, "config", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "listeners", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        this.config = this.loadConfig();
        console.log('🚀 TRADING CONFIG INITIALIZED - 10 SOL CAPITAL OPTIMIZED');
        console.log(`📊 Max Trade Size: ${this.config.risk.maxTradeAmountSol} SOL`);
        console.log(`💰 Min Profit: $${this.config.trading.minProfitUsd}`);
        console.log(`🤖 Auto-Trading: ${this.config.trading.autoTradingEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
    loadConfig() {
        try {
            const saved = localStorage.getItem('trading_config');
            if (saved) {
                const parsed = JSON.parse(saved);
                // Deep-merge nested sections to preserve new defaults
                const mergedConfig = {
                    ...DEFAULT_TRADING_CONFIG,
                    ...parsed,
                    prices: { ...DEFAULT_TRADING_CONFIG.prices, ...(parsed.prices || {}) },
                    trading: {
                        ...DEFAULT_TRADING_CONFIG.trading,
                        ...(parsed.trading || {}),
                        // Force-enable auto-trading unless explicitly disabled by runtime intent
                        autoTradingEnabled: true,
                    },
                    scanner: { ...DEFAULT_TRADING_CONFIG.scanner, ...(parsed.scanner || {}) },
                    tokens: { ...DEFAULT_TRADING_CONFIG.tokens, ...(parsed.tokens || {}) },
                    apis: { ...DEFAULT_TRADING_CONFIG.apis, ...(parsed.apis || {}) },
                    risk: { ...DEFAULT_TRADING_CONFIG.risk, ...(parsed.risk || {}) },
                };
                console.log('✅ Loaded saved config with enhanced defaults');
                return mergedConfig;
            }
        }
        catch (error) {
            console.warn('Failed to load saved config, using enhanced defaults:', error);
        }
        console.log('✅ Using enhanced default configuration for 10 SOL capital');
        return { ...DEFAULT_TRADING_CONFIG };
    }
    getConfig() {
        return { ...this.config };
    }
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
        this.saveConfig();
        this.notifyListeners();
        console.log('🔄 Config updated:', updates);
    }
    updateSection(section, updates) {
        this.config[section] = { ...this.config[section], ...updates };
        this.saveConfig();
        this.notifyListeners();
        console.log(`🔄 Config section '${section}' updated:`, updates);
    }
    saveConfig() {
        try {
            localStorage.setItem('trading_config', JSON.stringify(this.config));
            console.log('💾 Config saved to localStorage');
        }
        catch (error) {
            console.error('Failed to save config:', error);
        }
    }
    subscribe(listener) {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index > -1) {
                this.listeners.splice(index, 1);
            }
        };
    }
    notifyListeners() {
        this.listeners.forEach(listener => listener(this.config));
    }
    resetToDefaults() {
        this.config = { ...DEFAULT_TRADING_CONFIG };
        this.saveConfig();
        this.notifyListeners();
        console.log('🔄 Config reset to enhanced defaults');
    }
    // Enhanced validation for 10 SOL capital
    validateConfig() {
        const errors = [];
        if (this.config.trading.minProfitUsd <= 0) {
            errors.push('Minimum profit must be greater than 0');
        }
        if (this.config.trading.maxPositionSol <= 0) {
            errors.push('Maximum position size must be greater than 0');
        }
        if (this.config.trading.maxPositionSol > 10.0) {
            errors.push('Maximum position size cannot exceed available capital (10 SOL)');
        }
        if (this.config.risk.maxTradeAmountSol > 10.0) {
            errors.push('Maximum trade amount cannot exceed available capital (10 SOL)');
        }
        if (this.config.trading.slippageBps < 1 || this.config.trading.slippageBps > 2000) {
            errors.push('Slippage must be between 1 and 2000 basis points');
        }
        if (this.config.scanner.scanIntervalMs < 100) {
            errors.push('Scan interval must be at least 100ms');
        }
        if (this.config.risk.maxDailyLossSol > this.config.risk.maxTradeAmountSol) {
            errors.push('Daily loss limit should not exceed maximum trade amount');
        }
        return {
            isValid: errors.length === 0,
            errors
        };
    }
    // Get optimal strategy based on available capital
    getOptimalStrategy(availableCapital) {
        if (availableCapital >= 8.0) {
            return 'AGGRESSIVE'; // High capital, aggressive trading
        }
        else if (availableCapital >= 5.0) {
            return 'BALANCED'; // Medium capital, balanced approach
        }
        else if (availableCapital >= 2.0) {
            return 'CONSERVATIVE'; // Lower capital, conservative approach
        }
        else {
            return 'MICRO'; // Very low capital, micro-MEV only
        }
    }
    // Calculate recommended trade size based on opportunity and capital
    getRecommendedTradeSize(availableCapital, profitUsd, riskLevel) {
        const strategy = this.getOptimalStrategy(availableCapital);
        let baseSize;
        switch (strategy) {
            case 'AGGRESSIVE':
                baseSize = Math.min(5.0, availableCapital * 0.6); // Up to 60% of capital
                break;
            case 'BALANCED':
                baseSize = Math.min(3.0, availableCapital * 0.4); // Up to 40% of capital
                break;
            case 'CONSERVATIVE':
                baseSize = Math.min(1.5, availableCapital * 0.3); // Up to 30% of capital
                break;
            default:
                baseSize = Math.min(0.5, availableCapital * 0.2); // Up to 20% of capital
        }
        // Risk adjustment
        const riskMultiplier = riskLevel === 'LOW' ? 1.0 : riskLevel === 'MEDIUM' ? 0.8 : 0.6;
        // Profit-based adjustment
        const profitMultiplier = Math.min(1.5, Math.max(0.5, profitUsd * 50)); // Scale with profit
        return Math.min(baseSize * riskMultiplier * profitMultiplier, this.config.risk.maxTradeAmountSol, availableCapital * 0.8 // Never use more than 80% of available capital
        );
    }
}
export const tradingConfigManager = new TradingConfigManager();
//# sourceMappingURL=tradingConfig.js.map