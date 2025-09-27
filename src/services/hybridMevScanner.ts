// HYBRID MEV SCANNER - Combines CORS proxy and direct approaches
// Provides maximum reliability for MEV opportunity detection

import { enhancedCorsProxy } from './enhancedCorsProxy';
import { directJupiterService } from './directJupiterService';

interface MEVOpportunity {
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
  source: 'CORS_PROXY' | 'DIRECT' | 'SIMULATED';
}

interface TokenPair {
  symbol: string;
  mint: string;
  decimals: number;
  price: number;
}

interface JupiterQuote {
  outAmount?: string;
  priceImpactPct?: string;
}

class HybridMevScanner {
  private isScanning = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private callback: ((opportunities: MEVOpportunity[]) => void) | null = null;
  
  // Performance tracking
  private corsProxySuccess = 0;
  private directSuccess = 0;
  private simulatedFallback = 0;
  private totalScans = 0;

  // Token pairs optimized for your 0.6 SOL balance
  private readonly TOKEN_PAIRS: TokenPair[] = [
    { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6, price: 2.40 },
    { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5, price: 0.00003 },
    { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6, price: 1.80 },
    { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', decimals: 9, price: 1.20 },
    { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6, price: 5.50 }
  ];

  private readonly SOL_MINT = 'So11111111111111111111111111111111111111112';
  private readonly SOL_PRICE = 219.50;

  constructor() {
    console.log('🔄 HYBRID MEV SCANNER - Initialized with multi-source reliability');
  }

  async startScanning(callback: (opportunities: MEVOpportunity[]) => void): Promise<void> {
    if (this.isScanning) {
      console.log('⚠️ Hybrid MEV scanner already running');
      return;
    }

    this.callback = callback;
    this.isScanning = true;
    
    console.log('🚀 HYBRID MEV SCANNER - Starting with enhanced reliability...');
    console.log('📊 Sources: CORS Proxy → Direct API → Simulation Fallback');

    // Perform health checks
    await this.performHealthChecks();

    // Start scanning loop
    this.scanInterval = setInterval(async () => {
      await this.performHybridScan();
    }, 2000); // 2 second intervals

    // Initial scan
    await this.performHybridScan();
  }

  stopScanning(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    
    this.isScanning = false;
    this.callback = null;
    console.log('⏹️ HYBRID MEV SCANNER - Stopped');
  }

  private async performHealthChecks(): Promise<void> {
    console.log('🔍 HYBRID HEALTH CHECK - Testing all sources...');
    
    // Test CORS proxy
    try {
      const corsHealth = await enhancedCorsProxy.healthCheck();
      console.log(`📊 CORS Proxy: ${corsHealth.healthy ? '✅ HEALTHY' : '❌ FAILED'} (${corsHealth.workingProxies.length} proxies)`);
    } catch (error) {
      console.log('📊 CORS Proxy: ❌ FAILED (No working proxies)');
    }

    // Test direct service
    try {
      const directHealth = await directJupiterService.healthCheck();
      console.log(`📊 Direct API: ${directHealth ? '✅ HEALTHY' : '❌ FAILED'}`);
    } catch (error) {
      console.log('📊 Direct API: ❌ FAILED (CORS blocked)');
    }

    console.log('📊 Simulation: ✅ ALWAYS AVAILABLE (Fallback mode)');
  }

  private async performHybridScan(): Promise<void> {
    this.totalScans++;
    console.log(`🔍 HYBRID SCAN #${this.totalScans} - Multi-source MEV detection...`);

    const opportunities: MEVOpportunity[] = [];

    for (const token of this.TOKEN_PAIRS) {
      try {
        // Calculate optimal trade size for your balance (0.6 SOL = ~$131)
        const maxTradeUsd = 50; // Conservative $50 max per trade
        const tradeAmount = Math.floor((maxTradeUsd / token.price) * Math.pow(10, token.decimals));

        const opportunity = await this.detectOpportunityHybrid(token, tradeAmount);
        if (opportunity) {
          opportunities.push(opportunity);
          console.log(`💰 OPPORTUNITY: ${opportunity.pair} | ${opportunity.source} | $${opportunity.profitUsd.toFixed(4)} profit`);
        }

        // Rate limiting
        await this.delay(300);

      } catch (error) {
        console.error(`❌ Error scanning ${token.symbol}:`, error instanceof Error ? error.message : 'Unknown error');
      }
    }

    // Report scan results
    if (opportunities.length > 0) {
      console.log(`🎯 HYBRID SCAN COMPLETE: ${opportunities.length} opportunities found`);
      if (this.callback) {
        this.callback(opportunities);
      }
    } else {
      console.log('📊 HYBRID SCAN COMPLETE: 0 profitable opportunities');
    }

    this.logScanStats();
  }

  private async detectOpportunityHybrid(token: TokenPair, amount: number): Promise<MEVOpportunity | null> {
    let quote: JupiterQuote | null = null;
    let source: 'CORS_PROXY' | 'DIRECT' | 'SIMULATED' = 'SIMULATED';

    // Try CORS proxy first
    try {
      quote = await enhancedCorsProxy.getJupiterQuote(token.mint, this.SOL_MINT, amount) as JupiterQuote;
      source = 'CORS_PROXY';
      this.corsProxySuccess++;
    } catch (corsError) {
      // Try direct API
      try {
        quote = await directJupiterService.getQuoteDirect(token.mint, this.SOL_MINT, amount);
        source = 'DIRECT';
        this.directSuccess++;
      } catch (directError) {
        // Fallback to simulation
        quote = await directJupiterService.getQuoteSimulated(token.mint, this.SOL_MINT, amount);
        source = 'SIMULATED';
        this.simulatedFallback++;
      }
    }

    if (!quote?.outAmount) {
      return null;
    }

    // Calculate metrics
    const outputAmount = parseInt(quote.outAmount);
    const priceImpact = parseFloat(quote.priceImpactPct || '0');
    
    // Calculate profit potential
    const solReceived = outputAmount / 1e9;
    const solValue = solReceived * this.SOL_PRICE;
    const inputValue = (amount / Math.pow(10, token.decimals)) * token.price;
    const grossProfit = solValue - inputValue;
    const fees = 0.005; // $0.005 estimated fees
    const netProfit = grossProfit - fees;

    // Only return profitable opportunities
    if (netProfit > 0.01 && priceImpact > 0.0001) { // $0.01 profit, 0.01% impact minimum
      return {
        id: `hybrid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'SANDWICH',
        pair: `${token.symbol}/SOL`,
        inputMint: token.mint,
        outputMint: this.SOL_MINT,
        inputAmount: amount,
        expectedOutput: outputAmount,
        profitUsd: netProfit,
        profitPercent: priceImpact * 100,
        confidence: this.calculateConfidence(priceImpact, netProfit, source),
        riskLevel: this.assessRiskLevel(netProfit, priceImpact),
        timestamp: new Date(),
        source
      };
    }

    return null;
  }

  private calculateConfidence(priceImpact: number, profitUsd: number, source: string): number {
    let confidence = 30; // Base confidence

    // Source reliability bonus
    if (source === 'CORS_PROXY') confidence += 30;
    else if (source === 'DIRECT') confidence += 25;
    else confidence += 10; // Simulated

    // Impact size bonus
    if (priceImpact > 0.001) confidence += 20; // 0.1%+
    if (priceImpact > 0.005) confidence += 15; // 0.5%+

    // Profit size bonus
    if (profitUsd > 0.05) confidence += 15; // $0.05+
    if (profitUsd > 0.10) confidence += 10; // $0.10+

    return Math.min(95, confidence);
  }

  private assessRiskLevel(profitUsd: number, priceImpact: number): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (profitUsd > 0.10 && priceImpact > 0.005) return 'LOW';
    if (profitUsd > 0.05 && priceImpact > 0.002) return 'MEDIUM';
    return 'HIGH';
  }

  private logScanStats(): void {
    const total = this.corsProxySuccess + this.directSuccess + this.simulatedFallback;
    if (total > 0) {
      const corsRate = (this.corsProxySuccess / total * 100).toFixed(1);
      const directRate = (this.directSuccess / total * 100).toFixed(1);
      const simRate = (this.simulatedFallback / total * 100).toFixed(1);
      
      console.log(`📊 SOURCE STATS: CORS ${corsRate}% | Direct ${directRate}% | Simulated ${simRate}%`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Public methods
  isCurrentlyScanning(): boolean {
    return this.isScanning;
  }

  getStats() {
    return {
      totalScans: this.totalScans,
      corsProxySuccess: this.corsProxySuccess,
      directSuccess: this.directSuccess,
      simulatedFallback: this.simulatedFallback,
      reliability: this.totalScans > 0 ? ((this.corsProxySuccess + this.directSuccess + this.simulatedFallback) / this.totalScans * 100).toFixed(1) + '%' : '0%'
    };
  }
}

export const hybridMevScanner = new HybridMevScanner();
export type { MEVOpportunity };