import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { realSolanaWallet } from './realSolanaWallet';

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
  }>;
}

export interface JupiterSwapResult {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface MEVOpportunity {
  id: string;
  type: 'ARBITRAGE' | 'SANDWICH' | 'LIQUIDATION' | 'MICRO_ARBITRAGE' | 'PRICE_RECOVERY';
  pair: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  profitUsd: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA_LOW';
  timestamp: Date;
  quote: JupiterQuote;
  capitalRequired: number;
}

interface TradingPair {
  name: string;
  inputMint: string;
  outputMint: string;
  baseAmount: number;
}

interface WalletAdapter {
  publicKey: PublicKey | null;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
}

export class RealJupiterTrading {
  private connection: Connection;
  private jupiterApiUrl = 'https://quote-api.jup.ag/v6';

  constructor() {
    this.connection = realSolanaWallet.getConnection();
  }

  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuote | null> {
    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false'
      });

      const response = await fetch(`${this.jupiterApiUrl}/quote?${params}`);
      
      if (!response.ok) {
        console.error('❌ Jupiter quote failed:', response.statusText);
        return null;
      }

      const quote = await response.json();
      console.log('✅ Jupiter quote received:', quote);
      return quote;
    } catch (error) {
      console.error('❌ Failed to get Jupiter quote:', error);
      return null;
    }
  }

  async getSwapTransaction(quote: JupiterQuote): Promise<JupiterSwapResult | null> {
    try {
      const wallet = realSolanaWallet.getWallet() as WalletAdapter;
      if (!wallet?.publicKey) {
        throw new Error('Wallet not connected');
      }

      const response = await fetch(`${this.jupiterApiUrl}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 200000
        }),
      });

      if (!response.ok) {
        console.error('❌ Jupiter swap transaction failed:', response.statusText);
        return null;
      }

      const swapResult = await response.json();
      console.log('✅ Jupiter swap transaction received');
      return swapResult;
    } catch (error) {
      console.error('❌ Failed to get swap transaction:', error);
      return null;
    }
  }

  async executeSwap(quote: JupiterQuote): Promise<string> {
    try {
      console.log('🔄 Executing real Jupiter swap...');
      
      // Get swap transaction
      const swapResult = await this.getSwapTransaction(quote);
      if (!swapResult) {
        throw new Error('Failed to get swap transaction');
      }

      // Deserialize transaction
      const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

      // Sign and send transaction
      const wallet = realSolanaWallet.getWallet() as WalletAdapter;
      if (!wallet) {
        throw new Error('Wallet not connected');
      }

      console.log('🔄 Signing swap transaction...');
      const signedTransaction = await wallet.signTransaction(transaction);

      console.log('📡 Sending swap to blockchain...');
      const signature = await this.connection.sendRawTransaction(signedTransaction.serialize());

      console.log('⏳ Confirming swap transaction...');
      await this.connection.confirmTransaction(signature, 'confirmed');

      console.log('✅ Swap executed successfully:', signature);
      return signature;
    } catch (error) {
      console.error('❌ Swap execution failed:', error);
      throw error;
    }
  }

  async scanForArbitrageOpportunities(): Promise<MEVOpportunity[]> {
    try {
      console.log('🔍 Scanning for real arbitrage opportunities...');
      
      const opportunities: MEVOpportunity[] = [];
      
      // Popular trading pairs on Solana
      const tradingPairs: TradingPair[] = [
        {
          name: 'SOL/USDC',
          inputMint: 'So11111111111111111111111111111111111111112', // SOL
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          baseAmount: 0.1 * 1e9 // 0.1 SOL in lamports
        },
        {
          name: 'SOL/USDT',
          inputMint: 'So11111111111111111111111111111111111111112', // SOL
          outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
          baseAmount: 0.1 * 1e9
        },
        {
          name: 'BONK/SOL',
          inputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
          outputMint: 'So11111111111111111111111111111111111111112', // SOL
          baseAmount: 1000000 * 1e5 // 1M BONK
        },
        {
          name: 'JUP/SOL',
          inputMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
          outputMint: 'So11111111111111111111111111111111111111112', // SOL
          baseAmount: 10 * 1e6 // 10 JUP
        }
      ];

      for (const pair of tradingPairs) {
        try {
          // Get quote for forward trade
          const forwardQuote = await this.getQuote(
            pair.inputMint,
            pair.outputMint,
            pair.baseAmount
          );

          if (!forwardQuote) continue;

          // Get quote for reverse trade
          const reverseQuote = await this.getQuote(
            pair.outputMint,
            pair.inputMint,
            parseInt(forwardQuote.outAmount)
          );

          if (!reverseQuote) continue;

          // Calculate potential profit
          const initialAmount = pair.baseAmount;
          const finalAmount = parseInt(reverseQuote.outAmount);
          const profit = finalAmount - initialAmount;
          const profitPercent = (profit / initialAmount) * 100;

          // Only consider profitable opportunities
          if (profit > 0 && profitPercent > 0.01) { // At least 0.01% profit
            const profitUsd = this.calculateProfitUsd(profit, pair.inputMint);
            
            const opportunity: MEVOpportunity = {
              id: `real_opp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              type: profitPercent > 0.1 ? 'ARBITRAGE' : 'MICRO_ARBITRAGE',
              pair: pair.name,
              inputMint: pair.inputMint,
              outputMint: pair.outputMint,
              inputAmount: initialAmount,
              expectedOutput: finalAmount,
              profitUsd,
              profitPercent,
              confidence: Math.min(0.95, 0.7 + (profitPercent / 10)),
              riskLevel: profitPercent > 0.5 ? 'LOW' : profitPercent > 0.1 ? 'MEDIUM' : 'HIGH',
              timestamp: new Date(),
              quote: forwardQuote,
              capitalRequired: initialAmount / 1e9 // Convert to SOL for display
            };

            opportunities.push(opportunity);
            console.log(`💎 Real arbitrage found: ${pair.name} - ${profitPercent.toFixed(4)}% profit`);
          }
        } catch (error) {
          console.warn(`⚠️ Failed to check ${pair.name}:`, error);
        }
      }

      console.log(`✅ Found ${opportunities.length} real arbitrage opportunities`);
      return opportunities;
    } catch (error) {
      console.error('❌ Arbitrage scan failed:', error);
      return [];
    }
  }

  private calculateProfitUsd(profit: number, mintAddress: string): number {
    // Simplified USD calculation - in production, you'd fetch real prices
    const solPrice = 222; // Approximate SOL price
    
    if (mintAddress === 'So11111111111111111111111111111111111111112') {
      // SOL
      return (profit / 1e9) * solPrice;
    } else if (mintAddress === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
      // USDC
      return profit / 1e6;
    } else if (mintAddress === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
      // USDT
      return profit / 1e6;
    } else {
      // For other tokens, estimate based on SOL equivalent
      return (profit / 1e6) * 0.001; // Very rough estimate
    }
  }

  async executeMEVTrade(opportunity: MEVOpportunity): Promise<string> {
    try {
      console.log('🚀 Executing REAL MEV trade:', opportunity);
      
      if (!realSolanaWallet.isConnected()) {
        throw new Error('Wallet not connected');
      }

      // Execute the arbitrage trade using Jupiter
      const signature = await this.executeSwap(opportunity.quote);
      
      console.log('✅ REAL MEV trade executed:', signature);
      return signature;
    } catch (error) {
      console.error('❌ REAL MEV trade failed:', error);
      throw error;
    }
  }
}

export const realJupiterTrading = new RealJupiterTrading();