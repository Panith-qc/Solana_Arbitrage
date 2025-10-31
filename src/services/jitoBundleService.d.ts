import { Transaction, VersionedTransaction, Keypair } from '@solana/web3.js';
export interface JitoBundleConfig {
    tipAccount: string;
    blockEngineUrl: string;
    minTipLamports: number;
    maxTipLamports: number;
    bundleId?: string;
}
export interface BundleTransaction {
    transaction: Transaction | VersionedTransaction;
    signers?: Keypair[];
}
export interface BundleResult {
    success: boolean;
    bundleId: string;
    transactions: string[];
    tipAmount: number;
    landedSlot?: number;
    error?: string;
    executionTime?: number;
}
export declare class JitoBundleService {
    private connection;
    private config;
    private static readonly JITO_ENDPOINTS;
    private static readonly TIP_ACCOUNTS;
    constructor();
    /**
     * Create and submit a Jito bundle for atomic MEV execution
     * @param transactions Array of transactions to bundle
     * @param tipAmount Tip amount in lamports (higher = better priority)
     * @returns Bundle result with transaction signatures
     */
    submitBundle(transactions: BundleTransaction[], tipAmount?: number): Promise<BundleResult>;
    /**
     * Create a sandwich bundle: front-run, victim transaction, back-run
     */
    createSandwichBundle(frontRunTx: Transaction, victimTx: Transaction, backRunTx: Transaction, tipAmount?: number): Promise<BundleResult>;
    /**
     * Create an arbitrage bundle: multiple swaps in atomic transaction
     */
    createArbitrageBundle(swapTransactions: Transaction[], tipAmount?: number): Promise<BundleResult>;
    /**
     * Create a liquidation bundle: liquidation + collateral claim
     */
    createLiquidationBundle(liquidationTx: Transaction, claimTx?: Transaction, tipAmount?: number): Promise<BundleResult>;
    /**
     * Calculate optimal tip based on bundle size and competition
     */
    private calculateOptimalTip;
    /**
     * Create tip transaction to Jito validator
     */
    private createTipTransaction;
    /**
     * Sign all transactions in bundle
     */
    private signTransactions;
    /**
     * Submit bundle to Jito Block Engine
     * Note: This is a simplified implementation
     * Full implementation would use Jito's SDK for proper bundle submission
     */
    private submitToBlockEngine;
    /**
     * Generate unique bundle ID
     */
    private generateBundleId;
    /**
     * Get bundle status from Jito
     * @param bundleId Bundle ID to check
     */
    getBundleStatus(bundleId: string): Promise<{
        status: 'pending' | 'landed' | 'failed';
        landedSlot?: number;
        transactions?: string[];
    }>;
    /**
     * Rotate to next Block Engine endpoint
     */
    rotateBlockEngine(): void;
    /**
     * Rotate to next tip account
     */
    rotateTipAccount(): void;
    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<JitoBundleConfig>): void;
    /**
     * Get current configuration
     */
    getConfig(): JitoBundleConfig;
    /**
     * Health check for Jito Block Engine
     */
    healthCheck(): Promise<boolean>;
}
export declare const jitoBundleService: JitoBundleService;
export declare function createMEVBundle(transactions: Transaction[], tipAmount?: number): Promise<BundleResult>;
//# sourceMappingURL=jitoBundleService.d.ts.map