// ADVANCED MEV SCANNER - PRODUCTION VERSION WITH CONFIGURABLE PARAMETERS
// Real opportunity detection with profit calculations and circuit breakers

import { tradingConfigManager } from '../config/tradingConfig';
import { priceService } from './priceService';
import { realJupiterService } from './realJupiterService';

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | number;
  priceImpactPct?: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
  }>;
  contextSlot: number;
  timeTaken: number;
}

export interface MEVOpportunity {
  id: string;
  type: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION';
  pair: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  profitUsd: number;
  profitPercent: number;
  confidence: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  timestamp: Date;
  quote?: JupiterQuote;
  priceImpact?: number;
  executionPriority?: number;
  capitalRequired?: number;
}

interface ScannerMetrics {
  totalScans: number;
  opportunitiesFound: number;
  successfulTrades: number;
  totalProfit: number;
  avgExecutionTime: number;
  lastScanTime: Date | null;
}

interface CircuitBreakerStatus {
  isOpen: boolean;
  failureCount: number;
  lastFailureTime: number;
  recoveryTimeout: number;
}

interface TokenPair {
  name: string;
  inputMint: string;
  outputMint: string;
  decimals: number;
  amounts: number[];
}

class AdvancedMEVScanner {
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private onOpportunityCallback: ((opportunities: MEVOpportunity[]) => void) | null = null;
  private currentOpportunities: MEVOpportunity[] = [];
  
  // Metrics tracking
  private metrics: ScannerMetrics = {
    totalScans: 0,
    opportunitiesFound: 0,
    successfulTrades: 0,
    totalProfit: 0,
    avgExecutionTime: 0,
    lastScanTime: null
  };

  // Circuit breaker for API failures
  private circuitBreaker: CircuitBreakerStatus = {
    isOpen: false,
    failureCount: 0,
    lastFailureTime: 0,
    recoveryTimeout: 30000 // Will be updated from config
  };

  private getTokenPairs(): TokenPair[] {
    const config = tradingConfigManager.getConfig();
    
    return [
      {
        name: 'JUP/SOL',
        inputMint: config.tokens.JUP,
        outputMint: config.tokens.SOL,
        decimals: 6,
        amounts: [10416666, 20833333, 41666666] // $25, $50, $100 worth at $2.40 JUP
      },
      {
        name: 'BONK/SOL', 
        inputMint: config.tokens.BONK,
        outputMint: config.tokens.SOL,
        decimals: 5,
        amounts: [83333333333, 166666666666, 333333333333] // Different amounts for BONK
      },
      {
        name: 'WIF/SOL',
        inputMint: config.tokens.WIF,
        outputMint: config.tokens.SOL, 
        decimals: 6,
        amounts: [5000000, 10000000, 20000000] // 5, 10, 20 WIF
      },
      {
        name: 'USDC/SOL',
        inputMint: config.tokens.USDC,
        outputMint: config.tokens.SOL,
        decimals: 6,
        amounts: [25000000, 50000000, 100000000] // $25, $50, $100 USDC
      }
    ];
  }

  async startScanning(onOpportunity: (opportunities: MEVOpportunity[]) => void): Promise<void> {
    if (this.isScanning) {
      console.log('⚠️ Scanner already running');
      return;
    }

    const config = tradingConfigManager.getConfig();
    
    console.log('🚀 ADVANCED MEV SCANNER - Starting production scan...');
    console.log(`📊 Config: ${config.scanner.scanIntervalMs}ms interval, ${config.trading.minProfitUsd} min profit`);
    
    this.isScanning = true;
    this.onOpportunityCallback = onOpportunity;
    this.circuitBreaker.isOpen = false;
    this.circuitBreaker.failureCount = 0;
    this.circuitBreaker.recoveryTimeout = config.scanner.circuitBreakerRecoveryTimeoutMs;
    this.currentOpportunities = [];

    // Immediately notify UI that scanning started
    console.log('📊 NOTIFYING UI: Scanner started with 0 opportunities');
    if (this.onOpportunityCallback) {
      this.onOpportunityCallback([]);
    }

    // Start scanning loop
    this.scanLoop();
  }

