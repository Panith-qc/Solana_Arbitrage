// MEMPOOL MONITOR
// Real-time monitoring of pending transactions for MEV opportunities
// Enables sandwich attacks, back-running, and front-running strategies

import { Connection, PublicKey, ParsedTransactionWithMeta, TransactionSignature } from '@solana/web3.js';
import { privateKeyWallet } from './privateKeyWallet';

export interface PendingTransaction {
  signature: string;
  slot: number;
  timestamp: Date;
  accounts: string[];
  instructions: ParsedInstruction[];
  fee: number;
  isSwap: boolean;
  swapDetails?: SwapDetails;
}

export interface SwapDetails {
  inputToken: string;
  outputToken: string;
  amountIn: number;
  estimatedAmountOut: number;
  swapProgram: string;
  userWallet: string;
  priceImpact?: number;
}

export interface ParsedInstruction {
  programId: string;
  type: string;
  data: any;
}

export interface SandwichOpportunity {
  targetTx: PendingTransaction;
  frontRunAmount: number;
  backRunAmount: number;
  estimatedProfit: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export type MempoolCallback = (transaction: PendingTransaction) => void | Promise<void>;
export type SandwichCallback = (opportunity: SandwichOpportunity) => void | Promise<void>;

export class MempoolMonitor {
  private connection: Connection;
  private isMonitoring = false;
  private mempoolCallbacks: MempoolCallback[] = [];
  private sandwichCallbacks: SandwichCallback[] = [];
  private processedTxs = new Set<string>();
  private readonly MAX_PROCESSED_TXS = 10000;

  // Known DEX program IDs
  private readonly DEX_PROGRAMS = {
    JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    ORCA: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
    RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    SERUM: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    OPENBOOK: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
  };

  // Minimum swap size to monitor (in USD)
  private readonly MIN_SWAP_SIZE_USD = 100;

  constructor() {
    this.connection = privateKeyWallet.getConnection();
    console.log('🔍 Mempool Monitor initialized');
  }

  /**
   * Start monitoring mempool for pending transactions
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      console.log('⚠️ Mempool monitor already running');
      return;
    }

    console.log('🚀 Starting mempool monitoring...');
    this.isMonitoring = true;

    // Start monitoring loop
    this.monitorLoop();
  }

  /**
   * Stop monitoring mempool
   */
  stopMonitoring(): void {
    console.log('🛑 Stopping mempool monitoring...');
    this.isMonitoring = false;
  }

  /**
   * Register callback for all pending transactions
   */
  onTransaction(callback: MempoolCallback): void {
    this.mempoolCallbacks.push(callback);
    console.log('📝 Registered mempool transaction callback');
  }

  /**
   * Register callback for sandwich opportunities
   */
  onSandwichOpportunity(callback: SandwichCallback): void {
    this.sandwichCallbacks.push(callback);
    console.log('🥪 Registered sandwich opportunity callback');
  }

  /**
   * Main monitoring loop
   */
  private async monitorLoop(): Promise<void> {
    while (this.isMonitoring) {
      try {
        await this.scanRecentTransactions();
        
        // Small delay to avoid overwhelming the RPC
        await this.sleep(1000); // Check every second
        
      } catch (error) {
        console.error('❌ Mempool monitoring error:', error);
        await this.sleep(5000); // Wait longer on error
      }
    }
    
    console.log('✅ Mempool monitoring stopped');
  }

