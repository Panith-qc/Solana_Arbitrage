import { RiskLevel, RiskProfile } from '../config/riskProfiles';
import { TradingConfig } from '../config/tradingConfig';
export interface AutoConfig {
    profile: RiskProfile;
    walletBalance: number;
    calculatedSettings: {
        minProfitUsd: number;
        maxPositionSol: number;
        maxDailyLossSol: number;
        maxTradeAmountSol: number;
        dailyLimitSol: number;
        slippageBps: number;
        priorityFeeLamports: number;
        scanIntervalMs: number;
        stopLossPercent: number;
        maxConcurrentTrades: number;
    };
    enabledStrategies: string[];
    readyToTrade: boolean;
    warnings: string[];
}
export declare class AutoConfigService {
    private connection;
    constructor(rpcUrl: string);
    /**
     * AUTO-CONFIGURE EVERYTHING
     * Just provide wallet address and risk level - we handle the rest!
     */
    autoConfigureBot(walletAddress: string, riskLevel: RiskLevel): Promise<AutoConfig>;
    /**
     * Get wallet balance in SOL
     */
    private getWalletBalance;
    /**
     * Calculate position sizing based on balance and risk profile
     * THIS IS THE MAGIC - Auto-sizes everything!
     */
    private calculatePositionSizing;
    /**
     * Get list of enabled strategy names
     */
    private getEnabledStrategies;
    /**
     * Validate configuration and generate warnings
     */
    private validateConfiguration;
    /**
     * Log configuration summary
     */
    private logConfiguration;
    /**
     * Convert AutoConfig to TradingConfig format
     */
    convertToTradingConfig(autoConfig: AutoConfig): Partial<TradingConfig>;
    /**
     * Quick setup - one function does everything!
     */
    quickSetup(walletAddress: string, riskLevel: RiskLevel): Promise<{
        config: AutoConfig;
        tradingConfig: Partial<TradingConfig>;
        message: string;
    }>;
}
export declare const autoConfigService: AutoConfigService;
export declare function configureBot(walletAddress: string, riskLevel?: RiskLevel): Promise<AutoConfig>;
//# sourceMappingURL=autoConfigService.d.ts.map