import { crossDexArbitrageService, type ArbitrageOpportunity } from './crossDexArbitrageService';
import { microMevService, type MevOpportunity } from './microMevService';
import { enhancedCorsProxy } from './enhancedCorsProxy';

export interface StrategyConfig {
  enabled: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  maxCapital: number;
  minProfit: number;
  maxSlippage: number;
}

export interface StrategyMetrics {
  totalTrades: number;
  successfulTrades: number;
  totalProfit: number;
  totalVolume: number;
  winRate: number;
  avgProfit: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
  type: 'ARBITRAGE' | 'MEV' | 'LIQUIDATION' | 'GRID' | 'DCA';
  status: 'ACTIVE' | 'PAUSED' | 'STOPPED';
  config: StrategyConfig;
  metrics: StrategyMetrics;
  lastUpdate: number;
}

interface ProxyStatus {
  name: string;
  active: boolean;
  failures: number;
  lastSuccess: number;
}

class StrategyEngine {
  private strategies: Map<string, Strategy> = new Map();
  private allOpportunities: (ArbitrageOpportunity | MevOpportunity)[] = [];
  private callback: ((opportunities: (ArbitrageOpportunity | MevOpportunity)[]) => void) | null = null;
  private isRunning = false;

  constructor() {
    this.initializeDefaultStrategies();
    this.setupCallbacks();
  }

  private initializeDefaultStrategies(): void {
    const defaultStrategies: Strategy[] = [
      {
        id: 'cross-dex-arbitrage',
        name: 'Cross-DEX Arbitrage',
        description: 'Exploit price differences between Jupiter, Raydium, and Orca',
        type: 'ARBITRAGE',
        status: 'STOPPED',
        config: {
          enabled: false,
          riskLevel: 'MEDIUM',
          maxCapital: 1000,
          minProfit: 0.01,
          maxSlippage: 1.0
        },
        metrics: {
          totalTrades: 0,
          successfulTrades: 0,
          totalProfit: 0,
          totalVolume: 0,
          winRate: 0,
          avgProfit: 0,
          maxDrawdown: 0,
          sharpeRatio: 0
        },
        lastUpdate: Date.now()
      },
      {
        id: 'micro-mev',
        name: 'Micro-MEV',
        description: 'Capture small MEV opportunities through sandwich attacks and frontrunning',
        type: 'MEV',
        status: 'STOPPED',
        config: {
          enabled: false,
          riskLevel: 'HIGH',
          maxCapital: 500,
          minProfit: 0.02,
          maxSlippage: 0.5
        },
        metrics: {
          totalTrades: 0,
          successfulTrades: 0,
          totalProfit: 0,
          totalVolume: 0,
          winRate: 0,
          avgProfit: 0,
          maxDrawdown: 0,
          sharpeRatio: 0
        },
        lastUpdate: Date.now()
      }
    ];

    defaultStrategies.forEach(strategy => {
      this.strategies.set(strategy.id, strategy);
    });
  }

  private setupCallbacks(): void {
    // Set up callbacks to receive opportunities from services
    crossDexArbitrageService.setCallback((opportunities: ArbitrageOpportunity[]) => {
      console.log(`📊 Received ${opportunities.length} arbitrage opportunities`);
      this.updateOpportunities(opportunities, 'arbitrage');
    });

    microMevService.setCallback((opportunities: MevOpportunity[]) => {
      console.log(`📊 Received ${opportunities.length} MEV opportunities`);
      this.updateOpportunities(opportunities, 'mev');
    });
  }

  private updateOpportunities(newOpportunities: (ArbitrageOpportunity | MevOpportunity)[], type: string): void {
    // Remove old opportunities of this type
    this.allOpportunities = this.allOpportunities.filter(opp => {
      if (type === 'arbitrage') {
        return !('mevType' in opp); // Keep MEV opportunities
      } else {
        return 'mevType' in opp; // Keep only MEV opportunities
      }
    });

    // Add new opportunities
    this.allOpportunities.push(...newOpportunities);

    // Sort by profit descending
    this.allOpportunities.sort((a, b) => b.profit - a.profit);

    // Limit to top 50 opportunities
    this.allOpportunities = this.allOpportunities.slice(0, 50);

    // Notify UI
    if (this.callback) {
      this.callback([...this.allOpportunities]);
    }

    console.log(`📊 Total opportunities: ${this.allOpportunities.length}`);
  }

  public setOpportunityCallback(callback: (opportunities: (ArbitrageOpportunity | MevOpportunity)[]) => void): void {
    this.callback = callback;
    console.log('✅ Strategy engine callback registered');
  }

  public async startAllStrategies(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️ Strategies already running');
      return;
    }

    console.log('🚀 Starting all active strategies...');
    this.isRunning = true;

    // Reset proxy status
    enhancedCorsProxy.resetProxies();

    const promises: Promise<void>[] = [];