  /**
   * Scan recent transactions for MEV opportunities
   */
  private async scanRecentTransactions(): Promise<void> {
    try {
      // Get recent signatures
      const signatures = await this.connection.getSignaturesForAddress(
        PublicKey.default, // Using default to get recent transactions
        { limit: 50 },
        'confirmed'
      );

      // Process each signature
      for (const sigInfo of signatures) {
        // Skip if already processed
        if (this.processedTxs.has(sigInfo.signature)) {
          continue;
        }

        // Get transaction details
        const tx = await this.getTransactionDetails(sigInfo.signature);
        
        if (tx && tx.isSwap) {
          // Mark as processed
          this.addProcessedTx(sigInfo.signature);
          
          // Notify callbacks
          await this.notifyCallbacks(tx);
          
          // Check for sandwich opportunity
          const sandwichOpp = this.analyzeSandwichOpportunity(tx);
          if (sandwichOpp) {
            await this.notifySandwichCallbacks(sandwichOpp);
          }
        }
      }

    } catch (error) {
      // Silently continue on errors to avoid spam
      if (Math.random() < 0.01) { // Log only 1% of errors
        console.error('Scan error:', error);
      }
    }
  }

  /**
   * Get detailed transaction information
   */
  private async getTransactionDetails(signature: string): Promise<PendingTransaction | null> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || !tx.transaction) {
        return null;
      }

      // Parse transaction
      const accounts = tx.transaction.message.accountKeys.map(key => key.pubkey.toString());
      const instructions = this.parseInstructions(tx);
      const fee = tx.meta?.fee || 0;
      
      // Check if it's a swap
      const isSwap = this.isSwapTransaction(instructions, accounts);
      const swapDetails = isSwap ? this.extractSwapDetails(tx, instructions, accounts) : undefined;

