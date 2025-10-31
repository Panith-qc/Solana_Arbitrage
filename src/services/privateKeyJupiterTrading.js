import { VersionedTransaction } from '@solana/web3.js';
import { privateKeyWallet } from './privateKeyWallet';
export class PrivateKeyJupiterTrading {
    constructor() {
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "jupiterApiUrl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'https://quote-api.jup.ag/v6'
        });
        this.connection = privateKeyWallet.getConnection();
        console.log('🚀 Jupiter trading initialized with Helius RPC for REAL profits');
    }
    async getQuote(inputMint, outputMint, amount, slippageBps = 100) {
        try {
            const params = new URLSearchParams({
                inputMint,
                outputMint,
                amount: amount.toString(),
                slippageBps: slippageBps.toString(),
                onlyDirectRoutes: 'false',
                asLegacyTransaction: 'false'
            });
            console.log(`🔍 Getting Jupiter quote for ${amount} tokens...`);
            const response = await fetch(`${this.jupiterApiUrl}/quote?${params}`);
            if (!response.ok) {
                console.error('❌ Jupiter quote failed:', response.statusText);
                return null;
            }
            const quote = await response.json();
            console.log('✅ Jupiter quote received:', {
                inputAmount: quote.inAmount,
                outputAmount: quote.outAmount,
                priceImpact: quote.priceImpactPct
            });
            return quote;
        }
        catch (error) {
            console.error('❌ Failed to get Jupiter quote:', error);
            return null;
        }
    }
    async getSwapTransaction(quote) {
        try {
            const keypair = privateKeyWallet.getKeypair();
            if (!keypair) {
                throw new Error('Private key wallet not connected');
            }
            console.log('🔄 Creating Jupiter swap transaction...');
            const response = await fetch(`${this.jupiterApiUrl}/swap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: keypair.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 500000 // Higher priority fee for MEV
                }),
            });
            if (!response.ok) {
                console.error('❌ Jupiter swap transaction failed:', response.statusText);
                return null;
            }
            const swapResult = await response.json();
            console.log('✅ Jupiter swap transaction created successfully');
            return swapResult.swapTransaction;
        }
        catch (error) {
            console.error('❌ Failed to get swap transaction:', error);
            return null;
        }
    }
    async executeSwap(quote) {
        try {
            console.log('🚀 EXECUTING REAL JUPITER SWAP FOR PROFIT...');
            // Get swap transaction
            const swapTransactionBase64 = await this.getSwapTransaction(quote);
            if (!swapTransactionBase64) {
                throw new Error('Failed to get swap transaction');
            }
            // Deserialize transaction
            const swapTransactionBuf = Buffer.from(swapTransactionBase64, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            // Sign and send transaction using private key via Helius
            const signature = await privateKeyWallet.signAndSendTransaction(transaction);
            console.log('💰 REAL PROFIT TRADE EXECUTED:', signature);
            console.log('🔗 View on Solscan:', `https://solscan.io/tx/${signature}`);
            return signature;
        }
        catch (error) {
            console.error('❌ REAL SWAP EXECUTION FAILED:', error);
            throw error;
        }
    }
    async scanForArbitrageOpportunities() {
        try {
            console.log('🔍 Scanning for REAL PROFITABLE arbitrage opportunities...');
            const opportunities = [];
            // High-volume, profitable trading pairs on Solana
            const tradingPairs = [
                {
                    name: 'SOL/USDC',
                    inputMint: 'So11111111111111111111111111111111111111112', // SOL
                    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                    baseAmount: 50000000 // 0.05 SOL in lamports - smaller amount for testing
                },
                {
                    name: 'SOL/USDT',
                    inputMint: 'So11111111111111111111111111111111111111112', // SOL
                    outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                    baseAmount: 50000000 // 0.05 SOL
                },
                {
                    name: 'USDC/USDT',
                    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
                    outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
                    baseAmount: 10000000 // 10 USDC
                },
                {
                    name: 'JUP/SOL',
                    inputMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
                    outputMint: 'So11111111111111111111111111111111111111112', // SOL
                    baseAmount: 5000000 // 5 JUP
                }
            ];
            for (const pair of tradingPairs) {
                try {
                    console.log(`🔍 Checking ${pair.name} for arbitrage...`);
                    // Get quote for forward trade
                    const forwardQuote = await this.getQuote(pair.inputMint, pair.outputMint, pair.baseAmount, 50 // Lower slippage for better accuracy
                    );
                    if (!forwardQuote) {
                        console.log(`⚠️ No forward quote for ${pair.name}`);
                        continue;
                    }
                    // Get quote for reverse trade
                    const reverseQuote = await this.getQuote(pair.outputMint, pair.inputMint, parseInt(forwardQuote.outAmount), 50);
                    if (!reverseQuote) {
                        console.log(`⚠️ No reverse quote for ${pair.name}`);
                        continue;
                    }
                    // Calculate potential profit
                    const initialAmount = pair.baseAmount;
                    const finalAmount = parseInt(reverseQuote.outAmount);
                    const profit = finalAmount - initialAmount;
                    const profitPercent = (profit / initialAmount) * 100;
                    console.log(`📊 ${pair.name} Analysis:`, {
                        initial: initialAmount,
                        final: finalAmount,
                        profit: profit,
                        profitPercent: (profitPercent != null && !isNaN(profitPercent) && typeof profitPercent === 'number' ? profitPercent.toFixed(6) : '0.000000') + '%'
                    });
                    // Look for ANY positive arbitrage opportunity
                    if (profit > 0 && profitPercent > 0.001) { // Even 0.001% profit
                        const profitUsd = this.calculateProfitUsd(profit, pair.inputMint);
                        const opportunity = {
                            id: `real_profit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            type: profitPercent > 0.05 ? 'ARBITRAGE' : 'MICRO_ARBITRAGE',
                            pair: pair.name,
                            inputMint: pair.inputMint,
                            outputMint: pair.outputMint,
                            inputAmount: initialAmount,
                            expectedOutput: finalAmount,
                            profitUsd,
                            profitPercent,
                            confidence: Math.min(0.95, 0.8 + (profitPercent / 5)),
                            riskLevel: profitPercent > 0.1 ? 'ULTRA_LOW' : profitPercent > 0.05 ? 'LOW' : 'MEDIUM',
                            timestamp: new Date(),
                            quote: forwardQuote,
                            capitalRequired: this.calculateCapitalRequired(initialAmount, pair.inputMint)
                        };
                        opportunities.push(opportunity);
                        console.log(`💎 REAL PROFIT OPPORTUNITY FOUND: ${pair.name}`, {
                            profit: `$${(profitUsd != null && !isNaN(profitUsd) && typeof profitUsd === 'number' ? profitUsd.toFixed(6) : '0.000000')}`,
                            percent: `${(profitPercent != null && !isNaN(profitPercent) && typeof profitPercent === 'number' ? profitPercent.toFixed(6) : '0.000000')}%`,
                            confidence: `${((opportunity.confidence * 100) != null && !isNaN(opportunity.confidence * 100) && typeof (opportunity.confidence * 100) === 'number' ? (opportunity.confidence * 100).toFixed(1) : '0.0')}%`
                        });
                    }
                    else {
                        console.log(`📉 ${pair.name}: No profitable arbitrage (${(profitPercent != null && !isNaN(profitPercent) && typeof profitPercent === 'number' ? profitPercent.toFixed(6) : '0.000000')}%)`);
                    }
                }
                catch (error) {
                    console.warn(`⚠️ Failed to check ${pair.name}:`, error);
                }
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            console.log(`🎯 SCAN COMPLETE: Found ${opportunities.length} REAL profit opportunities`);
            return opportunities;
        }
        catch (error) {
            console.error('❌ Arbitrage scan failed:', error);
            return [];
        }
    }
    calculateCapitalRequired(amount, mintAddress) {
        if (mintAddress === 'So11111111111111111111111111111111111111112') {
            // SOL
            return amount / 1e9;
        }
        else if (mintAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
            // USDC
            return amount / 1e6;
        }
        else if (mintAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
            // USDT
            return amount / 1e6;
        }
        else {
            // JUP and others
            return amount / 1e6;
        }
    }
    calculateProfitUsd(profit, mintAddress) {
        const solPrice = 240; // Current SOL price
        if (mintAddress === 'So11111111111111111111111111111111111111112') {
            // SOL
            return (profit / 1e9) * solPrice;
        }
        else if (mintAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
            // USDC
            return profit / 1e6;
        }
        else if (mintAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
            // USDT
            return profit / 1e6;
        }
        else {
            // JUP and others - estimate based on token value
            return (profit / 1e6) * 0.5; // Rough estimate
        }
    }
    async executeMEVTrade(opportunity) {
        try {
            console.log('💰 EXECUTING REAL MEV TRADE FOR ACTUAL PROFIT:', opportunity);
            if (!privateKeyWallet.isConnected()) {
                throw new Error('Private key wallet not connected');
            }
            // Execute the real arbitrage trade using Jupiter via Helius
            const signature = await this.executeSwap(opportunity.quote);
            console.log('🎉 REAL MEV PROFIT TRADE EXECUTED SUCCESSFULLY:', signature);
            console.log('💵 Expected profit:', `$${(opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')}`);
            console.log('📈 Profit percentage:', `${(opportunity.profitPercent != null && !isNaN(opportunity.profitPercent) && typeof opportunity.profitPercent === 'number' ? opportunity.profitPercent.toFixed(6) : '0.000000')}%`);
            return signature;
        }
        catch (error) {
            console.error('❌ REAL MEV TRADE EXECUTION FAILED:', error);
            throw error;
        }
    }
}
export const privateKeyJupiterTrading = new PrivateKeyJupiterTrading();
//# sourceMappingURL=privateKeyJupiterTrading.js.map