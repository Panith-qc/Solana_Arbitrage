// REAL PROFIT ENGINE - PRODUCTION CALCULATIONS
// Accurate fee calculations, risk management, position sizing

interface TradingFees {
  gasFee: number;           // Solana transaction fee in USD
  jupiterFee: number;       // Jupiter platform fee in USD
  dexFees: number;          // DEX swap fees in USD
  priorityFee: number;      // Priority fee for MEV execution in USD
  slippageFee: number;      // Slippage cost in USD
  totalFees: number;        // Total fees in USD
}

interface RealProfitCalculation {
  grossProfit: number;      // Profit before fees
  tradingFees: TradingFees; // Breakdown of all fees
  netProfit: number;        // Actual profit after all fees
  profitMargin: number;     // Net profit as percentage
  isReallyProfitable: boolean; // True if net profit > minimum threshold
  riskScore: number;        // Risk assessment (0-100)
  recommendedPosition: number; // Recommended position size in USD
}

interface RiskParameters {
  maxPositionSize: number;  // Maximum position size in USD
  maxRiskPerTrade: number;  // Maximum risk per trade as % of balance
  stopLossPercent: number;  // Stop loss percentage
  volatilityThreshold: number; // Volatility threshold for risk adjustment
}

class RealProfitEngine {
  private readonly SOL_PRICE = 245; // Current SOL price in USD
  private readonly JUPITER_FEE_BPS = 10; // 0.1% Jupiter platform fee
  private readonly TYPICAL_DEX_FEE_BPS = 25; // 0.25% average DEX fee
  private readonly BASE_GAS_LAMPORTS = 5000; // Base Solana transaction fee
  private readonly MEV_PRIORITY_FEE_LAMPORTS = 300000; // Higher priority for MEV
  
  // Production risk parameters
  private readonly RISK_PARAMS: RiskParameters = {
    maxPositionSize: 1000, // $1000 max position
    maxRiskPerTrade: 2.0,  // 2% max risk per trade
    stopLossPercent: 5.0,  // 5% stop loss
    volatilityThreshold: 10.0 // 10% volatility threshold
  };

  // Minimum profit thresholds by opportunity type
  private readonly MIN_PROFIT_THRESHOLDS = {
    SANDWICH: 0.05,   // $0.05 minimum for sandwich
    ARBITRAGE: 0.02,  // $0.02 minimum for arbitrage
    LIQUIDATION: 0.10 // $0.10 minimum for liquidation
  };

  constructor() {
    console.log('💰 REAL PROFIT ENGINE - Production calculations initialized');
    console.log(`📊 Risk Params: Max position $${this.RISK_PARAMS.maxPositionSize} | Max risk ${this.RISK_PARAMS.maxRiskPerTrade}%`);
  }

  // Calculate comprehensive real profit with all fees and risks
  calculateRealProfit(
    inputAmount: number,    // Input amount in tokens
    outputAmount: number,   // Output amount in tokens
    inputPrice: number,     // Input token price in USD
    outputPrice: number,    // Output token price in USD
    opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION',
    priceImpactPct: string = '0', // Price impact from Jupiter quote
    currentBalance: number = 1000 // Current wallet balance in USD
  ): RealProfitCalculation {
    
    // Calculate gross profit (before fees)
    const inputValueUsd = inputAmount * inputPrice;
    const outputValueUsd = outputAmount * outputPrice;
    const grossProfit = outputValueUsd - inputValueUsd;

    console.log(`📊 PROFIT CALC - ${opportunityType}: Input $${inputValueUsd.toFixed(3)} -> Output $${outputValueUsd.toFixed(3)}`);

    // Calculate all trading fees
    const tradingFees = this.calculateComprehensiveFees(inputValueUsd, outputValueUsd, parseFloat(priceImpactPct));

    // Calculate net profit
    const netProfit = grossProfit - tradingFees.totalFees;
    const profitMargin = inputValueUsd > 0 ? (netProfit / inputValueUsd) * 100 : 0;
    
    // Check if really profitable based on type
    const minThreshold = this.MIN_PROFIT_THRESHOLDS[opportunityType];
    const isReallyProfitable = netProfit > minThreshold;

    // Calculate risk score
    const riskScore = this.calculateRiskScore(inputValueUsd, profitMargin, parseFloat(priceImpactPct), opportunityType);

    // Calculate recommended position size
    const recommendedPosition = this.calculateOptimalPosition(inputValueUsd, riskScore, currentBalance);

    console.log(`💰 NET PROFIT: $${netProfit.toFixed(4)} (${profitMargin.toFixed(2)}%) | Risk: ${riskScore} | Profitable: ${isReallyProfitable}`);

    return {
      grossProfit,
      tradingFees,
      netProfit,
      profitMargin,
      isReallyProfitable,
      riskScore,
      recommendedPosition
    };
  }