    // Start Cross-DEX Arbitrage if enabled
    const arbitrageStrategy = this.strategies.get('cross-dex-arbitrage');
    if (arbitrageStrategy?.config.enabled) {
      arbitrageStrategy.status = 'ACTIVE';
      promises.push(this.startCrossDexArbitrageStrategy());
    }

    // Start Micro-MEV if enabled
    const mevStrategy = this.strategies.get('micro-mev');
    if (mevStrategy?.config.enabled) {
      mevStrategy.status = 'ACTIVE';
      promises.push(this.startMicroMevStrategy());
    }

    await Promise.all(promises);
    console.log('✅ All strategies started successfully');
  }

  public async stopAllStrategies(): Promise<void> {
    console.log('⏹️ Stopping all strategies...');
    this.isRunning = false;

    // Stop all services
    crossDexArbitrageService.stopArbitrageScanning();
    microMevService.stopMevScanning();

    // Update strategy statuses
    this.strategies.forEach(strategy => {
      if (strategy.status === 'ACTIVE') {
        strategy.status = 'STOPPED';
      }
    });

    // Clear opportunities
    this.allOpportunities = [];
    if (this.callback) {
      this.callback([]);
    }

    console.log('✅ All strategies stopped');
  }

  private async startCrossDexArbitrageStrategy(): Promise<void> {
    console.log('🔄 Starting Cross-DEX Arbitrage strategy...');
    await crossDexArbitrageService.startArbitrageScanning();
  }

  private async startMicroMevStrategy(): Promise<void> {
    console.log('🔄 Starting Micro-MEV strategy...');
    await microMevService.startMevScanning();
  }

  public enableStrategy(strategyId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (strategy) {
      strategy.config.enabled = true;
      strategy.lastUpdate = Date.now();
      console.log(`✅ Strategy enabled: ${strategy.name}`);
    }
  }

  public disableStrategy(strategyId: string): void {
    const strategy = this.strategies.get(strategyId);
    if (strategy) {
      strategy.config.enabled = false;
      strategy.status = 'STOPPED';
      strategy.lastUpdate = Date.now();
      console.log(`⏹️ Strategy disabled: ${strategy.name}`);
    }
  }

  public getStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  public getStrategy(strategyId: string): Strategy | undefined {
    return this.strategies.get(strategyId);
  }

  public updateStrategyConfig(strategyId: string, config: Partial<StrategyConfig>): void {
    const strategy = this.strategies.get(strategyId);
    if (strategy) {
      strategy.config = { ...strategy.config, ...config };
      strategy.lastUpdate = Date.now();
      console.log(`🔧 Strategy config updated: ${strategy.name}`);
    }
  }

  public getOpportunities(): (ArbitrageOpportunity | MevOpportunity)[] {
    return [...this.allOpportunities];
  }

  public async executeOpportunity(opportunityId: string): Promise<boolean> {
    const opportunity = this.allOpportunities.find(opp => opp.id === opportunityId);
    if (!opportunity) {
      console.log(`❌ Opportunity not found: ${opportunityId}`);
      return false;
    }

    try {
      console.log(`🚀 Executing opportunity: ${opportunity.pair} - $${opportunity.profit.toFixed(6)}`);
      
      let success = false;
      if ('mevType' in opportunity) {
        success = await microMevService.executeMev(opportunityId);
      } else {
        success = await crossDexArbitrageService.executeArbitrage(opportunityId);
      }

      if (success) {
        // Update strategy metrics
        const strategyType = opportunity.type === 'ARBITRAGE' ? 'cross-dex-arbitrage' : 'micro-mev';
        const strategy = this.strategies.get(strategyType);
        if (strategy) {
          strategy.metrics.totalTrades++;
          strategy.metrics.successfulTrades++;
          strategy.metrics.totalProfit += opportunity.profit;
          strategy.metrics.totalVolume += opportunity.volume;
          strategy.metrics.winRate = (strategy.metrics.successfulTrades / strategy.metrics.totalTrades) * 100;
          strategy.metrics.avgProfit = strategy.metrics.totalProfit / strategy.metrics.totalTrades;
          strategy.lastUpdate = Date.now();
        }

        // Remove executed opportunity
        this.allOpportunities = this.allOpportunities.filter(opp => opp.id !== opportunityId);
        if (this.callback) {
          this.callback([...this.allOpportunities]);
        }
      }

      return success;
    } catch (error) {
      console.error(`❌ Error executing opportunity ${opportunityId}:`, error);
      return false;
    }
  }

  public getSystemStatus(): {
    isRunning: boolean;
    activeStrategies: number;
    totalOpportunities: number;
    proxyStatus: ProxyStatus[];
  } {
    const activeStrategies = Array.from(this.strategies.values()).filter(s => s.status === 'ACTIVE').length;
    
    return {
      isRunning: this.isRunning,
      activeStrategies,
      totalOpportunities: this.allOpportunities.length,
      proxyStatus: enhancedCorsProxy.getProxyStatus()
    };
  }
}

export const strategyEngine = new StrategyEngine();