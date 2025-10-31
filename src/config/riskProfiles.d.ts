export type RiskLevel = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
export interface RiskProfile {
    name: string;
    description: string;
    level: RiskLevel;
    minProfitUsd: number;
    minProfitPercent: number;
    maxPositionPercent: number;
    dailyLimitPercent: number;
    stopLossPercent: number;
    maxConcurrentTrades: number;
    maxDailyLossSol: number;
    slippageBps: number;
    priorityFeeLamports: number;
    scanIntervalMs: number;
    enabledStrategies: {
        backrun: boolean;
        cyclicArbitrage: boolean;
        jitLiquidity: boolean;
        longTailArbitrage: boolean;
        microArbitrage: boolean;
        crossDexArbitrage: boolean;
        sandwich: boolean;
        liquidation: boolean;
    };
    expectedDailyTrades: string;
    expectedSuccessRate: string;
    expectedDailyReturn: string;
}
export declare const CONSERVATIVE_PROFILE: RiskProfile;
export declare const BALANCED_PROFILE: RiskProfile;
export declare const AGGRESSIVE_PROFILE: RiskProfile;
export declare const RISK_PROFILES: Record<RiskLevel, RiskProfile>;
export declare function getRiskProfile(level: RiskLevel): RiskProfile;
export declare function getAllRiskProfiles(): RiskProfile[];
export declare function getProfileSummary(level: RiskLevel): string;
//# sourceMappingURL=riskProfiles.d.ts.map