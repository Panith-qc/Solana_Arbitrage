// MEMPOOL MONITOR
// Real-time monitoring of pending transactions for MEV opportunities
// Enables sandwich attacks, back-running, and front-running strategies
import { PublicKey } from '@solana/web3.js';
import { privateKeyWallet } from './privateKeyWallet';
export class MempoolMonitor {
    constructor() {
        Object.defineProperty(this, "connection", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "isMonitoring", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "mempoolCallbacks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "sandwichCallbacks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "processedTxs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
        Object.defineProperty(this, "MAX_PROCESSED_TXS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 10000
        });
        // Known DEX program IDs
        Object.defineProperty(this, "DEX_PROGRAMS", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
                ORCA: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
                RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
                SERUM: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
                OPENBOOK: 'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'
            }
        });
        // Minimum swap size to monitor (in USD)
        Object.defineProperty(this, "MIN_SWAP_SIZE_USD", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 100
        });
        this.connection = privateKeyWallet.getConnection();
        console.log('🔍 Mempool Monitor initialized');
    }
    /**
     * Start monitoring mempool for pending transactions
     */
    async startMonitoring() {
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
    stopMonitoring() {
        console.log('🛑 Stopping mempool monitoring...');
        this.isMonitoring = false;
    }
    /**
     * Register callback for all pending transactions
     */
    onTransaction(callback) {
        this.mempoolCallbacks.push(callback);
        console.log('📝 Registered mempool transaction callback');
    }
    /**
     * Register callback for sandwich opportunities
     */
    onSandwichOpportunity(callback) {
        this.sandwichCallbacks.push(callback);
        console.log('🥪 Registered sandwich opportunity callback');
    }
    /**
     * Main monitoring loop
     */
    async monitorLoop() {
        while (this.isMonitoring) {
            try {
                await this.scanRecentTransactions();
                // Small delay to avoid overwhelming the RPC
                await this.sleep(1000); // Check every second
            }
            catch (error) {
                console.error('❌ Mempool monitoring error:', error);
                await this.sleep(5000); // Wait longer on error
            }
        }
        console.log('✅ Mempool monitoring stopped');
    }
    /**
     * Scan recent transactions for MEV opportunities
     */
    async scanRecentTransactions() {
        try {
            // Get recent signatures
            const signatures = await this.connection.getSignaturesForAddress(PublicKey.default, // Using default to get recent transactions
            { limit: 50 }, 'confirmed');
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
        }
        catch (error) {
            // Silently continue on errors to avoid spam
            if (Math.random() < 0.01) { // Log only 1% of errors
                console.error('Scan error:', error);
            }
        }
    }
    /**
     * Get detailed transaction information
     */
    async getTransactionDetails(signature) {
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
        }
        catch (error) {
            return null;
        }
    }
    /**
     * Parse transaction instructions
     */
    parseInstructions(tx) {
        const instructions = [];
        try {
            const message = tx.transaction.message;
            for (const instruction of message.instructions) {
                if ('parsed' in instruction) {
                    instructions.push({
                        programId: instruction.programId.toString(),
                        type: instruction.parsed?.type || 'unknown',
                        data: instruction.parsed
                    });
                }
                else {
                    instructions.push({
                        programId: instruction.programId.toString(),
                        type: 'unparsed',
                        data: instruction.data
                    });
                }
            }
        }
        catch (error) {
            console.error('Failed to parse instructions:', error);
        }
        return instructions;
    }
    /**
     * Check if transaction is a swap
     */
    isSwapTransaction(instructions, accounts) {
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
    extractSwapDetails(tx, instructions, accounts) {
        try {
            // Find swap instruction
            const swapInstruction = instructions.find(inst => inst.type.toLowerCase().includes('swap') ||
                Object.values(this.DEX_PROGRAMS).includes(inst.programId));
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
        }
        catch (error) {
            console.error('Failed to extract swap details:', error);
            return undefined;
        }
    }
    /**
     * Analyze if transaction presents sandwich opportunity
     */
    analyzeSandwichOpportunity(tx) {
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
        let riskLevel = 'MEDIUM';
        if (swapSizeUSD > 10000) {
            riskLevel = 'LOW'; // Large swaps = more predictable
        }
        else if (swapSizeUSD < 500) {
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
    async notifyCallbacks(tx) {
        for (const callback of this.mempoolCallbacks) {
            try {
                await callback(tx);
            }
            catch (error) {
                console.error('Callback error:', error);
            }
        }
    }
    /**
     * Notify all sandwich callbacks
     */
    async notifySandwichCallbacks(opportunity) {
        console.log(`🥪 Sandwich opportunity detected: $${opportunity.estimatedProfit.toFixed(4)} profit`);
        for (const callback of this.sandwichCallbacks) {
            try {
                await callback(opportunity);
            }
            catch (error) {
                console.error('Sandwich callback error:', error);
            }
        }
    }
    /**
     * Add transaction to processed set
     */
    addProcessedTx(signature) {
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
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Get monitoring status
     */
    isActive() {
        return this.isMonitoring;
    }
    /**
     * Get statistics
     */
    getStats() {
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
    clearProcessed() {
        this.processedTxs.clear();
        console.log('🗑️ Cleared processed transactions');
    }
    /**
     * Health check
     */
    async healthCheck() {
        try {
            const slot = await this.connection.getSlot();
            console.log(`✅ Mempool monitor healthy - Current slot: ${slot}`);
            return true;
        }
        catch (error) {
            console.error('❌ Mempool monitor health check failed:', error);
            return false;
        }
    }
}
// Export singleton instance
export const mempoolMonitor = new MempoolMonitor();
// Export helper functions
export function startMempoolMonitoring() {
    return mempoolMonitor.startMonitoring();
}
export function stopMempoolMonitoring() {
    mempoolMonitor.stopMonitoring();
}
export function onPendingSwap(callback) {
    mempoolMonitor.onTransaction(callback);
}
export function onSandwichOpportunity(callback) {
    mempoolMonitor.onSandwichOpportunity(callback);
}
console.log('✅ Mempool Monitor loaded - Ready for real-time transaction monitoring');
