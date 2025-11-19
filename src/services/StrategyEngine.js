class StrategyEngineImpl {
    constructor() {
        Object.defineProperty(this, "activeStrategies", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "executionHistory", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "isRunning", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
    }
    async startAllStrategies(maxCapital, callback) {
        this.isRunning = true;
        console.log('🔍 Scanning for REAL opportunities using Jupiter API...');
        // Import services for REAL market data
        const { multiAPIService } = await import('./multiAPIQuoteService');
        const { priceService } = await import('./priceService');
        const opportunities = [];
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        // Real tokens to scan
        const tokens = [
            { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
            { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
            { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
            { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP' },
        ];
        const scanAmount = Math.floor((maxCapital * 0.3) * 1e9); // 30% of capital in lamports
        for (const token of tokens) {
            try {
                // Get REAL Jupiter quotes
                const forwardQuote = await multiAPIService.getQuote(SOL_MINT, token.mint, scanAmount, 50);
                if (!forwardQuote?.outAmount)
                    continue;
                const reverseQuote = await multiAPIService.getQuote(token.mint, SOL_MINT, Number(forwardQuote.outAmount), 50);
                if (!reverseQuote?.outAmount)
                    continue;
                // Calculate REAL profit
                const endAmount = Number(reverseQuote.outAmount);
                const profitLamports = endAmount - scanAmount;
                const profitSOL = profitLamports / 1e9;
                const profitPercent = (profitSOL / (scanAmount / 1e9)) * 100;
                const solPrice = await priceService.getPriceUsd(SOL_MINT);
                const profitUSD = profitSOL * solPrice;
                const feesUSD = 0.002 * solPrice;
                const netProfitUSD = profitUSD - feesUSD;
                // Only add if profitable
                if (netProfitUSD > 0.01) {
                    opportunities.push({
                        id: `strat-${token.symbol}-${Date.now()}`,
                        type: 'arbitrage',
                        pair: `SOL/${token.symbol}`,
                        targetProfit: netProfitUSD,
                        riskScore: profitPercent > 1 ? 0.2 : 0.3,
                        riskLevel: profitPercent > 1 ? 'LOW' : 'MEDIUM',
                        timeToExecute: 2000,
                        profitUsd: netProfitUSD,
                        confidence: 0.85,
                        recommendedCapital: scanAmount / 1e9,
                        strategyName: 'Cyclic Arbitrage (Real)',
                        outputMint: token.mint,
                        executionPlan: ['SOL', token.symbol, 'SOL']
                    });
                }
            }
            catch (error) {
                // Skip failed quotes
            }
        }
        this.activeStrategies = new Map(opportunities.map(o => [o.id, o]));
        console.log(`✅ Found ${opportunities.length} REAL opportunities`);
        if (callback && opportunities.length > 0) {
            try {
                await callback(opportunities);
            }
            catch (error) {
                console.error('Error in strategy callback:', error);
            }
        }
        this.isRunning = false;
    }
    async stopAllStrategies() {
        this.isRunning = false;
        this.activeStrategies.clear();
    }
    getActiveStrategies() {
        return Array.from(this.activeStrategies.values());
    }
    getExecutionHistory() {
        return this.executionHistory;
    }
    recordExecution(result) {
        this.executionHistory.push({ ...result, timestamp: Date.now() });
    }
}
export const strategyEngine = new StrategyEngineImpl();
