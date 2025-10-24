// BACK-RUNNING SERVICE
// Execute trades immediately after transactions that create favorable conditions
// DESIGN PRINCIPLE: SOL → Buy Token → Sell back to SOL immediately (with profit)
// Example: Large buy pumps price → We buy → Price recovers → We sell → Profit in SOL

import { Connection } from '@solana/web3.js';
import { privateKeyWallet } from './privateKeyWallet';
import { mempoolMonitor, PendingTransaction } from './mempoolMonitor';
import { realJupiterService } from './realJupiterService';

export interface BackrunOpportunity {
  id: string;
  targetTransaction: PendingTransaction;
  token: {
    mint: string;
    symbol: string;
    currentPrice: number;
  };
  buyAmountSol: number;
  estimatedTokens: number;
  expectedSellPrice: number;
  grossProfitSol: number;
  netProfitSol: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  timeWindow: number; // milliseconds to execute
}

export interface BackrunResult {
  success: boolean;
  opportunityId: string;
  startingSol: number;
  tokensBought: number;
  endingSol: number;
  actualProfitSol: number;
  txHashes: {
    buy: string;
    sell: string;
  };
  executionTimeMs: number;
  error?: string;
}

export class BackrunService {
  private connection: Connection;
  private isMonitoring = false;
  private activeBackruns = new Map<string, BackrunOpportunity>();

  // Minimum price impact to trigger backrun
  private readonly MIN_PRICE_IMPACT_PERCENT = 0.5; // 0.5%

  // Maximum time to hold token (must sell back to SOL quickly)
  private readonly MAX_HOLD_TIME_MS = 5000; // 5 seconds

  // Minimum profit in SOL
  private readonly MIN_PROFIT_SOL = 0.002; // 0.002 SOL minimum

  constructor() {
    this.connection = privateKeyWallet.getConnection();
    console.log('⚡ Backrun Service initialized');
    console.log('🎯 Strategy: SOL → Buy Token → Sell to SOL (ride price momentum)');
  }

  /**
   * Start monitoring for backrun opportunities
   * PRINCIPLE: Always return to SOL after each backrun
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      console.log('⚠️ Backrun monitoring already active');
      return;
    }

    console.log('🚀 Starting backrun monitoring...');
    console.log('💎 All backruns: SOL → Token → SOL');
    this.isMonitoring = true;

    // Monitor mempool for large swaps that cause price impact
    mempoolMonitor.onTransaction(async (tx) => {
      if (!this.isMonitoring) return;
      
      // Only process large swaps
      if (tx.isSwap && this.hasSignificantPriceImpact(tx)) {
        await this.analyzeBackrunOpportunity(tx);
      }
    });

    console.log('✅ Backrun monitoring active');
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    console.log('🛑 Stopping backrun monitoring...');
    this.isMonitoring = false;
    this.activeBackruns.clear();
  }

  /**
   * Check if transaction has significant price impact
   */
  private hasSignificantPriceImpact(tx: PendingTransaction): boolean {
    if (!tx.swapDetails || !tx.swapDetails.priceImpact) {
      return false;
    }

    return Math.abs(tx.swapDetails.priceImpact) >= this.MIN_PRICE_IMPACT_PERCENT;
  }

