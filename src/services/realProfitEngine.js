// REAL PROFIT ENGINE - PRODUCTION CALCULATIONS
// Accurate fee calculations, risk management, position sizing
class RealProfitEngine {
    constructor() {
        Object.defineProperty(this, "SOL_PRICE", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 245
        }); // Current SOL price in USD
        Object.defineProperty(this, "JUPITER_FEE_BPS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 10
        }); // 0.1% Jupiter platform fee
        Object.defineProperty(this, "TYPICAL_DEX_FEE_BPS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 25
        }); // 0.25% average DEX fee
        Object.defineProperty(this, "BASE_GAS_LAMPORTS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 5000
        }); // Base Solana transaction fee
        Object.defineProperty(this, "MEV_PRIORITY_FEE_LAMPORTS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 300000
        }); // Higher priority for MEV
        // Production risk parameters
        Object.defineProperty(this, "RISK_PARAMS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                maxPositionSize: 1000, // $1000 max position
                maxRiskPerTrade: 2.0, // 2% max risk per trade
                stopLossPercent: 5.0, // 5% stop loss
                volatilityThreshold: 10.0 // 10% volatility threshold
            }
        });
        // Minimum profit thresholds by opportunity type
        Object.defineProperty(this, "MIN_PROFIT_THRESHOLDS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                SANDWICH: 0.05, // $0.05 minimum for sandwich
                ARBITRAGE: 0.02, // $0.02 minimum for arbitrage
                LIQUIDATION: 0.10 // $0.10 minimum for liquidation
            }
        });
        console.log('💰 REAL PROFIT ENGINE - Production calculations initialized');
        console.log(`📊 Risk Params: Max position $${this.RISK_PARAMS.maxPositionSize} | Max risk ${this.RISK_PARAMS.maxRiskPerTrade}%`);
    }
    // Calculate comprehensive real profit with all fees and risks
    calculateRealProfit(inputAmount, // Input amount in tokens
    outputAmount, // Output amount in tokens
    inputPrice, // Input token price in USD
    outputPrice, // Output token price in USD
    opportunityType, priceImpactPct = '0', // Price impact from Jupiter quote
    currentBalance = 1000 // Current wallet balance in USD
    ) {
        // Calculate gross profit (before fees)
        const inputValueUsd = inputAmount * inputPrice;
        const outputValueUsd = outputAmount * outputPrice;
        const grossProfit = outputValueUsd - inputValueUsd;
        console.log(`📊 PROFIT CALC - ${opportunityType}: Input $${(inputValueUsd != null && !isNaN(inputValueUsd) && typeof inputValueUsd === 'number' ? inputValueUsd.toFixed(3) : '0.000')} -> Output $${(outputValueUsd != null && !isNaN(outputValueUsd) && typeof outputValueUsd === 'number' ? outputValueUsd.toFixed(3) : '0.000')}`);
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
        console.log(`💰 NET PROFIT: $${(netProfit != null && !isNaN(netProfit) && typeof netProfit === 'number' ? netProfit.toFixed(4) : '0.0000')} (${(profitMargin != null && !isNaN(profitMargin) && typeof profitMargin === 'number' ? profitMargin.toFixed(2) : '0.00')}%) | Risk: ${riskScore} | Profitable: ${isReallyProfitable}`);
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
    calculateComprehensiveFees(inputValueUsd, outputValueUsd, priceImpactPct) {
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
        console.log(`   Gas fee: $${(gasFee != null && !isNaN(gasFee) && typeof gasFee === 'number' ? gasFee.toFixed(4) : '0.0000')}`);
        console.log(`   Priority fee: $${(priorityFee != null && !isNaN(priorityFee) && typeof priorityFee === 'number' ? priorityFee.toFixed(4) : '0.0000')}`);
        console.log(`   Jupiter fee: $${(jupiterFee != null && !isNaN(jupiterFee) && typeof jupiterFee === 'number' ? jupiterFee.toFixed(4) : '0.0000')}`);
        console.log(`   DEX fees: $${(dexFees != null && !isNaN(dexFees) && typeof dexFees === 'number' ? dexFees.toFixed(4) : '0.0000')}`);
        console.log(`   Slippage: $${(slippageFee != null && !isNaN(slippageFee) && typeof slippageFee === 'number' ? slippageFee.toFixed(4) : '0.0000')}`);
        console.log(`   TOTAL FEES: $${(totalFees != null && !isNaN(totalFees) && typeof totalFees === 'number' ? totalFees.toFixed(4) : '0.0000')}`);
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
    calculateRiskScore(positionSize, profitMargin, priceImpact, opportunityType) {
        let riskScore = 0;
        // Position size risk (larger positions = higher risk)
        if (positionSize > 500)
            riskScore += 30;
        else if (positionSize > 200)
            riskScore += 20;
        else if (positionSize > 100)
            riskScore += 10;
        // Profit margin risk (lower margins = higher risk)
        if (profitMargin < 0.5)
            riskScore += 40;
        else if (profitMargin < 1.0)
            riskScore += 25;
        else if (profitMargin < 2.0)
            riskScore += 15;
        // Price impact risk (higher impact = higher risk)
        if (priceImpact > 2.0)
            riskScore += 35;
        else if (priceImpact > 1.0)
            riskScore += 20;
        else if (priceImpact > 0.5)
            riskScore += 10;
        // Opportunity type risk
        switch (opportunityType) {
            case 'SANDWICH':
                riskScore += 15;
                break; // Medium risk
            case 'ARBITRAGE':
                riskScore += 5;
                break; // Lower risk
            case 'LIQUIDATION':
                riskScore += 25;
                break; // Higher risk
        }
        return Math.min(100, Math.max(0, riskScore));
    }
    // Calculate optimal position size based on risk
    calculateOptimalPosition(requestedSize, riskScore, currentBalance) {
        // Start with requested size
        let optimalSize = requestedSize;
        // Apply maximum position size limit
        optimalSize = Math.min(optimalSize, this.RISK_PARAMS.maxPositionSize);
        // Apply balance-based risk limit
        const maxRiskAmount = currentBalance * (this.RISK_PARAMS.maxRiskPerTrade / 100);
        optimalSize = Math.min(optimalSize, maxRiskAmount);
        // Reduce size based on risk score
        if (riskScore > 70)
            optimalSize *= 0.3; // High risk: 30% of requested
        else if (riskScore > 50)
            optimalSize *= 0.5; // Medium risk: 50% of requested
        else if (riskScore > 30)
            optimalSize *= 0.7; // Low-medium risk: 70% of requested
        // Low risk (≤30): Keep full size
        return Math.max(10, optimalSize); // Minimum $10 position
    }
    // Validate if opportunity is worth trading
    isWorthTrading(profitCalculation, opportunityType) {
        // Check minimum profit threshold
        const minThreshold = this.MIN_PROFIT_THRESHOLDS[opportunityType];
        if (profitCalculation.netProfit < minThreshold) {
            return {
                worthTrading: false,
                reason: `Net profit $${(profitCalculation.netProfit != null && !isNaN(profitCalculation.netProfit) && typeof profitCalculation.netProfit === 'number' ? profitCalculation.netProfit.toFixed(4) : '0.0000')} below minimum $${minThreshold}`
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
                reason: `Profit margin ${(profitCalculation.profitMargin != null && !isNaN(profitCalculation.profitMargin) && typeof profitCalculation.profitMargin === 'number' ? profitCalculation.profitMargin.toFixed(3) : '0.000')}% too low (min 0.1%)`
            };
        }
        return {
            worthTrading: true,
            reason: `Profitable: $${(profitCalculation.netProfit != null && !isNaN(profitCalculation.netProfit) && typeof profitCalculation.netProfit === 'number' ? profitCalculation.netProfit.toFixed(4) : '0.0000')} net profit, ${profitCalculation.riskScore} risk score`
        };
    }
    // Get minimum profit threshold for opportunity type
    getMinimumProfitThreshold(opportunityType) {
        return this.MIN_PROFIT_THRESHOLDS[opportunityType];
    }
    // Update risk parameters (for dynamic adjustment)
    updateRiskParameters(params) {
        Object.assign(this.RISK_PARAMS, params);
        console.log('🎯 RISK PARAMETERS UPDATED:', this.RISK_PARAMS);
    }
    // Get current risk parameters
    getRiskParameters() {
        return { ...this.RISK_PARAMS };
    }
    // Calculate position size for specific balance and risk tolerance
    calculatePositionForBalance(balance, riskTolerance = 'MEDIUM') {
        const riskMultipliers = {
            LOW: 0.01, // 1% of balance
            MEDIUM: 0.02, // 2% of balance
            HIGH: 0.05 // 5% of balance
        };
        const maxPosition = balance * riskMultipliers[riskTolerance];
        return Math.min(maxPosition, this.RISK_PARAMS.maxPositionSize);
    }
}
export const realProfitEngine = new RealProfitEngine();
//# sourceMappingURL=realProfitEngine.js.map