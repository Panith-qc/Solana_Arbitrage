export interface CompetitorData {
    id: string;
    name: string;
    winRate: number;
    totalTrades: number;
    avgProfit: number;
    lastActive: string;
    strategy: string;
    riskLevel: 'low' | 'medium' | 'high';
}
export declare class CompetitionAnalyzer {
    private baseUrl;
    getCompetitorData(): Promise<CompetitorData[]>;
    analyzeMarketPosition(userStats: any): Promise<{
        rank: number;
        percentile: number;
        recommendation: string;
    }>;
}
export declare const competitionAnalyzer: CompetitionAnalyzer;
//# sourceMappingURL=competitionAnalyzer.d.ts.map