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
export declare class MempoolMonitor {
    private connection;
    private isMonitoring;
    private mempoolCallbacks;
    private sandwichCallbacks;
    private processedTxs;
    private readonly MAX_PROCESSED_TXS;
    private readonly DEX_PROGRAMS;
    private readonly MIN_SWAP_SIZE_USD;
    constructor();
    /**
     * Start monitoring mempool for pending transactions
     */
    startMonitoring(): Promise<void>;
    /**
     * Stop monitoring mempool
     */
    stopMonitoring(): void;
    /**
     * Register callback for all pending transactions
     */
    onTransaction(callback: MempoolCallback): void;
    /**
     * Register callback for sandwich opportunities
     */
    onSandwichOpportunity(callback: SandwichCallback): void;
    /**
     * Main monitoring loop
     */
    private monitorLoop;
    /**
     * Scan recent transactions for MEV opportunities
     */
    private scanRecentTransactions;
    /**
     * Get detailed transaction information
     */
    private getTransactionDetails;
    /**
     * Parse transaction instructions
     */
    private parseInstructions;
    /**
     * Check if transaction is a swap
     */
    private isSwapTransaction;
    /**
     * Extract swap details from transaction
     */
    private extractSwapDetails;
    /**
     * Analyze if transaction presents sandwich opportunity
     */
    private analyzeSandwichOpportunity;
    /**
     * Notify all mempool callbacks
     */
    private notifyCallbacks;
    /**
     * Notify all sandwich callbacks
     */
    private notifySandwichCallbacks;
    /**
     * Add transaction to processed set
     */
    private addProcessedTx;
    /**
     * Sleep utility
     */
    private sleep;
    /**
     * Get monitoring status
     */
    isActive(): boolean;
    /**
     * Get statistics
     */
    getStats(): {
        isMonitoring: boolean;
        processedTxCount: number;
        callbackCount: number;
        sandwichCallbackCount: number;
    };
    /**
     * Clear processed transactions
     */
    clearProcessed(): void;
    /**
     * Health check
     */
    healthCheck(): Promise<boolean>;
}
export declare const mempoolMonitor: MempoolMonitor;
export declare function startMempoolMonitoring(): Promise<void>;
export declare function stopMempoolMonitoring(): void;
export declare function onPendingSwap(callback: MempoolCallback): void;
export declare function onSandwichOpportunity(callback: SandwichCallback): void;
//# sourceMappingURL=mempoolMonitor.d.ts.map