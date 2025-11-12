// ═══════════════════════════════════════════════════════════════════════════
// REAL STRATEGY ENGINE - NO MORE MOCK DATA
// ═══════════════════════════════════════════════════════════════════════════
// Uses REAL scanners with REAL Jupiter quotes
// Only returns REAL profitable opportunities (no simulations)
// ═══════════════════════════════════════════════════════════════════════════

import { realTriangularArbitrage, TriangularOpportunity } from './realTriangularArbitrage';
import { realCrossDexArbitrage, CrossDexOpportunity } from './realCrossDexArbitrage';

export interface StrategyOpportunity {
  id: string;
  type: 'arbitrage' | 'momentum' | 'dca' | 'yield';
  pair: string;
  targetProfit: number;
  riskScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA_LOW';
  timeToExecute: number;
  profitUsd: number;
  confidence: number;
  recommendedCapital: number;
  strategyName: string;
  outputMint?: string;
  executionPlan?: string[];
  executed?: boolean;
  txSignatures?: string[];
  profitPercent?: number;
}

export interface StrategyResult {
  opportunityId: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  profitRealized?: number;
  profitUsd?: number;
  success?: boolean;
  executionTimeMs?: number;
  txHash?: string;
  error?: string;
  timestamp: number;
  strategyName?: string;
}

class RealStrategyEngine {
  private isRunning = false;
  private activeStrategies = new Set<string>();
  private executionHistory: StrategyResult[] = [];
  private opportunityCallback: ((opps: StrategyOpportunity[]) => Promise<void>) | null = null;
  private accumulatedOpportunities: StrategyOpportunity[] = [];

  async startAllStrategies(
    maxCapital: number,
    callback?: (opps: StrategyOpportunity[]) => Promise<void>
  ): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Strategy engine already running');
      return;
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('🚀 STARTING REAL STRATEGY ENGINE - NO MOCK DATA');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`💰 Max Capital: ${maxCapital.toFixed(4)} SOL`);
    console.log(`📊 Strategies: Triangular + Cross-DEX Arbitrage`);
    console.log(`✅ All opportunities will be REAL with REAL Jupiter quotes`);
    console.log('═══════════════════════════════════════════════════════════');

    this.isRunning = true;
    this.opportunityCallback = callback || null;
    this.accumulatedOpportunities = [];

    // Start triangular arbitrage scanner
    console.log('\n🔺 Starting Triangular Arbitrage Scanner...');
    this.activeStrategies.add('TRIANGULAR_ARBITRAGE');
    
    realTriangularArbitrage.startScanning(
      maxCapital,
      0.3, // 0.3% minimum profit
      (opportunities) => this.handleTriangularOpportunities(opportunities)
    ).catch(err => {
      console.error('❌ Triangular arbitrage failed to start:', err);
      this.activeStrategies.delete('TRIANGULAR_ARBITRAGE');
    });

    // Start cross-DEX arbitrage scanner
    console.log('\n🔄 Starting Cross-DEX Arbitrage Scanner...');
    this.activeStrategies.add('CROSS_DEX_ARBITRAGE');
    
    realCrossDexArbitrage.startScanning(
      maxCapital,
      0.3, // 0.3% minimum profit
      (opportunities) => this.handleCrossDexOpportunities(opportunities)
    ).catch(err => {
      console.error('❌ Cross-DEX arbitrage failed to start:', err);
      this.activeStrategies.delete('CROSS_DEX_ARBITRAGE');
    });

    console.log('\n✅ ALL REAL STRATEGIES STARTED - CONTINUOUS SCANNING ACTIVE');
    console.log('═══════════════════════════════════════════════════════════\n');
  }

  async stopAllStrategies(): Promise<void> {
    console.log('⏹️ Stopping all strategies...');
    this.isRunning = false;

    // Stop all scanners
    realTriangularArbitrage.stopScanning();
    realCrossDexArbitrage.stopScanning();

    this.activeStrategies.clear();
    this.accumulatedOpportunities = [];
    console.log('✅ All strategies stopped');
  }

  /**
   * Handle triangular arbitrage opportunities
   */
  private async handleTriangularOpportunities(opportunities: TriangularOpportunity[]): Promise<void> {
    if (!this.isRunning) return;

    // Convert to StrategyOpportunity format
    const strategyOpps: StrategyOpportunity[] = opportunities.map(opp => ({
      id: opp.id,
      type: 'arbitrage' as const,
      pair: opp.pathNames.join(' → '),
      targetProfit: opp.profitUsd,
      riskScore: 1 - opp.confidence,
      riskLevel: opp.riskLevel,
      timeToExecute: 5000,
      profitUsd: opp.profitUsd,
      profitPercent: opp.profitPercent,
      confidence: opp.confidence,
      recommendedCapital: opp.inputAmount / 1_000_000_000,
      strategyName: opp.strategyName,
      outputMint: opp.path[1], // First token in the cycle
      executionPlan: opp.executionPlan
    }));

    // Add to accumulated opportunities
    this.accumulatedOpportunities.push(...strategyOpps);

    // Call callback if set
    if (this.opportunityCallback) {
      try {
        await this.opportunityCallback(strategyOpps);
      } catch (error) {
        console.error('❌ Opportunity callback error:', error);
      }
    }
  }

  /**
   * Handle cross-DEX arbitrage opportunities
   */
  private async handleCrossDexOpportunities(opportunities: CrossDexOpportunity[]): Promise<void> {
    if (!this.isRunning) return;

    // Convert to StrategyOpportunity format
    const strategyOpps: StrategyOpportunity[] = opportunities.map(opp => ({
      id: opp.id,
      type: 'arbitrage' as const,
      pair: opp.pair,
      targetProfit: opp.profitUsd,
      riskScore: 1 - opp.confidence,
      riskLevel: opp.riskLevel,
      timeToExecute: 3000,
      profitUsd: opp.profitUsd,
      profitPercent: opp.profitPercent,
      confidence: opp.confidence,
      recommendedCapital: opp.inputAmount / 1_000_000_000,
      strategyName: opp.strategyName,
      outputMint: opp.tokenMint,
      executionPlan: opp.executionPlan
    }));

    // Add to accumulated opportunities
    this.accumulatedOpportunities.push(...strategyOpps);

    // Call callback if set
    if (this.opportunityCallback) {
      try {
        await this.opportunityCallback(strategyOpps);
      } catch (error) {
        console.error('❌ Opportunity callback error:', error);
      }
    }
  }

  getActiveStrategies(): Map<string, StrategyOpportunity> {
    // Return as Map for compatibility
    const map = new Map<string, StrategyOpportunity>();
    this.accumulatedOpportunities.forEach(opp => map.set(opp.id, opp));
    return map;
  }

  getExecutionHistory(): StrategyResult[] {
    return this.executionHistory;
  }

  recordExecution(result: StrategyResult): void {
    this.executionHistory.push({ ...result, timestamp: Date.now() });
  }

  /**
   * Get scanner status for monitoring
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      activeStrategies: Array.from(this.activeStrategies),
      totalOpportunities: this.accumulatedOpportunities.length,
      triangularStatus: realTriangularArbitrage.getStatus(),
      crossDexStatus: realCrossDexArbitrage.getStatus()
    };
  }
}

export const strategyEngine = new RealStrategyEngine();

console.log('✅ Real Strategy Engine loaded - NO MOCK DATA, REAL PROFITS ONLY');
