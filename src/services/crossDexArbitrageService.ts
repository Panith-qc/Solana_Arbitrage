import { RaydiumService } from './raydiumService';
import { OrcaService } from './orcaService';
import { enhancedCorsProxy } from './enhancedCorsProxy';

interface ArbitrageOpportunity {
  tokenPair: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  priceSpread: number;
  profitUsd: number;
  tradeSize: number;
}

interface DexQuote {
  dex: string;
  price: number;
  outputAmount: number;
  success: boolean;
}

interface TokenPair {
  symbol: string;
  mint: string;
  decimals: number;
}

export class CrossDexArbitrageService {
  private raydiumService: RaydiumService;
  private orcaService: OrcaService;
  private isScanning = false;
  
  // Popular token pairs for arbitrage
  private readonly TOKEN_PAIRS: TokenPair[] = [
    { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
    { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
    { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
    { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', decimals: 9 },
    { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 }
  ];

  private readonly SOL_MINT = 'So11111111111111111111111111111111111111112';
  
  constructor() {
    this.raydiumService = new RaydiumService();
    this.orcaService = new OrcaService();
  }

  async startArbitrageScanning(): Promise<void> {
    if (this.isScanning) {
      console.log('🔄 Cross-DEX arbitrage already scanning...');
      return;
    }

    this.isScanning = true;
    console.log('🚀 CROSS-DEX ARBITRAGE SCANNER - Starting profit hunting...');
    
    while (this.isScanning) {
      try {
        await this.scanForArbitrageOpportunities();
        await this.delay(2000); // 2 second delay between scans
      } catch (error) {
        console.error('❌ Arbitrage scan error:', error);
        await this.delay(5000); // Longer delay on error
      }
    }
  }

  stopScanning(): void {
    this.isScanning = false;
    console.log('⏹️ CROSS-DEX ARBITRAGE SCANNER - Stopped');
  }

  private async scanForArbitrageOpportunities(): Promise<void> {
    console.log('🔍 CROSS-DEX ARBITRAGE - Scanning for profit opportunities...');
    
    const opportunities: ArbitrageOpportunity[] = [];
    
    for (const token of this.TOKEN_PAIRS) {
      try {
        // Test multiple trade sizes for optimal profit
        const tradeSizes = [50, 100, 200]; // USD values
        
        for (const tradeSize of tradeSizes) {
          const opportunity = await this.checkArbitrageOpportunity(token, tradeSize);
          if (opportunity && opportunity.profitUsd > 0.50) { // Minimum $0.50 profit
            opportunities.push(opportunity);
            console.log(`💰 ARBITRAGE FOUND: ${opportunity.tokenPair} | Buy: ${opportunity.buyDex} | Sell: ${opportunity.sellDex} | Profit: $${opportunity.profitUsd.toFixed(3)}`);
          }
        }
        
        await this.delay(500); // Rate limiting between tokens
      } catch (error) {
        console.error(`❌ Error checking ${token.symbol}:`, error);
      }
    }
    
    if (opportunities.length === 0) {
      console.log('📊 Cross-DEX scan complete: 0 profitable arbitrage opportunities found');
    } else {
      console.log(`🎯 Found ${opportunities.length} profitable arbitrage opportunities!`);
      // Execute the most profitable opportunity
      const bestOpportunity = opportunities.sort((a, b) => b.profitUsd - a.profitUsd)[0];
      await this.executeArbitrage(bestOpportunity);
    }
  }

  private async checkArbitrageOpportunity(token: TokenPair, tradeSizeUsd: number): Promise<ArbitrageOpportunity | null> {
    try {
      // Calculate trade amount in tokens (assuming $2.40 per SOL for JUP conversion)
      const solPrice = 240; // Approximate SOL price in USD
      const jupPrice = 2.40; // Approximate JUP price in USD
      
      let tradeAmount: number;
      if (token.symbol === 'JUP') {
        tradeAmount = Math.floor((tradeSizeUsd / jupPrice) * Math.pow(10, token.decimals));
      } else {
        // For other tokens, estimate based on typical meme coin prices
        const estimatedPrice = token.symbol === 'BONK' ? 0.00003 : 
                             token.symbol === 'WIF' ? 1.80 :
                             token.symbol === 'POPCAT' ? 1.20 : 5.50; // RAY
        tradeAmount = Math.floor((tradeSizeUsd / estimatedPrice) * Math.pow(10, token.decimals));
      }

      // Get quotes from all DEXs
      const [jupiterQuote, raydiumQuote, orcaQuote] = await Promise.all([
        this.getJupiterQuote(token.mint, tradeAmount),
        this.raydiumService.getQuote(token.mint, this.SOL_MINT, tradeAmount),
        this.orcaService.getQuote(token.mint, this.SOL_MINT, tradeAmount)
      ]);

      const quotes = [jupiterQuote, raydiumQuote, orcaQuote].filter(q => q.success);
      
      if (quotes.length < 2) {
        return null; // Need at least 2 successful quotes for arbitrage
      }

      // Find best buy (lowest price) and best sell (highest price)
      const sortedByPrice = quotes.sort((a, b) => a.price - b.price);
      const buyQuote = sortedByPrice[0]; // Lowest price (best buy)
      const sellQuote = sortedByPrice[sortedByPrice.length - 1]; // Highest price (best sell)

      if (buyQuote.dex === sellQuote.dex) {
        return null; // No arbitrage if same DEX
      }

      // Calculate profit
      const priceSpread = ((sellQuote.price - buyQuote.price) / buyQuote.price) * 100;
      const grossProfit = (sellQuote.outputAmount - buyQuote.outputAmount) / 1e9 * solPrice; // Convert lamports to USD
      const transactionFees = 0.10; // Estimated total fees for both transactions
      const netProfit = grossProfit - transactionFees;

      if (netProfit > 0.50) { // Minimum $0.50 profit threshold
        return {
          tokenPair: `${token.symbol}/SOL`,
          buyDex: buyQuote.dex,
          sellDex: sellQuote.dex,
          buyPrice: buyQuote.price,
          sellPrice: sellQuote.price,
          priceSpread: priceSpread,
          profitUsd: netProfit,
          tradeSize: tradeSizeUsd
        };
      }

      return null;
    } catch (error) {
      console.error(`❌ Error checking arbitrage for ${token.symbol}:`, error);
      return null;
    }
  }

  private async getJupiterQuote(inputMint: string, amount: number): Promise<DexQuote> {
    try {
      const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${this.SOL_MINT}&amount=${amount}&slippageBps=50`;
      const response = await enhancedCorsProxy.fetchWithFallback(url);
      
      if (response.outAmount) {
        const price = amount / parseInt(response.outAmount);
        return {
          dex: 'Jupiter',
          price: price,
          outputAmount: parseInt(response.outAmount),
          success: true
        };
      }
      
      return { dex: 'Jupiter', price: 0, outputAmount: 0, success: false };
    } catch (error) {
      console.error('❌ Jupiter quote error:', error);
      return { dex: 'Jupiter', price: 0, outputAmount: 0, success: false };
    }
  }

  private async executeArbitrage(opportunity: ArbitrageOpportunity): Promise<void> {
    console.log('🚀 EXECUTING ARBITRAGE TRADE...');
    console.log(`📊 Trade: ${opportunity.tokenPair}`);
    console.log(`💰 Buy on ${opportunity.buyDex} at $${opportunity.buyPrice.toFixed(6)}`);
    console.log(`💰 Sell on ${opportunity.sellDex} at $${opportunity.sellPrice.toFixed(6)}`);
    console.log(`📈 Price spread: ${opportunity.priceSpread.toFixed(3)}%`);
    console.log(`💵 Expected profit: $${opportunity.profitUsd.toFixed(3)}`);
    
    // In production, this would execute the actual trades
    // For now, we'll simulate the execution
    console.log('✅ ARBITRAGE TRADE SIMULATED - Ready for production execution!');
    
    // Log the profitable opportunity for user to see
    this.logProfitableOpportunity(opportunity);
  }

  private logProfitableOpportunity(opportunity: ArbitrageOpportunity): void {
    console.log('🎯 PROFITABLE ARBITRAGE OPPORTUNITY FOUND:');
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💎 Token Pair: ${opportunity.tokenPair}`);
    console.log(`🛒 Buy on: ${opportunity.buyDex} (Lower price)`);
    console.log(`🏪 Sell on: ${opportunity.sellDex} (Higher price)`);
    console.log(`📊 Price Spread: ${opportunity.priceSpread.toFixed(3)}%`);
    console.log(`💰 Expected Profit: $${opportunity.profitUsd.toFixed(3)}`);
    console.log(`💵 Trade Size: $${opportunity.tradeSize}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}