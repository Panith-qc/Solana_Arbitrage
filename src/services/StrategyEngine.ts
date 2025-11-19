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
  private lastScanTime = 0;

  /**
   * Get optimal scan interval based on time of day
   * High activity periods = faster scanning
   * Low activity periods = slower scanning (save API calls)
   */
  private getScanInterval(): number {
    const hour = new Date().getUTCHours();
    
    // High activity periods on Solana
    if ((hour >= 7 && hour <= 11) ||   // Asia wakes up
        (hour >= 13 && hour <= 16) ||  // Europe active
        (hour >= 21 && hour <= 24)) {  // US evening
      return 12000; // 12 seconds (more aggressive during high activity)
    }
    
    // Low activity periods
    return 20000; // 20 seconds (conservative during quiet hours)
  }

  async startAllStrategies(
    maxCapital: number,
    callback?: (opps: StrategyOpportunity[]) => Promise<void>
  ): Promise<void> {
    this.isRunning = true;
    
    console.log('🔍 Scanning for REAL opportunities using Jupiter API...');
    console.log(`📊 Expanded to 20 HIGH-VOLUME tokens (was 4)`);
    console.log(`⚡ Using PARALLEL scanning (4x faster)`);
    console.log(`⏰ Using TIME-BASED intervals (smart API usage)`);

    // Import services for REAL market data
    const { multiAPIService } = await import('./multiAPIQuoteService');
    const { priceService } = await import('./priceService');
    const { getHighVolumeTokens } = await import('../config/topTokens');
    const { tokenFilterService } = await import('./tokenFilterService');
    
    const opportunities: StrategyOpportunity[] = [];
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    
    // ═══════════════════════════════════════════════════════════════
    // IMPROVEMENT #1: EXPANDED TOKEN LIST (4 → 20 tokens)
    // ═══════════════════════════════════════════════════════════════
    // Get top 20 liquid tokens (>$10M daily volume)
    const highVolumeTokens = getHighVolumeTokens();
    
    // ═══════════════════════════════════════════════════════════════
    // IMPROVEMENT #4: SMART TOKEN FILTERING
    // ═══════════════════════════════════════════════════════════════
    // Pre-filter tokens by quality to save API calls
    const filterResult = await tokenFilterService.filterTokens(highVolumeTokens.slice(0, 20));
    const tokens = filterResult.passedTokens.map(t => ({
      mint: t.mint,
      symbol: t.symbol
    }));
    
    console.log(`🎯 Scanning ${tokens.length} tokens:`, tokens.map(t => t.symbol).join(', '));
    
    const scanAmount = Math.floor((maxCapital * 0.3) * 1e9); // 30% of capital in lamports
    
    // ═══════════════════════════════════════════════════════════════
    // IMPROVEMENT #2: PARALLEL SCANNING (Sequential → Parallel)
    // ═══════════════════════════════════════════════════════════════
    // Scan all tokens in parallel (4x faster than sequential)
    const scanPromises = tokens.map(async (token) => {
      try {
        // Get REAL Jupiter quotes
        const forwardQuote = await multiAPIService.getQuote(SOL_MINT, token.mint, scanAmount, 50);
        if (!forwardQuote?.outAmount) return null;
        
        const reverseQuote = await multiAPIService.getQuote(token.mint, SOL_MINT, Number(forwardQuote.outAmount), 50);
        if (!reverseQuote?.outAmount) return null;
        
        // Calculate REAL profit
        const endAmount = Number(reverseQuote.outAmount);
        const profitLamports = endAmount - scanAmount;
        const profitSOL = profitLamports / 1e9;
        const profitPercent = (profitSOL / (scanAmount / 1e9)) * 100;
        
        const solPrice = await priceService.getPriceUsd(SOL_MINT);
        const profitUSD = profitSOL * solPrice;
        const feesUSD = 0.002 * solPrice;
        const netProfitUSD = profitUSD - feesUSD;
        
        // Only add if profitable
        if (netProfitUSD > 0.01) {
          const opportunity: StrategyOpportunity = {
            id: `strat-${token.symbol}-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            type: 'arbitrage',
            pair: `SOL/${token.symbol}`,
            targetProfit: netProfitUSD,
            riskScore: profitPercent > 1 ? 0.2 : 0.3,
            riskLevel: profitPercent > 1 ? 'LOW' : 'MEDIUM',
            timeToExecute: 2000,
            profitUsd: netProfitUSD,
            confidence: 0.85,
            recommendedCapital: scanAmount / 1e9,
            strategyName: 'Cyclic Arbitrage (Real)',
            outputMint: token.mint,
            executionPlan: ['SOL', token.symbol, 'SOL']
          };
          return opportunity;
        }
        return null;
      } catch (error) {
        // Skip failed quotes
        return null;
      }
    });

    // Wait for all scans to complete (parallel execution)
    const results = await Promise.all(scanPromises);
    
    // Filter out nulls and add to opportunities
    results.forEach(result => {
      if (result) opportunities.push(result);
    });

    this.activeStrategies = new Map(opportunities.map(o => [o.id, o]));
    
    console.log(`✅ Found ${opportunities.length} REAL opportunities (out of ${tokens.length} tokens scanned)`);
    
    // ═══════════════════════════════════════════════════════════════
    // IMPROVEMENT #3: TIME-BASED SCANNING (24/7 constant → Smart intervals)
    // ═══════════════════════════════════════════════════════════════
    const nextInterval = this.getScanInterval();
    const currentHour = new Date().getUTCHours();
    const isHighActivity = (currentHour >= 7 && currentHour <= 11) || 
                          (currentHour >= 13 && currentHour <= 16) || 
                          (currentHour >= 21 && currentHour <= 24);
    
    console.log(`⏰ Time: ${currentHour}:00 UTC (${isHighActivity ? 'HIGH' : 'LOW'} activity)`);
    console.log(`⏱️  Next scan in ${nextInterval / 1000} seconds`);

    if (callback && opportunities.length > 0) {
      try {
        await callback(opportunities);
      } catch (error) {
        console.error('Error in strategy callback:', error);
      }
    }

    // Schedule next scan with time-based interval
    if (this.isRunning) {
      setTimeout(() => {
        if (this.isRunning) {
          this.startAllStrategies(maxCapital, callback);
        }
      }, nextInterval);
    }

    this.lastScanTime = Date.now();
  }

  async stopAllStrategies(): Promise<void> {
    this.isRunning = false;
    this.activeStrategies.clear();
    console.log('⏹️  Strategy engine stopped');
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

  // Get stats
  getStats() {
    return {
      isRunning: this.isRunning,
      activeStrategies: this.activeStrategies.size,
      totalExecutions: this.executionHistory.length,
      lastScanTime: this.lastScanTime,
      nextScanIn: this.isRunning ? this.getScanInterval() : 0
    };
  }
}

export const strategyEngine = new StrategyEngineImpl();
