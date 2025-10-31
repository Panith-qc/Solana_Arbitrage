export interface TradingConfig {
    prices: {
        solUsd: number;
        jupUsd: number;
        bonkUsd: number;
        wifUsd: number;
        usdcUsd: number;
        refreshIntervalMs: number;
        maxPriceAgeMs: number;
    };
    trading: {
        minProfitUsd: number;
        maxPositionSol: number;
        slippageBps: number;
        priorityFeeLamports: number;
        autoTradingEnabled: boolean;
        riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
        enableSandwich: boolean;
        enableArbitrage: boolean;
        enableLiquidation: boolean;
        enableMicroMev: boolean;
    };
    scanner: {
        scanIntervalMs: number;
        circuitBreakerFailureThreshold: number;
        circuitBreakerRecoveryTimeoutMs: number;
        maxOpportunities: number;
        tokenCheckDelayMs: number;
        profitCaptureRate: number;
    };
    tokens: {
        SOL: string;
        USDC: string;
        USDT: string;
        JUP: string;
        BONK: string;
        WIF: string;
    };
    apis: {
        jupiterQuote: string;
        jupiterSwap: string;
        jupiterPrice: string;
        solscanBase: string;
        corsProxies: string[];
    };
    risk: {
        maxTradeAmountSol: number;
        maxDailyLossSol: number;
        stopLossPercent: number;
        maxConcurrentTrades: number;
        cooldownBetweenTradesMs: number;
    };
}
export declare const DEFAULT_TRADING_CONFIG: TradingConfig;
declare class TradingConfigManager {
    private config;
    private listeners;
    constructor();
    private loadConfig;
    getConfig(): TradingConfig;
    updateConfig(updates: Partial<TradingConfig>): void;
    updateSection<K extends keyof TradingConfig>(section: K, updates: Partial<TradingConfig[K]>): void;
    private saveConfig;
    subscribe(listener: (config: TradingConfig) => void): () => void;
    private notifyListeners;
    resetToDefaults(): void;
    validateConfig(): {
        isValid: boolean;
        errors: string[];
    };
    getOptimalStrategy(availableCapital: number): string;
    getRecommendedTradeSize(availableCapital: number, profitUsd: number, riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'): number;
}
export declare const tradingConfigManager: TradingConfigManager;
export {};
//# sourceMappingURL=tradingConfig.d.ts.map