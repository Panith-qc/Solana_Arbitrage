// ENHANCED QUALITY GATE - Advanced pre-trade validation
// Checks price impact, liquidity, volatility, and safety before execution
import { multiAPIService } from './multiAPIQuoteService';
import { priceService } from './priceService';
export class EnhancedQualityGate {
    constructor() {
        // Thresholds for quality checks
        Object.defineProperty(this, "MAX_PRICE_IMPACT", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0.5
        }); // 0.5% max price impact
        Object.defineProperty(this, "MIN_LIQUIDITY_MULTIPLIER", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 10
        }); // Liquidity must be 10x trade size
        Object.defineProperty(this, "MAX_VOLATILITY", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 5.0
        }); // 5% max volatility in last 5 minutes
        Object.defineProperty(this, "MIN_PROFIT_MARGIN", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0.02
        }); // $0.02 minimum profit after all fees
    }
    /**
     * Comprehensive quality check before executing trade
     * Returns whether trade should proceed and detailed reasoning
     */
    async checkTradeQuality(tokenMint, tradeAmountSOL, expectedProfitUSD) {
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        console.log(`\n🔍 Quality Gate Check for trade:`);
        console.log(`   Token: ${tokenMint.substring(0, 8)}...`);
        console.log(`   Amount: ${tradeAmountSOL.toFixed(4)} SOL`);
        console.log(`   Expected Profit: $${expectedProfitUSD.toFixed(4)}`);
        // Initialize results
        const checks = {
            priceImpact: { passed: false, value: 0, threshold: this.MAX_PRICE_IMPACT },
            liquidity: { passed: false, value: 0, threshold: this.MIN_LIQUIDITY_MULTIPLIER },
            volatility: { passed: false, value: 0, threshold: this.MAX_VOLATILITY },
            profitMargin: { passed: false, value: 0, threshold: this.MIN_PROFIT_MARGIN }
        };
        try {
            // ═══════════════════════════════════════════════════════════════
            // CHECK 1: PRICE IMPACT
            // ═══════════════════════════════════════════════════════════════
            // Get quote to check slippage/price impact
            const tradeAmountLamports = Math.floor(tradeAmountSOL * 1e9);
            const quote = await multiAPIService.getQuote(SOL_MINT, tokenMint, tradeAmountLamports, 50);
            if (!quote) {
                return {
                    shouldProceed: false,
                    confidence: 0,
                    reason: 'Unable to get quote',
                    checks
                };
            }
            // Calculate price impact from quote
            // Jupiter returns priceImpactPct in the quote
            const priceImpact = Math.abs(parseFloat(quote.priceImpactPct || '0'));
            checks.priceImpact.value = priceImpact;
            checks.priceImpact.passed = priceImpact <= this.MAX_PRICE_IMPACT;
            console.log(`   ✓ Price Impact: ${priceImpact.toFixed(3)}% (max: ${this.MAX_PRICE_IMPACT}%)`);
            if (!checks.priceImpact.passed) {
                return {
                    shouldProceed: false,
                    confidence: 0.3,
                    reason: `Price impact too high: ${priceImpact.toFixed(2)}% > ${this.MAX_PRICE_IMPACT}%`,
                    checks
                };
            }
            // ═══════════════════════════════════════════════════════════════
            // CHECK 2: LIQUIDITY DEPTH
            // ═══════════════════════════════════════════════════════════════
            // Estimate liquidity by comparing quotes at different sizes
            const smallQuote = await multiAPIService.getQuote(SOL_MINT, tokenMint, tradeAmountLamports / 10, 50);
            const largeQuote = await multiAPIService.getQuote(SOL_MINT, tokenMint, tradeAmountLamports * 2, 50);
            // If we can get quotes for 2x the trade size without huge slippage, liquidity is good
            let liquidityMultiplier = 0;
            if (smallQuote && largeQuote) {
                const smallRate = Number(smallQuote.outAmount) / (tradeAmountLamports / 10);
                const largeRate = Number(largeQuote.outAmount) / (tradeAmountLamports * 2);
                const rateChange = Math.abs((smallRate - largeRate) / smallRate);
                // If rate changes less than 5% when doubling size, liquidity is 2x
                // If rate changes less than 10%, liquidity is adequate
                if (rateChange < 0.05) {
                    liquidityMultiplier = 20; // Excellent liquidity
                }
                else if (rateChange < 0.10) {
                    liquidityMultiplier = 10; // Good liquidity
                }
                else {
                    liquidityMultiplier = 5; // Marginal liquidity
                }
            }
            else {
                // Can't get large quotes - poor liquidity
                liquidityMultiplier = 2;
            }
            checks.liquidity.value = liquidityMultiplier;
            checks.liquidity.passed = liquidityMultiplier >= this.MIN_LIQUIDITY_MULTIPLIER;
            console.log(`   ✓ Liquidity: ${liquidityMultiplier.toFixed(1)}x trade size (min: ${this.MIN_LIQUIDITY_MULTIPLIER}x)`);
            if (!checks.liquidity.passed) {
                return {
                    shouldProceed: false,
                    confidence: 0.4,
                    reason: `Insufficient liquidity: ${liquidityMultiplier.toFixed(1)}x < ${this.MIN_LIQUIDITY_MULTIPLIER}x`,
                    checks
                };
            }
            // ═══════════════════════════════════════════════════════════════
            // CHECK 3: VOLATILITY (Simplified - based on price stability)
            // ═══════════════════════════════════════════════════════════════
            // Get current price and check if it's stable
            // In a real implementation, you'd check historical prices
            // For now, we'll use a simplified check based on quote consistency
            const currentPrice = await priceService.getPriceUsd(tokenMint);
            // Get another quote after a small delay to check price stability
            await new Promise(resolve => setTimeout(resolve, 100));
            const secondQuote = await multiAPIService.getQuote(SOL_MINT, tokenMint, tradeAmountLamports, 50);
            let volatility = 0;
            if (secondQuote && quote) {
                const firstRate = Number(quote.outAmount) / tradeAmountLamports;
                const secondRate = Number(secondQuote.outAmount) / tradeAmountLamports;
                volatility = Math.abs((secondRate - firstRate) / firstRate) * 100;
            }
            checks.volatility.value = volatility;
            checks.volatility.passed = volatility <= this.MAX_VOLATILITY;
            console.log(`   ✓ Volatility: ${volatility.toFixed(2)}% (max: ${this.MAX_VOLATILITY}%)`);
            if (!checks.volatility.passed) {
                return {
                    shouldProceed: false,
                    confidence: 0.5,
                    reason: `High volatility: ${volatility.toFixed(2)}% > ${this.MAX_VOLATILITY}%`,
                    checks
                };
            }
            // ═══════════════════════════════════════════════════════════════
            // CHECK 4: PROFIT MARGIN
            // ═══════════════════════════════════════════════════════════════
            // Ensure profit is sufficient after accounting for all risks
            checks.profitMargin.value = expectedProfitUSD;
            checks.profitMargin.passed = expectedProfitUSD >= this.MIN_PROFIT_MARGIN;
            console.log(`   ✓ Profit Margin: $${expectedProfitUSD.toFixed(4)} (min: $${this.MIN_PROFIT_MARGIN})`);
            if (!checks.profitMargin.passed) {
                return {
                    shouldProceed: false,
                    confidence: 0.6,
                    reason: `Profit too small: $${expectedProfitUSD.toFixed(4)} < $${this.MIN_PROFIT_MARGIN}`,
                    checks
                };
            }
            // ═══════════════════════════════════════════════════════════════
            // ALL CHECKS PASSED
            // ═══════════════════════════════════════════════════════════════
            // Calculate confidence based on how well it passed checks
            let confidence = 0.85; // Base confidence
            // Bonus confidence for excellent metrics
            if (priceImpact < 0.1)
                confidence += 0.05; // Very low price impact
            if (liquidityMultiplier > 20)
                confidence += 0.05; // Excellent liquidity
            if (volatility < 1.0)
                confidence += 0.05; // Very stable
            confidence = Math.min(confidence, 0.95); // Cap at 95%
            console.log(`   ✅ All checks passed! Confidence: ${(confidence * 100).toFixed(1)}%\n`);
            return {
                shouldProceed: true,
                confidence,
                reason: 'All quality checks passed',
                checks
            };
        }
        catch (error) {
            console.error(`   ❌ Quality check error:`, error);
            return {
                shouldProceed: false,
                confidence: 0,
                reason: `Quality check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                checks
            };
        }
    }
    /**
     * Quick quality check - faster but less comprehensive
     * Use this when you need speed over thoroughness
     */
    async quickCheck(tokenMint, tradeAmountSOL, expectedProfitUSD) {
        // Only check profit margin and get a single quote
        if (expectedProfitUSD < this.MIN_PROFIT_MARGIN) {
            return false;
        }
        try {
            const SOL_MINT = 'So11111111111111111111111111111111111111112';
            const tradeAmountLamports = Math.floor(tradeAmountSOL * 1e9);
            const quote = await multiAPIService.getQuote(SOL_MINT, tokenMint, tradeAmountLamports, 50);
            if (!quote)
                return false;
            const priceImpact = Math.abs(parseFloat(quote.priceImpactPct || '0'));
            return priceImpact <= this.MAX_PRICE_IMPACT;
        }
        catch {
            return false;
        }
    }
}
export const enhancedQualityGate = new EnhancedQualityGate();
