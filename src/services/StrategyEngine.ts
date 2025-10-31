export interface StrategyOpportunity {
  id: string;
  type: 'arbitrage' | 'momentum' | 'dca' | 'yield';
  pair: string;
  targetProfit: number;
  riskScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  timeToExecute: number;
  profitUsd: number;
  confidence: number;
  recommendedCapital: number;
  strategyName: string;
  outputMint?: string;
  executionPlan?: string[];
  executed?: boolean;
  txSignatures?: string[];
}

export interface StrategyResult {
  opportunityId: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  profitRealized?: number;
  timestamp: number;
}

class StrategyEngineImpl {
  private activeStrategies: Map<string, StrategyOpportunity> = new Map();
  private executionHistory: StrategyResult[] = [];
  private isRunning = false;

  async startAllStrategies(
    maxCapital: number,
    callback?: (opps: StrategyOpportunity[]) => Promise<void>
  ): Promise<void> {
    this.isRunning = true;

    // Continuously scan for opportunities every 2 seconds
    while (this.isRunning) {
      const opportunities: StrategyOpportunity[] = [
        {
          id: 'strat-' + Date.now(),
          type: 'arbitrage',
          pair: 'SOL/USDC',
          targetProfit: 100,
          riskScore: 0.3,
          riskLevel: 'LOW',
          timeToExecute: 5000,
          profitUsd: Math.random() * 50 + 10,
          confidence: Math.random() * 0.3 + 0.7,
          recommendedCapital: Math.min(maxCapital * 0.5, 5),
          strategyName: 'Cross-DEX Arbitrage',
          outputMint: 'EPjFWaLb3hyccqJ1D96R1q3dEYYGoBi6P7uwTduR1ag',
        },
        {
          id: 'strat-jit-' + Date.now(),
          type: 'arbitrage',
          pair: 'SOL/RAY',
          targetProfit: 75,
          riskScore: 0.25,
          riskLevel: 'LOW',
          timeToExecute: 3000,
          profitUsd: Math.random() * 35 + 5,
          confidence: Math.random() * 0.25 + 0.75,
          recommendedCapital: Math.min(maxCapital * 0.3, 3),
          strategyName: 'JIT Liquidity',
          outputMint: '4k3Dyjzvzp8eMZWUVbCnfiSuUKFF5ZW86PjoyMtCVLT5',
        },
      ];

      this.activeStrategies = new Map(opportunities.map(o => [o.id, o]));

      // Call the callback if provided
      if (callback) {
        try {
          await callback(opportunities);
        } catch (error) {
          console.error('Error in strategy callback:', error);
        }
      }

      this.isRunning = false;

      // Wait before next scan
      //await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async stopAllStrategies(): Promise<void> {
    this.isRunning = false;
    this.activeStrategies.clear();
  }

  getActiveStrategies(): StrategyOpportunity[] {
    return Array.from(this.activeStrategies.values());
  }

  getExecutionHistory(): StrategyResult[] {
    return this.executionHistory;
  }

  recordExecution(result: StrategyResult): void {
    this.executionHistory.push({ ...result, timestamp: Date.now() });
  }
}

export const strategyEngine = new StrategyEngineImpl();