  // Calculate comprehensive trading fees
  private calculateComprehensiveFees(inputValueUsd: number, outputValueUsd: number, priceImpactPct: number): TradingFees {
    // 1. Gas fee (Solana transaction fee)
    const gasFeeInSol = this.BASE_GAS_LAMPORTS / 1e9;
    const gasFee = gasFeeInSol * this.SOL_PRICE;

    // 2. Priority fee for MEV (higher for competitive execution)
    const priorityFeeInSol = this.MEV_PRIORITY_FEE_LAMPORTS / 1e9;
    const priorityFee = priorityFeeInSol * this.SOL_PRICE;

    // 3. Jupiter platform fee (0.1% of trade value)
    const tradeValueUsd = Math.max(inputValueUsd, outputValueUsd);
    const jupiterFee = (tradeValueUsd * this.JUPITER_FEE_BPS) / 10000;

    // 4. DEX fees (0.25% average across Orca, Raydium, etc.)
    const dexFees = (tradeValueUsd * this.TYPICAL_DEX_FEE_BPS) / 10000;

    // 5. Slippage cost (based on price impact)
    const slippageFee = tradeValueUsd * (priceImpactPct / 100);

    // Total fees
    const totalFees = gasFee + jupiterFee + dexFees + priorityFee + slippageFee;

    console.log(`💸 FEE BREAKDOWN:`);
    console.log(`   Gas fee: $${gasFee.toFixed(4)}`);
    console.log(`   Priority fee: $${priorityFee.toFixed(4)}`);
    console.log(`   Jupiter fee: $${jupiterFee.toFixed(4)}`);
    console.log(`   DEX fees: $${dexFees.toFixed(4)}`);
    console.log(`   Slippage: $${slippageFee.toFixed(4)}`);
    console.log(`   TOTAL FEES: $${totalFees.toFixed(4)}`);

    return {
      gasFee,
      jupiterFee,
      dexFees,
      priorityFee,
      slippageFee,
      totalFees
    };
  }

  // Calculate risk score (0-100, lower is better)
  private calculateRiskScore(
    positionSize: number,
    profitMargin: number,
    priceImpact: number,
    opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION'
  ): number {
    let riskScore = 0;

    // Position size risk (larger positions = higher risk)
    if (positionSize > 500) riskScore += 30;
    else if (positionSize > 200) riskScore += 20;
    else if (positionSize > 100) riskScore += 10;

    // Profit margin risk (lower margins = higher risk)
    if (profitMargin < 0.5) riskScore += 40;
    else if (profitMargin < 1.0) riskScore += 25;
    else if (profitMargin < 2.0) riskScore += 15;

    // Price impact risk (higher impact = higher risk)
    if (priceImpact > 2.0) riskScore += 35;
    else if (priceImpact > 1.0) riskScore += 20;
    else if (priceImpact > 0.5) riskScore += 10;

    // Opportunity type risk
    switch (opportunityType) {
      case 'SANDWICH': riskScore += 15; break; // Medium risk
      case 'ARBITRAGE': riskScore += 5; break;  // Lower risk
      case 'LIQUIDATION': riskScore += 25; break; // Higher risk
    }

    return Math.min(100, Math.max(0, riskScore));
  }

  // Calculate optimal position size based on risk
  private calculateOptimalPosition(
    requestedSize: number,
    riskScore: number,
    currentBalance: number
  ): number {
    // Start with requested size
    let optimalSize = requestedSize;

    // Apply maximum position size limit
    optimalSize = Math.min(optimalSize, this.RISK_PARAMS.maxPositionSize);

    // Apply balance-based risk limit
    const maxRiskAmount = currentBalance * (this.RISK_PARAMS.maxRiskPerTrade / 100);
    optimalSize = Math.min(optimalSize, maxRiskAmount);

    // Reduce size based on risk score
    if (riskScore > 70) optimalSize *= 0.3; // High risk: 30% of requested
    else if (riskScore > 50) optimalSize *= 0.5; // Medium risk: 50% of requested
    else if (riskScore > 30) optimalSize *= 0.7; // Low-medium risk: 70% of requested
    // Low risk (≤30): Keep full size

    return Math.max(10, optimalSize); // Minimum $10 position
  }

  // Validate if opportunity is worth trading
  isWorthTrading(
    profitCalculation: RealProfitCalculation,
    opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION'
  ): { worthTrading: boolean; reason: string } {
    // Check minimum profit threshold
    const minThreshold = this.MIN_PROFIT_THRESHOLDS[opportunityType];
    if (profitCalculation.netProfit < minThreshold) {
      return {
        worthTrading: false,
        reason: `Net profit $${profitCalculation.netProfit.toFixed(4)} below minimum $${minThreshold}`
      };
    }

    // Check risk score
    if (profitCalculation.riskScore > 80) {
      return {
        worthTrading: false,
        reason: `Risk score ${profitCalculation.riskScore} too high (max 80)`
      };
    }

    // Check profit margin
    if (profitCalculation.profitMargin < 0.1) {
      return {
        worthTrading: false,
        reason: `Profit margin ${profitCalculation.profitMargin.toFixed(3)}% too low (min 0.1%)`
      };
    }

    return {
      worthTrading: true,
      reason: `Profitable: $${profitCalculation.netProfit.toFixed(4)} net profit, ${profitCalculation.riskScore} risk score`
    };
  }

  // Get minimum profit threshold for opportunity type
  getMinimumProfitThreshold(opportunityType: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION'): number {
    return this.MIN_PROFIT_THRESHOLDS[opportunityType];
  }

  // Update risk parameters (for dynamic adjustment)
  updateRiskParameters(params: Partial<RiskParameters>): void {
    Object.assign(this.RISK_PARAMS, params);
    console.log('🎯 RISK PARAMETERS UPDATED:', this.RISK_PARAMS);
  }

  // Get current risk parameters
  getRiskParameters(): RiskParameters {
    return { ...this.RISK_PARAMS };
  }

  // Calculate position size for specific balance and risk tolerance
  calculatePositionForBalance(
    balance: number,
    riskTolerance: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM'
  ): number {
    const riskMultipliers = {
      LOW: 0.01,    // 1% of balance
      MEDIUM: 0.02, // 2% of balance
      HIGH: 0.05    // 5% of balance
    };

    const maxPosition = balance * riskMultipliers[riskTolerance];
    return Math.min(maxPosition, this.RISK_PARAMS.maxPositionSize);
  }
}

export const realProfitEngine = new RealProfitEngine();
export type { TradingFees, RealProfitCalculation, RiskParameters };