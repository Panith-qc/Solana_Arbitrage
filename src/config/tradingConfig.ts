// TRADING CONFIGURATION - CENTRALIZED SETTINGS
// All trading parameters, token addresses, and API endpoints

export interface TradingConfig {
  // Price Settings
  prices: {
    solUsd: number;
    jupUsd: number;
    bonkUsd: number;
    wifUsd: number;
    usdcUsd: number;
    refreshIntervalMs: number;
    maxPriceAgeMs: number;
  };

  // Trading Parameters
  trading: {
    minProfitUsd: number;
    maxPositionSol: number;
    slippageBps: number;
    priorityFeeLamports: number;
    autoTradingEnabled: boolean;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    enableSandwich: boolean;
    enableArbitrage: boolean;
    enableLiquidation: boolean;
    enableMicroMev: boolean;
  };

  // Scanner Settings
  scanner: {
    scanIntervalMs: number;
    circuitBreakerFailureThreshold: number;
    circuitBreakerRecoveryTimeoutMs: number;
    maxOpportunities: number;
    tokenCheckDelayMs: number;
    profitCaptureRate: number;
  };

  // Token Addresses
  tokens: {
    SOL: string;
    USDC: string;
    USDT: string;
    JUP: string;
    BONK: string;
    WIF: string;
  };

  // API Endpoints
  apis: {
    jupiterQuote: string;
    jupiterSwap: string;
    jupiterPrice: string;
    solscanBase: string;
    corsProxies: string[];
  };

  // Risk Management
  risk: {
    maxTradeAmountSol: number;
    maxDailyLossSol: number;
    stopLossPercent: number;
    maxConcurrentTrades: number;
    cooldownBetweenTradesMs: number;
  };
}

// Default configuration
export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  prices: {
    solUsd: 0, // Will be fetched dynamically
    jupUsd: 0,
    bonkUsd: 0,
    wifUsd: 0,
    usdcUsd: 1.0,
    refreshIntervalMs: 30000, // 30 seconds
    maxPriceAgeMs: 60000, // 1 minute
  },

  trading: {
    minProfitUsd: 0.0001,
    maxPositionSol: 0.1,
    slippageBps: 50, // 0.5%
    priorityFeeLamports: 200000,
    autoTradingEnabled: false,
    riskLevel: 'LOW',
    enableSandwich: false,
    enableArbitrage: true,
    enableLiquidation: false,
    enableMicroMev: true,
  },

  scanner: {
    scanIntervalMs: 1200, // 1.2 seconds
    circuitBreakerFailureThreshold: 5,
    circuitBreakerRecoveryTimeoutMs: 30000, // 30 seconds
    maxOpportunities: 10,
    tokenCheckDelayMs: 200,
    profitCaptureRate: 0.7, // 70%
  },

  tokens: {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  },

  apis: {
    jupiterQuote: 'https://quote-api.jup.ag/v6',
    jupiterSwap: 'https://quote-api.jup.ag/v6/swap',
    jupiterPrice: 'https://price.jup.ag/v4/price',
    solscanBase: 'https://solscan.io',
    corsProxies: [
      'https://api.allorigins.win/raw?url=',
      'https://cors-anywhere.herokuapp.com/',
      'https://thingproxy.freeboard.io/fetch/',
      'https://api.codetabs.com/v1/proxy?quest='
    ],
  },

  risk: {
    maxTradeAmountSol: 1.0,
    maxDailyLossSol: 0.1,
    stopLossPercent: 5.0,
    maxConcurrentTrades: 3,
    cooldownBetweenTradesMs: 5000, // 5 seconds
  },
};

// Configuration manager class
class TradingConfigManager {
  private config: TradingConfig;
  private listeners: ((config: TradingConfig) => void)[] = [];

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): TradingConfig {
    try {
      const saved = localStorage.getItem('trading_config');
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_TRADING_CONFIG, ...parsed };
      }
    } catch (error) {
      console.warn('Failed to load saved config, using defaults:', error);
    }
    return { ...DEFAULT_TRADING_CONFIG };
  }

  public getConfig(): TradingConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<TradingConfig>): void {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
    this.notifyListeners();
  }

  public updateSection<K extends keyof TradingConfig>(
    section: K,
    updates: Partial<TradingConfig[K]>
  ): void {
    this.config[section] = { ...this.config[section], ...updates };
    this.saveConfig();
    this.notifyListeners();
  }

  private saveConfig(): void {
    try {
      localStorage.setItem('trading_config', JSON.stringify(this.config));
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  public subscribe(listener: (config: TradingConfig) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.config));
  }

  public resetToDefaults(): void {
    this.config = { ...DEFAULT_TRADING_CONFIG };
    this.saveConfig();
    this.notifyListeners();
  }

  // Validation methods
  public validateConfig(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (this.config.trading.minProfitUsd <= 0) {
      errors.push('Minimum profit must be greater than 0');
    }

    if (this.config.trading.maxPositionSol <= 0) {
      errors.push('Maximum position size must be greater than 0');
    }

    if (this.config.trading.slippageBps < 1 || this.config.trading.slippageBps > 1000) {
      errors.push('Slippage must be between 1 and 1000 basis points');
    }

    if (this.config.scanner.scanIntervalMs < 100) {
      errors.push('Scan interval must be at least 100ms');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

export const tradingConfigManager = new TradingConfigManager();