  private async scanLoop(): Promise<void> {
    const config = tradingConfigManager.getConfig();
    
    while (this.isScanning) {
      if (this.circuitBreaker.isOpen) {
        // Check if recovery timeout has passed
        if (Date.now() - this.circuitBreaker.lastFailureTime > this.circuitBreaker.recoveryTimeout) {
          console.log('🔄 Circuit breaker recovery attempt...');
          this.circuitBreaker.isOpen = false;
          this.circuitBreaker.failureCount = 0;
        } else {
          await this.sleep(5000); // Wait 5 seconds before checking again
          continue;
        }
      }

      try {
        await this.performScan();
        this.circuitBreaker.failureCount = 0; // Reset on success
        
        // Rate limiting between scans - configurable
        await this.sleep(config.scanner.scanIntervalMs);
        
      } catch (error) {
        console.error('❌ Scan failed:', error);
        this.handleScanFailure();
        await this.sleep(3000); // Wait longer on failure
      }
    }
  }

  private async performScan(): Promise<void> {
    const startTime = Date.now();
    const config = tradingConfigManager.getConfig();
    
    this.metrics.totalScans++;
    this.metrics.lastScanTime = new Date();

    console.log(`🔍 MEV SCAN #${this.metrics.totalScans} - Searching for opportunities...`);

    const opportunities: MEVOpportunity[] = [];
    const tokenPairs = this.getTokenPairs();

    // Scan each token pair for micro-MEV opportunities
    for (const pair of tokenPairs) {
      for (const amount of pair.amounts) {
        try {
          const opportunity = await this.checkMicroMevOpportunity(pair, amount);
          if (opportunity) {
            opportunities.push(opportunity);
            console.log(`💰 FOUND OPPORTUNITY: ${opportunity.pair} - $${(opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')} profit`);
          }
        } catch (error) {
          console.log(`⚠️ Failed to check ${pair.name} with amount ${amount}:`, error);
        }
        
        // Configurable delay between token checks
        await this.sleep(config.scanner.tokenCheckDelayMs);
      }
    }

    // Limit opportunities to configured maximum
    const limitedOpportunities = opportunities
      .sort((a, b) => b.profitUsd - a.profitUsd)
      .slice(0, config.scanner.maxOpportunities);

    // Update current opportunities
    this.currentOpportunities = limitedOpportunities;

    // Update metrics
    this.metrics.opportunitiesFound += limitedOpportunities.length;
    this.metrics.avgExecutionTime = (this.metrics.avgExecutionTime + (Date.now() - startTime)) / 2;

    // ALWAYS CALL CALLBACK - CRITICAL FIX
    console.log(`📊 SENDING ${limitedOpportunities.length} OPPORTUNITIES TO UI`);
    if (this.onOpportunityCallback) {
      console.log('🎯 CALLING UI CALLBACK WITH OPPORTUNITIES:', limitedOpportunities.map(o => `${o.pair}: $${(o.profitUsd != null && !isNaN(o.profitUsd) && typeof o.profitUsd === 'number' ? o.profitUsd.toFixed(6) : '0.000000')}`));
      this.onOpportunityCallback([...limitedOpportunities]); // Send a copy of the array
    } else {
      console.log('❌ NO CALLBACK REGISTERED - UI WILL NOT UPDATE');
    }

    console.log(`✅ Scan complete: ${limitedOpportunities.length} opportunities found`);
  }