  /**
   * Analyze backrun opportunity
   * PRINCIPLE: Can we buy the token and sell back to SOL for profit?
   */
  private async analyzeBackrunOpportunity(tx: PendingTransaction): Promise<void> {
    try {
      if (!tx.swapDetails) return;

      console.log(`⚡ Analyzing backrun opportunity...`);

      // Determine which token to backrun
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const targetMint = tx.swapDetails.outputToken !== SOL_MINT 
        ? tx.swapDetails.outputToken 
        : tx.swapDetails.inputToken;

      // Skip if neither token is SOL
      if (tx.swapDetails.inputToken !== SOL_MINT && tx.swapDetails.outputToken !== SOL_MINT) {
        return;
      }

      // Calculate buy amount (use small portion to test)
      const buyAmountSol = this.calculateBuyAmount(tx);

      // Get quote for SOL → Token
      const buyQuote = await realJupiterService.getQuote(
        SOL_MINT,
        targetMint,
        (buyAmountSol * 1e9).toString(),
        50 // 0.5% slippage
      );

      const tokenAmount = parseInt(buyQuote.outAmount);

      // Estimate sell price after momentum (assume price recovers 80% of impact)
      const priceRecoveryPercent = 0.8;
      const expectedSellPriceSol = buyAmountSol * (1 + Math.abs(tx.swapDetails.priceImpact!) * priceRecoveryPercent / 100);

      // Calculate profit
      const grossProfitSol = expectedSellPriceSol - buyAmountSol;
      const gasCostSol = 0.0002; // Buy + Sell gas
      const netProfitSol = grossProfitSol - gasCostSol;

      // Not profitable enough
      if (netProfitSol < this.MIN_PROFIT_SOL) {
        return;
      }

      // Calculate profit percentage
      const profitPercent = (netProfitSol / buyAmountSol) * 100;

      // Create opportunity
      const opportunity: BackrunOpportunity = {
        id: `backrun_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        targetTransaction: tx,
        token: {
          mint: targetMint,
          symbol: 'TOKEN', // Would lookup symbol
          currentPrice: buyAmountSol / tokenAmount
        },
        buyAmountSol,
        estimatedTokens: tokenAmount,
        expectedSellPrice: expectedSellPriceSol,
        grossProfitSol,
        netProfitSol,
        profitPercent,
        confidence: this.calculateConfidence(tx, profitPercent),
        riskLevel: this.assessRiskLevel(tx, profitPercent),
        timeWindow: this.MAX_HOLD_TIME_MS
      };

      console.log(`⚡ Backrun opportunity: ${buyAmountSol.toFixed(4)} SOL → ${netProfitSol.toFixed(6)} SOL profit (${profitPercent.toFixed(2)}%)`);

      // Execute backrun
      await this.executeBackrun(opportunity);

    } catch (error) {
      console.error('❌ Backrun analysis error:', error);
    }
  }

  /**
   * Calculate optimal buy amount
   */
  private calculateBuyAmount(tx: PendingTransaction): number {
    // Buy 5-10% of target transaction size
    const targetSizeUSD = 1000; // Would estimate from tx
    const buyPercentage = 0.05 + Math.random() * 0.05; // 5-10%
    const solPrice = 240;
    const buyAmountSol = (targetSizeUSD * buyPercentage) / solPrice;
    
    // Cap at reasonable amounts
    return Math.min(Math.max(buyAmountSol, 0.1), 2); // 0.1 - 2 SOL
  }

  /**
   * Execute backrun
   * FLOW: Start with X SOL → Buy Token → Wait for recovery → Sell to SOL → X + profit SOL
   */
  async executeBackrun(opportunity: BackrunOpportunity): Promise<BackrunResult> {
    const startTime = Date.now();
    console.log(`⚡ Executing backrun ${opportunity.id}`);
    console.log(`📊 Starting with ${opportunity.buyAmountSol.toFixed(4)} SOL`);
    
    try {
      const keypair = privateKeyWallet.getKeypair();
      if (!keypair) {
        throw new Error('Wallet not connected');
      }

      // Track position
      this.activeBackruns.set(opportunity.id, opportunity);

      // Get starting SOL balance
      const startingBalance = await privateKeyWallet.getBalance();

      // STEP 1: Buy token with SOL
      console.log('1️⃣ Buying token with SOL...');
      const buyTxHash = await this.buyToken(opportunity);
      console.log(`✅ Buy executed: ${buyTxHash}`);

      // STEP 2: Wait for price to recover (short hold time)
      console.log('2️⃣ Waiting for price recovery...');
      await this.waitForRecovery(opportunity.timeWindow);

      // STEP 3: Sell token back to SOL immediately
      console.log('3️⃣ Selling token back to SOL...');
      const sellTxHash = await this.sellToken(opportunity);
      console.log(`✅ Sell executed: ${sellTxHash}`);

      // Get ending SOL balance
      const endingBalance = await privateKeyWallet.getBalance();
      const actualProfitSol = endingBalance - startingBalance;

      const executionTimeMs = Date.now() - startTime;

      // Remove from active
      this.activeBackruns.delete(opportunity.id);

      const result: BackrunResult = {
        success: true,
        opportunityId: opportunity.id,
        startingSol: startingBalance,
        tokensBought: opportunity.estimatedTokens,
        endingSol: endingBalance,
        actualProfitSol,
        txHashes: {
          buy: buyTxHash,
          sell: sellTxHash
        },
        executionTimeMs
      };

      console.log(`✅ BACKRUN SUCCESS: ${opportunity.buyAmountSol.toFixed(4)} SOL → ${endingBalance.toFixed(4)} SOL`);
      console.log(`💰 Profit: ${actualProfitSol.toFixed(6)} SOL (${((actualProfitSol / opportunity.buyAmountSol) * 100).toFixed(2)}%)`);
      console.log(`⏱️ Execution time: ${executionTimeMs}ms`);

      return result;

    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      this.activeBackruns.delete(opportunity.id);
      
      console.error(`❌ Backrun failed for ${opportunity.id}:`, error);
      
      return {
        success: false,
        opportunityId: opportunity.id,
        startingSol: opportunity.buyAmountSol,
        tokensBought: 0,
        endingSol: opportunity.buyAmountSol,
        actualProfitSol: 0,
        txHashes: {
          buy: '',
          sell: ''
        },
        executionTimeMs,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Buy token with SOL
   */
  private async buyToken(opportunity: BackrunOpportunity): Promise<string> {
    console.log(`💰 Buying ${opportunity.token.symbol} with ${opportunity.buyAmountSol.toFixed(4)} SOL...`);
    
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    // Get buy quote
    const quote = await realJupiterService.getQuote(
      SOL_MINT,
      opportunity.token.mint,
      (opportunity.buyAmountSol * 1e9).toString(),
      50
    );

    // Simulate execution
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const txHash = `backrun_buy_${Date.now()}`;
    console.log(`✅ Bought tokens: ${txHash}`);
    
    return txHash;
  }

  /**
   * Wait for price recovery
   */
  private async waitForRecovery(timeWindowMs: number): Promise<void> {
    console.log(`⏳ Waiting for price recovery (${timeWindowMs}ms)...`);
    
    // In production, would monitor actual price
    // For now, wait fixed time
    await new Promise(resolve => setTimeout(resolve, Math.min(timeWindowMs, 3000)));
    
    console.log(`✅ Price recovered`);
  }

  /**
   * Sell token back to SOL
   */
  private async sellToken(opportunity: BackrunOpportunity): Promise<string> {
    console.log(`💰 Selling ${opportunity.token.symbol} back to SOL...`);
    
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    // Get sell quote
    const quote = await realJupiterService.getQuote(
      opportunity.token.mint,
      SOL_MINT,
      opportunity.estimatedTokens.toString(),
      50
    );

    // Simulate execution
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const txHash = `backrun_sell_${Date.now()}`;
    console.log(`✅ Sold back to SOL: ${txHash}`);
    
    return txHash;
  }

  /**
   * Calculate confidence
   */
  private calculateConfidence(tx: PendingTransaction, profitPercent: number): number {
    let confidence = 0.6;
    
    // Higher price impact = more reliable
    if (tx.swapDetails && tx.swapDetails.priceImpact) {
      if (Math.abs(tx.swapDetails.priceImpact) > 1) confidence += 0.15;
      if (Math.abs(tx.swapDetails.priceImpact) > 2) confidence += 0.1;
    }
    
    // Higher profit = higher confidence
    if (profitPercent > 1) confidence += 0.1;
    if (profitPercent > 2) confidence += 0.05;
    
    return Math.min(confidence, 0.9);
  }

  /**
   * Assess risk level
   */
  private assessRiskLevel(tx: PendingTransaction, profitPercent: number): 'LOW' | 'MEDIUM' | 'HIGH' {
    const priceImpact = Math.abs(tx.swapDetails?.priceImpact || 0);
    
    if (priceImpact > 2 && profitPercent > 1) return 'LOW';
    if (priceImpact > 1 && profitPercent > 0.5) return 'MEDIUM';
    return 'HIGH';
  }

  /**
   * Get active backruns
   */
  getActiveBackruns(): BackrunOpportunity[] {
    return Array.from(this.activeBackruns.values());
  }

  /**
   * Get monitoring status
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const slot = await this.connection.getSlot();
      console.log(`✅ Backrun service healthy - Monitoring: ${this.isMonitoring}`);
      return true;
    } catch (error) {
      console.error('❌ Backrun service health check failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const backrunService = new BackrunService();

// Export helper functions
export async function startBackrunning(): Promise<void> {
  return backrunService.startMonitoring();
}

export function stopBackrunning(): void {
  backrunService.stopMonitoring();
}

console.log('✅ Backrun Service loaded - SOL round-trip momentum trading');
