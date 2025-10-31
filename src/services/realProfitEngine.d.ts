interface TradingFees {
    gasFee: number;
    jupiterFee: number;
    dexFees: number;
    priorityFee: number;
    slippageFee: number;
    totalFees: number;
}
interface RealProfitCalculation {
    grossProfit: number;
    tradingFees: TradingFees;
    netProfit: number;
    profitMargin: number;
    isReallyProfitable: boolean;
    riskScore: number;
    recommendedPosition: number;
}
interface RiskParameters {
    maxPositionSize: number;
    maxRiskPerTrade: number;
    stopLossPercent: number;
    volatilityThreshold: number;
}
declare class RealProfitEngine {
    private readonly SOL_PRICE;
    private readonly JUPITER_FEE_BPS;
    private readonly TYPICAL_DEX_FEE_BPS;
    private readonly BASE_GAS_LAMPORTS;
    private readonly MEV_PRIORITY_FEE_LAMPORTS;
    private readonly RISK_PARAMS;
    private readonly MIN_PROFIT_THRESHOLDS;
    constructor();
    calculateRealProfit(inputAmount: number, // Input amount in tokens
    outputAmount: number, // Output amount in tokens
    inputPrice: number, // Input token price in USD
    outputPrice: number, // Output token price in USD
    opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION', priceImpactPct?: string, // Price impact from Jupiter quote
    currentBalance?: number): RealProfitCalculation;
    private calculateComprehensiveFees;
    private calculateRiskScore;
    private calculateOptimalPosition;
    isWorthTrading(profitCalculation: RealProfitCalculation, opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION'): {
        worthTrading: boolean;
        reason: string;
    };
    getMinimumProfitThreshold(opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION'): number;
    updateRiskParameters(params: Partial<RiskParameters>): void;
    getRiskParameters(): RiskParameters;
    calculatePositionForBalance(balance: number, riskTolerance?: 'LOW' | 'MEDIUM' | 'HIGH'): number;
}
export declare const realProfitEngine: RealProfitEngine;
export type { TradingFees, RealProfitCalculation, RiskParameters };
//# sourceMappingURL=realProfitEngine.d.ts.map