  private async checkMicroMevOpportunity(pair: TokenPair, amount: number): Promise<MEVOpportunity | null> {
    try {
      const config = tradingConfigManager.getConfig();
      
      console.log(`📊 MICRO-MEV QUOTE: ${pair.inputMint.slice(0, 8)}... → ${pair.outputMint.slice(0, 8)}... | Amount: ${amount}`);
      
      // Get Jupiter quote with configurable slippage
      const quote = await realJupiterService.getQuote(
        pair.inputMint,
        pair.outputMint, 
        amount,
        config.trading.slippageBps
      );

      if (!quote) {
        console.log('❌ MICRO-MEV QUOTE FAILED: No quote received');
        return null;
      }

      const outputAmount = parseInt(quote.outAmount);
      console.log(`✅ MICRO-MEV QUOTE SUCCESS: ${outputAmount} output | Impact: ${quote.priceImpactPct || 0}%`);

      // Calculate price impact percentage
      const priceImpact = parseFloat(quote.priceImpactPct || '0');
      
      // Calculate potential profit from price impact using dynamic pricing
      const inputValueUsd = await priceService.calculateUsdValue(amount, pair.inputMint, pair.decimals);
      const outputSol = outputAmount / 1e9;
      const solPrice = await priceService.getPriceUsd(config.tokens.SOL);
      const outputValueUsd = outputSol * solPrice;
      const profitUsd = outputValueUsd - inputValueUsd;
      
      console.log(`💰 PROFIT CALC: Input=$${inputValueUsd.toFixed(2)}, Output=$${outputValueUsd.toFixed(2)}, Profit=$${profitUsd.toFixed(4)}`);
      // Use configurable minimum profit threshold
      if (profitUsd < config.trading.minProfitUsd) {
        return null;
      }

      // Calculate confidence based on price impact and liquidity
      const confidence = Math.min(95, Math.max(60, 80 + (priceImpact * 1000)));
      
      // Determine risk level based on configured thresholds
      const riskLevel = priceImpact > 0.01 ? 'HIGH' : priceImpact > 0.005 ? 'MEDIUM' : 'LOW';

      // Calculate capital required in SOL
      const capitalRequired = inputValueUsd / solPrice;

      const opportunity: MEVOpportunity = {
        id: `mev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'ARBITRAGE',
        pair: pair.name,
        inputMint: pair.inputMint,
        outputMint: pair.outputMint,
        inputAmount: amount,
        expectedOutput: outputAmount,
        profitUsd: profitUsd,
        profitPercent: priceImpact,
        confidence: confidence,
        riskLevel: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
        timestamp: new Date(),
        quote: quote,
        priceImpact: priceImpact,
        executionPriority: Math.floor(profitUsd * 1000), // Higher profit = higher priority
        capitalRequired: capitalRequired
      };

      console.log(`🎯 CREATED OPPORTUNITY OBJECT:`, {
        id: opportunity.id,
        pair: opportunity.pair,
        profit: opportunity.profitUsd,
        type: opportunity.type,
        capitalRequired: opportunity.capitalRequired
      });

      return opportunity;

    } catch (error) {
      console.log(`❌ MICRO-MEV QUOTE FAILED: ${error}`);
      return null;
    }
  }

  private handleScanFailure(): void {
    const config = tradingConfigManager.getConfig();
    
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.failureCount >= config.scanner.circuitBreakerFailureThreshold) {
      console.log('🚨 Circuit breaker opened due to repeated failures');
      this.circuitBreaker.isOpen = true;
    }
  }

  stopScanning(): void {
    console.log('⏹️ ADVANCED MEV SCANNER - Stopped');
    this.isScanning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.onOpportunityCallback = null;
    this.currentOpportunities = [];
  }

  async forceRefresh(): Promise<MEVOpportunity[]> {
    console.log('🔄 FORCE REFRESH - Manual opportunity scan...');
    const opportunities: MEVOpportunity[] = [];
    const tokenPairs = this.getTokenPairs();

    for (const pair of tokenPairs.slice(0, 2)) { // Only check first 2 pairs for manual refresh
      try {
        const opportunity = await this.checkMicroMevOpportunity(pair, pair.amounts[0]);
        if (opportunity) {
          opportunities.push(opportunity);
        }
      } catch (error) {
        console.log(`⚠️ Manual refresh failed for ${pair.name}:`, error);
      }
    }

    // Update current opportunities and notify UI
    this.currentOpportunities = opportunities;
    if (this.onOpportunityCallback) {
      console.log(`📊 FORCE REFRESH: Sending ${opportunities.length} opportunities to UI`);
      this.onOpportunityCallback([...opportunities]);
    }

    console.log(`✅ Manual refresh complete: ${opportunities.length} opportunities`);
    return opportunities;
  }

  recordSuccessfulTrade(profit: number): void {
    this.metrics.successfulTrades++;
    this.metrics.totalProfit += profit;
    console.log(`📈 Trade recorded: $${(profit != null && !isNaN(profit) && typeof profit === 'number' ? profit.toFixed(6) : '0.000000')} profit | Total: $${(this.metrics.totalProfit != null && !isNaN(this.metrics.totalProfit) && typeof this.metrics.totalProfit === 'number' ? this.metrics.totalProfit.toFixed(6) : '0.000000')}`);
  }

  getMetrics(): ScannerMetrics {
    return { ...this.metrics };
  }

  getCircuitBreakerStatus(): CircuitBreakerStatus {
    return { ...this.circuitBreaker };
  }

  // Get current opportunities for debugging
  getCurrentOpportunities(): MEVOpportunity[] {
    return [...this.currentOpportunities];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const advancedMEVScanner = new AdvancedMEVScanner();
