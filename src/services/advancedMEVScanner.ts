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
    
    // CRITICAL FIX: amounts are now SOL amounts (in lamports)
    // We'll trade SOL → Token → SOL cycles
    return [
      {
        name: 'JUP',
        inputMint: config.tokens.JUP,
        outputMint: config.tokens.SOL,
        decimals: 6,
        amounts: [100000000, 200000000, 500000000] // 0.1, 0.2, 0.5 SOL
      },
      {
        name: 'BONK', 
        inputMint: config.tokens.BONK,
        outputMint: config.tokens.SOL,
        decimals: 5,
        amounts: [100000000, 200000000, 500000000] // 0.1, 0.2, 0.5 SOL
      },
      {
        name: 'WIF',
        inputMint: config.tokens.WIF,
        outputMint: config.tokens.SOL, 
        decimals: 6,
        amounts: [100000000, 200000000, 500000000] // 0.1, 0.2, 0.5 SOL
      },
      {
        name: 'USDC',
        inputMint: config.tokens.USDC,
        outputMint: config.tokens.SOL,
        decimals: 6,
        amounts: [100000000, 200000000, 500000000] // 0.1, 0.2, 0.5 SOL
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
            console.log(`💰 FOUND PROFITABLE CYCLE: ${opportunity.pair} - Profit: ${((opportunity.expectedOutput - opportunity.inputAmount) / 1e9).toFixed(6)} SOL ($${(opportunity.profitUsd != null && !isNaN(opportunity.profitUsd) && typeof opportunity.profitUsd === 'number' ? opportunity.profitUsd.toFixed(6) : '0.000000')})`);
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
      const SOL_MINT = config.tokens.SOL;
      
      // CRITICAL FIX: We want SOL → Token → SOL cycles
      // So we ALWAYS start with SOL, regardless of what pair.inputMint says
      
      console.log(`📊 CHECKING COMPLETE CYCLE: SOL → ${pair.name.split('/')[0]} → SOL`);
      
      // Step 1: Get quote for SOL → Token
      const solAmount = amount; // Amount in lamports
      console.log(`   Step 1: SOL → Token (${solAmount / 1e9} SOL)`);
      
      const forwardQuote = await realJupiterService.getQuote(
        SOL_MINT,
        pair.inputMint, // The token we're buying
        solAmount,
        config.trading.slippageBps
      );

      if (!forwardQuote) {
        console.log('   ❌ Forward quote failed');
        return null;
      }

      const tokenAmount = parseInt(forwardQuote.outAmount);
      console.log(`   ✅ Got ${tokenAmount} tokens`);

      // Step 2: Get quote for Token → SOL
      console.log(`   Step 2: Token → SOL (${tokenAmount} tokens)`);
      
      const reverseQuote = await realJupiterService.getQuote(
        pair.inputMint, // The token we're selling
        SOL_MINT,
        tokenAmount,
        config.trading.slippageBps
      );

      if (!reverseQuote) {
        console.log('   ❌ Reverse quote failed');
        return null;
      }

      const finalSolAmount = parseInt(reverseQuote.outAmount);
      console.log(`   ✅ Got ${finalSolAmount / 1e9} SOL back`);

      // Step 3: Calculate profit
      const startSolAmount = solAmount;
      const endSolAmount = finalSolAmount;
      const profitLamports = endSolAmount - startSolAmount;
      const profitSol = profitLamports / 1e9;
      
      const solPrice = await priceService.getPriceUsd(SOL_MINT);
      const profitUsd = profitSol * solPrice;
      
      console.log(`💰 CYCLE PROFIT: Start=${startSolAmount / 1e9} SOL, End=${endSolAmount / 1e9} SOL, Profit=${profitSol.toFixed(6)} SOL ($${profitUsd.toFixed(4)})`);
      
      // Use configurable minimum profit threshold
      if (profitUsd < config.trading.minProfitUsd) {
        console.log(`   ❌ Profit too low: $${profitUsd.toFixed(4)} < $${config.trading.minProfitUsd}`);
        return null;
      }

      // Calculate price impact
      const forwardImpact = parseFloat(forwardQuote.priceImpactPct || '0');
      const reverseImpact = parseFloat(reverseQuote.priceImpactPct || '0');
      const totalImpact = Math.abs(forwardImpact) + Math.abs(reverseImpact);
      
      // Calculate confidence based on price impact
      const confidence = Math.min(95, Math.max(60, 90 - (totalImpact * 100)));
      
      // Determine risk level
      const riskLevel = totalImpact > 0.02 ? 'HIGH' : totalImpact > 0.01 ? 'MEDIUM' : 'LOW';

      // Capital required in SOL
      const capitalRequired = solAmount / 1e9;

      const opportunity: MEVOpportunity = {
        id: `mev_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'ARBITRAGE',
        pair: `SOL/${pair.name.split('/')[0]}/SOL`, // Show it's a cycle
        inputMint: SOL_MINT, // ALWAYS starts with SOL
        outputMint: pair.inputMint, // The token in the middle
        inputAmount: solAmount,
        expectedOutput: finalSolAmount, // Final SOL amount
        profitUsd: profitUsd,
        profitPercent: (profitSol / (solAmount / 1e9)) * 100, // % return
        confidence: confidence,
        riskLevel: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
        timestamp: new Date(),
        quote: forwardQuote, // Store forward quote for execution
        priceImpact: totalImpact,
        executionPriority: Math.floor(profitUsd * 1000),
        capitalRequired: capitalRequired
      };

      console.log(`🎯 FOUND PROFITABLE CYCLE:`, {
        pair: opportunity.pair,
        startSOL: solAmount / 1e9,
        endSOL: finalSolAmount / 1e9,
        profitSOL: profitSol,
        profitUSD: profitUsd
      });

      return opportunity;

    } catch (error) {
      console.log(`❌ CYCLE CHECK FAILED: ${error}`);
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
