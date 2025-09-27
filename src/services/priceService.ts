// DYNAMIC PRICE SERVICE - REAL-TIME PRICE FETCHING
// Replaces all hardcoded prices with live data

import { tradingConfigManager } from '../config/tradingConfig';

interface PriceData {
  price: number;
  timestamp: number;
  source: string;
}

interface TokenPrices {
  [mint: string]: PriceData;
}

class PriceService {
  private prices: TokenPrices = {};
  private updateInterval: NodeJS.Timeout | null = null;
  private isUpdating = false;

  constructor() {
    this.startPriceUpdates();
  }

  private startPriceUpdates(): void {
    const config = tradingConfigManager.getConfig();
    
    // Initial price fetch
    this.updateAllPrices();

    // Set up periodic updates
    this.updateInterval = setInterval(() => {
      this.updateAllPrices();
    }, config.prices.refreshIntervalMs);

    console.log(`🔄 Price service started with ${config.prices.refreshIntervalMs}ms refresh interval`);
  }

  private async updateAllPrices(): Promise<void> {
    if (this.isUpdating) return;
    
    this.isUpdating = true;
    const config = tradingConfigManager.getConfig();

    try {
      console.log('📊 Updating all token prices...');

      // Get prices from Jupiter API
      const tokenMints = [
        config.tokens.SOL,
        config.tokens.JUP,
        config.tokens.BONK,
        config.tokens.WIF,
        config.tokens.USDC,
        config.tokens.USDT
      ];

      const pricePromises = tokenMints.map(mint => this.fetchTokenPrice(mint));
      const results = await Promise.allSettled(pricePromises);

      results.forEach((result, index) => {
        const mint = tokenMints[index];
        if (result.status === 'fulfilled' && result.value) {
          this.prices[mint] = {
            price: result.value,
            timestamp: Date.now(),
            source: 'jupiter'
          };
        } else {
          console.warn(`⚠️ Failed to update price for ${mint}`);
        }
      });

      // Update config with new prices
      tradingConfigManager.updateSection('prices', {
        solUsd: this.getPrice(config.tokens.SOL) || config.prices.solUsd,
        jupUsd: this.getPrice(config.tokens.JUP) || config.prices.jupUsd,
        bonkUsd: this.getPrice(config.tokens.BONK) || config.prices.bonkUsd,
        wifUsd: this.getPrice(config.tokens.WIF) || config.prices.wifUsd,
        usdcUsd: this.getPrice(config.tokens.USDC) || 1.0,
      });

      console.log('✅ Price update completed');

    } catch (error) {
      console.error('❌ Price update failed:', error);
    } finally {
      this.isUpdating = false;
    }
  }

  private async fetchTokenPrice(mint: string): Promise<number | null> {
    try {
      const config = tradingConfigManager.getConfig();
      const response = await fetch(`${config.apis.jupiterPrice}?ids=${mint}`);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.data?.[mint]?.price || null;

    } catch (error) {
      console.warn(`⚠️ Failed to fetch price for ${mint}:`, error);
      return null;
    }
  }

  public getPrice(mint: string): number | null {
    const priceData = this.prices[mint];
    if (!priceData) return null;

    const config = tradingConfigManager.getConfig();
    const age = Date.now() - priceData.timestamp;
    
    if (age > config.prices.maxPriceAgeMs) {
      console.warn(`⚠️ Price for ${mint} is stale (${age}ms old)`);
      return null;
    }

    return priceData.price;
  }

  public getPriceUsd(mint: string): number {
    const config = tradingConfigManager.getConfig();
    
    // Return cached price or fallback to config
    const cachedPrice = this.getPrice(mint);
    if (cachedPrice) return cachedPrice;

    // Fallback to config prices
    switch (mint) {
      case config.tokens.SOL:
        return config.prices.solUsd || 200; // Fallback
      case config.tokens.JUP:
        return config.prices.jupUsd || 2.0;
      case config.tokens.BONK:
        return config.prices.bonkUsd || 0.00001;
      case config.tokens.WIF:
        return config.prices.wifUsd || 1.5;
      case config.tokens.USDC:
      case config.tokens.USDT:
        return 1.0;
      default:
        console.warn(`⚠️ Unknown token mint: ${mint}`);
        return 1.0;
    }
  }

  public calculateUsdValue(amount: number, mint: string, decimals: number = 6): number {
    const price = this.getPriceUsd(mint);
    return (amount / Math.pow(10, decimals)) * price;
  }

  public getAllPrices(): TokenPrices {
    return { ...this.prices };
  }

  public isHealthy(): boolean {
    const config = tradingConfigManager.getConfig();
    const requiredTokens = [config.tokens.SOL, config.tokens.JUP];
    
    return requiredTokens.every(mint => {
      const priceData = this.prices[mint];
      if (!priceData) return false;
      
      const age = Date.now() - priceData.timestamp;
      return age <= config.prices.maxPriceAgeMs;
    });
  }

  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log('⏹️ Price service stopped');
  }
}

export const priceService = new PriceService();