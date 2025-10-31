import { PendingTransaction } from './mempoolMonitor';
export interface JITOpportunity {
    id: string;
    targetSwap: PendingTransaction;
    pool: {
        address: string;
        token0: string;
        token1: string;
        currentPrice: number;
        liquidity: number;
    };
    liquidityToAdd: number;
    expectedFees: number;
    netProfit: number;
    confidence: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    priceRange: {
        lower: number;
        upper: number;
    };
}
export interface JITResult {
    success: boolean;
    opportunityId: string;
    solInvested: number;
    feesEarned: number;
    impermanentLoss: number;
    netProfitSol: number;
    txHashes: string[];
    executionTimeMs: number;
    error?: string;
}
export declare class JITLiquidityService {
    private connection;
    private isMonitoring;
    private activePositions;
    private readonly SUPPORTED_DEXS;
    private readonly MIN_SWAP_SIZE_USD;
    private readonly FEE_TIERS;
    constructor();
    /**
     * Start monitoring for JIT opportunities
     * PRINCIPLE: Only SOL-based pairs (always return to SOL)
     */
    startMonitoring(): Promise<void>;
    /**
     * Stop monitoring
     */
    stopMonitoring(): void;
    /**
     * Check if swap involves SOL
     */
    private isSOLPair;
    /**
     * Analyze if swap presents JIT opportunity
     * PRINCIPLE: Only add liquidity if we can profit in SOL
     */
    private analyzeJITOpportunity;
    /**
     * Execute JIT liquidity strategy
     * FLOW: SOL → Add Liquidity → Wait for Swap → Remove → SOL + Profit
     */
    executeJIT(opportunity: JITOpportunity): Promise<JITResult>;
    /**
     * Calculate optimal liquidity amount (in SOL)
     */
    private calculateOptimalLiquidity;
    /**
     * Estimate fees earned (in SOL)
     */
    private estimateFees;
    /**
     * Estimate impermanent loss (in SOL)
     */
    private estimateImpermanentLoss;
    /**
     * Calculate price range for concentrated liquidity
     */
    private calculatePriceRange;
    /**
     * Calculate confidence score
     */
    private calculateConfidence;
    /**
     * Assess risk level
     */
    private assessRiskLevel;
    /**
     * Estimate swap size
     */
    private estimateSwapSize;
    /**
     * Add liquidity to pool
     * NOTE: In production, this would use Orca/Raydium SDK
     */
    private addLiquidity;
    /**
     * Wait for target swap to execute
     */
    private waitForSwap;
    /**
     * Remove liquidity from pool (return to SOL)
     */
    private removeLiquidity;
    /**
     * Get active positions
     */
    getActivePositions(): JITOpportunity[];
    /**
     * Get monitoring status
     */
    isActive(): boolean;
    /**
     * Health check
     */
    healthCheck(): Promise<boolean>;
}
export declare const jitLiquidityService: JITLiquidityService;
export declare function startJITLiquidity(): Promise<void>;
//# sourceMappingURL=jitLiquidityService.d.ts.map