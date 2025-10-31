export interface PriorityFeeRecommendation {
    min: number;
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
    extreme: number;
    recommended: number;
}
export interface FeeAnalysis {
    currentMedian: number;
    currentP75: number;
    currentP90: number;
    currentP95: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    congestionLevel: 'low' | 'medium' | 'high' | 'extreme';
    recommendation: PriorityFeeRecommendation;
}
export interface CompetitorAnalysis {
    averageFee: number;
    medianFee: number;
    topBotFees: number[];
    ourPosition: 'ahead' | 'competitive' | 'behind';
    recommendedIncrease: number;
}
export declare class PriorityFeeOptimizer {
    private connection;
    private feeHistory;
    private readonly MAX_HISTORY;
    private readonly UPDATE_INTERVAL;
    private updateTimer?;
    private readonly BASE_FEES;
    constructor();
    /**
     * Get recommended priority fee based on current network conditions
     * @param urgency How quickly the transaction needs to be processed
     * @param targetStrategy Type of MEV strategy (affects competition)
     */
    getRecommendedFee(urgency?: 'low' | 'medium' | 'high' | 'critical', targetStrategy?: 'arbitrage' | 'sandwich' | 'liquidation' | 'general'): Promise<number>;
    /**
     * Analyze current network fee conditions
     */
    analyzeFees(): Promise<FeeAnalysis>;
    /**
     * Get recent prioritization fees from the network
     */
    private getRecentPrioritizationFees;
    /**
     * Update fee history
     */
    private updateFeeHistory;
    /**
     * Calculate percentile from sorted array
     */
    private percentile;
    /**
     * Analyze fee trend (increasing, decreasing, stable)
     */
    private analyzeTrend;
    /**
     * Determine congestion level
     */
    private determineCongestion;
    /**
     * Create fee recommendation based on analysis
     */
    private createRecommendation;
    /**
     * Get default analysis when data is unavailable
     */
    private getDefaultAnalysis;
    /**
     * Analyze competitor bot fees (advanced)
     */
    analyzeCompetitors(targetAddress?: string): Promise<CompetitorAnalysis>;
    /**
     * Calculate optimal fee to beat specific transaction
     */
    calculateCompetitiveFee(targetFee: number, marginPercent?: number): number;
    /**
     * Start monitoring fees periodically
     * Balanced logging: Every 30 seconds
     */
    private startFeeMonitoring;
    /**
     * Stop monitoring
     */
    stopMonitoring(): void;
    /**
     * Get fee history for analysis
     */
    getFeeHistory(): number[];
    /**
     * Clear fee history
     */
    clearHistory(): void;
    /**
     * Health check
     */
    healthCheck(): Promise<boolean>;
}
export declare const priorityFeeOptimizer: PriorityFeeOptimizer;
export declare function getOptimalFee(urgency?: 'low' | 'medium' | 'high' | 'critical', strategy?: 'arbitrage' | 'sandwich' | 'liquidation'): Promise<number>;
//# sourceMappingURL=priorityFeeOptimizer.d.ts.map