      return {
        signature,
        slot: tx.slot,
        timestamp: new Date(tx.blockTime ? tx.blockTime * 1000 : Date.now()),
        accounts,
        instructions,
        fee,
        isSwap,
        swapDetails
      };

    } catch (error) {
      return null;
    }
  }

  /**
   * Parse transaction instructions
   */
  private parseInstructions(tx: ParsedTransactionWithMeta): ParsedInstruction[] {
    const instructions: ParsedInstruction[] = [];
    
    try {
      const message = tx.transaction.message;
      
      for (const instruction of message.instructions) {
        if ('parsed' in instruction) {
          instructions.push({
            programId: instruction.programId.toString(),
            type: instruction.parsed?.type || 'unknown',
            data: instruction.parsed
          });
        } else {
          instructions.push({
            programId: instruction.programId.toString(),
            type: 'unparsed',
            data: instruction.data
          });
        }
      }
    } catch (error) {
      console.error('Failed to parse instructions:', error);
    }
    
    return instructions;
  }

  /**
   * Check if transaction is a swap
   */
  private isSwapTransaction(instructions: ParsedInstruction[], accounts: string[]): boolean {
    // Check if any instruction is from known DEX programs
    for (const instruction of instructions) {
      const programId = instruction.programId;
      
      if (Object.values(this.DEX_PROGRAMS).includes(programId)) {
        return true;
      }
      
      // Check for swap-like types
      if (instruction.type.toLowerCase().includes('swap')) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Extract swap details from transaction
   */
  private extractSwapDetails(
    tx: ParsedTransactionWithMeta,
    instructions: ParsedInstruction[],
    accounts: string[]
  ): SwapDetails | undefined {
    try {
      // Find swap instruction
      const swapInstruction = instructions.find(inst => 
        inst.type.toLowerCase().includes('swap') ||
        Object.values(this.DEX_PROGRAMS).includes(inst.programId)
      );

      if (!swapInstruction) {
        return undefined;
      }

      // Extract token accounts and amounts
      // This is simplified - full implementation would parse actual token transfers
      const inputToken = accounts[1] || 'unknown';
      const outputToken = accounts[2] || 'unknown';
      
      return {
        inputToken,
        outputToken,
        amountIn: 0, // Would be parsed from token transfer
        estimatedAmountOut: 0, // Would be parsed from token transfer
        swapProgram: swapInstruction.programId,
        userWallet: accounts[0] || 'unknown'
      };

    } catch (error) {
      console.error('Failed to extract swap details:', error);
      return undefined;
    }
  }

  /**
   * Analyze if transaction presents sandwich opportunity
   */
  private analyzeSandwichOpportunity(tx: PendingTransaction): SandwichOpportunity | null {
    if (!tx.swapDetails) {
      return null;
    }

    // Check swap size
    const swapSizeUSD = tx.swapDetails.amountIn * 0.01; // Simplified - would use real price
    
    if (swapSizeUSD < this.MIN_SWAP_SIZE_USD) {
      return null; // Too small to sandwich profitably
    }

    // Estimate sandwich parameters
    const frontRunAmount = swapSizeUSD * 0.1; // Front-run with 10% of target size
    const backRunAmount = frontRunAmount; // Back-run with same amount
    
    // Estimate profit (simplified)
    // Real calculation would use price impact formulas
    const estimatedProfit = swapSizeUSD * 0.001; // 0.1% of swap size
    
    // Must be profitable after fees
    if (estimatedProfit < 0.01) {
      return null;
    }

    // Determine risk level
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM';
    if (swapSizeUSD > 10000) {
      riskLevel = 'LOW'; // Large swaps = more predictable
    } else if (swapSizeUSD < 500) {
      riskLevel = 'HIGH'; // Small swaps = less predictable
    }

    // Confidence based on swap size and liquidity
    const confidence = Math.min(0.95, 0.6 + (swapSizeUSD / 10000) * 0.3);

    return {
      targetTx: tx,
      frontRunAmount,
      backRunAmount,
      estimatedProfit,
      confidence,
      riskLevel
    };
  }

  /**
   * Notify all mempool callbacks
   */
  private async notifyCallbacks(tx: PendingTransaction): Promise<void> {
    for (const callback of this.mempoolCallbacks) {
      try {
        await callback(tx);
      } catch (error) {
        console.error('Callback error:', error);
      }
    }
  }

  /**
   * Notify all sandwich callbacks
   */
  private async notifySandwichCallbacks(opportunity: SandwichOpportunity): Promise<void> {
    console.log(`🥪 Sandwich opportunity detected: $${opportunity.estimatedProfit.toFixed(4)} profit`);
    
    for (const callback of this.sandwichCallbacks) {
      try {
        await callback(opportunity);
      } catch (error) {
        console.error('Sandwich callback error:', error);
      }
    }
  }

  /**
   * Add transaction to processed set
   */
  private addProcessedTx(signature: string): void {
    this.processedTxs.add(signature);
    
    // Limit set size
    if (this.processedTxs.size > this.MAX_PROCESSED_TXS) {
      const signatures = Array.from(this.processedTxs);
      this.processedTxs = new Set(signatures.slice(-this.MAX_PROCESSED_TXS));
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get monitoring status
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Get statistics
   */
  getStats(): {
    isMonitoring: boolean;
    processedTxCount: number;
    callbackCount: number;
    sandwichCallbackCount: number;
  } {
    return {
      isMonitoring: this.isMonitoring,
      processedTxCount: this.processedTxs.size,
      callbackCount: this.mempoolCallbacks.length,
      sandwichCallbackCount: this.sandwichCallbacks.length
    };
  }

  /**
   * Clear processed transactions
   */
  clearProcessed(): void {
    this.processedTxs.clear();
    console.log('🗑️ Cleared processed transactions');
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const slot = await this.connection.getSlot();
      console.log(`✅ Mempool monitor healthy - Current slot: ${slot}`);
      return true;
    } catch (error) {
      console.error('❌ Mempool monitor health check failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const mempoolMonitor = new MempoolMonitor();

// Export helper functions
export function startMempoolMonitoring(): Promise<void> {
  return mempoolMonitor.startMonitoring();
}

export function stopMempoolMonitoring(): void {
  mempoolMonitor.stopMonitoring();
}

export function onPendingSwap(callback: MempoolCallback): void {
  mempoolMonitor.onTransaction(callback);
}

export function onSandwichOpportunity(callback: SandwichCallback): void {
  mempoolMonitor.onSandwichOpportunity(callback);
}

console.log('✅ Mempool Monitor loaded - Ready for real-time transaction monitoring');
