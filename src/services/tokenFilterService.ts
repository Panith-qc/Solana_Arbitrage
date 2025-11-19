// TOKEN FILTER SERVICE - Pre-filter tokens by liquidity and safety
// Saves API calls by skipping low-quality tokens before scanning

import { TokenInfo } from '../config/topTokens';

export interface TokenFilterResult {
  passedTokens: TokenInfo[];
  filteredOut: TokenInfo[];
  stats: {
    total: number;
    passed: number;
    filtered: number;
    reasons: Record<string, number>;
  };
}

export class TokenFilterService {
  // Minimum requirements for token scanning
  private readonly MIN_VOLUME_24H = 5_000_000; // $5M minimum daily volume
  private readonly MIN_LIQUIDITY_USD = 1_000_000; // $1M minimum liquidity
  
  // Known risky token patterns (optional - can be expanded)
  private readonly BLACKLISTED_SYMBOLS = new Set([
    // Add any known scam tokens here
  ]);

  /**
   * Filter tokens by liquidity and quality before scanning
   * Saves API calls by only scanning high-quality tokens
   */
  async filterTokens(tokens: TokenInfo[]): Promise<TokenFilterResult> {
    const passedTokens: TokenInfo[] = [];
    const filteredOut: TokenInfo[] = [];
    const reasons: Record<string, number> = {
      'low_volume': 0,
      'blacklisted': 0,
      'insufficient_data': 0
    };

    console.log(`🔍 Filtering ${tokens.length} tokens for quality...`);

    for (const token of tokens) {
      // Check 1: Volume threshold
      if (token.avgVolume24h < this.MIN_VOLUME_24H) {
        filteredOut.push(token);
        reasons['low_volume']++;
        console.log(`  ❌ ${token.symbol}: Low volume ($${(token.avgVolume24h / 1e6).toFixed(1)}M < $${this.MIN_VOLUME_24H / 1e6}M)`);
        continue;
      }

      // Check 2: Blacklist check
      if (this.BLACKLISTED_SYMBOLS.has(token.symbol)) {
        filteredOut.push(token);
        reasons['blacklisted']++;
        console.log(`  ❌ ${token.symbol}: Blacklisted`);
        continue;
      }

      // Check 3: Category-based filtering (optional - be more selective)
      // Prioritize stablecoins and blue-chips over memecoins
      const priorityCategories = new Set(['stablecoin', 'blue-chip', 'dex-token', 'lst']);
      const isHighPriority = priorityCategories.has(token.category);
      
      // For memecoins, require higher volume
      if (token.category === 'memecoin' && token.avgVolume24h < 50_000_000) {
        filteredOut.push(token);
        reasons['low_volume']++;
        console.log(`  ❌ ${token.symbol}: Memecoin needs >$50M volume (has $${(token.avgVolume24h / 1e6).toFixed(1)}M)`);
        continue;
      }

      // Passed all checks
      passedTokens.push(token);
      console.log(`  ✅ ${token.symbol}: Passed ($${(token.avgVolume24h / 1e6).toFixed(1)}M volume, ${token.category})`);
    }

    const stats = {
      total: tokens.length,
      passed: passedTokens.length,
      filtered: filteredOut.length,
      reasons
    };

    console.log('\n📊 Token Filtering Results:');
    console.log(`  Total: ${stats.total}`);
    console.log(`  ✅ Passed: ${stats.passed}`);
    console.log(`  ❌ Filtered: ${stats.filtered}`);
    console.log(`  Reasons:`, reasons);
    console.log('');

    return {
      passedTokens,
      filteredOut,
      stats
    };
  }

  /**
   * Quick filter - just check volume threshold
   * Use this when you want fast filtering without detailed logging
   */
  quickFilter(tokens: TokenInfo[]): TokenInfo[] {
    return tokens.filter(token => {
      // Stablecoins and blue-chips: 5M minimum
      if (['stablecoin', 'blue-chip', 'dex-token', 'lst'].includes(token.category)) {
        return token.avgVolume24h >= this.MIN_VOLUME_24H;
      }
      
      // Memecoins: 50M minimum (higher bar)
      if (token.category === 'memecoin') {
        return token.avgVolume24h >= 50_000_000;
      }
      
      return token.avgVolume24h >= this.MIN_VOLUME_24H;
    });
  }

  /**
   * Get recommended tokens for different risk profiles
   */
  getRecommendedTokens(tokens: TokenInfo[], riskLevel: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'): TokenInfo[] {
    const filtered = this.quickFilter(tokens);

    switch (riskLevel) {
      case 'CONSERVATIVE':
        // Only stablecoins and blue-chips
        return filtered.filter(t => 
          t.category === 'stablecoin' || 
          t.category === 'blue-chip' ||
          t.category === 'lst'
        );

      case 'BALANCED':
        // Stablecoins, blue-chips, and top DEX tokens
        return filtered.filter(t => 
          t.category === 'stablecoin' || 
          t.category === 'blue-chip' ||
          t.category === 'lst' ||
          t.category === 'dex-token'
        );

      case 'AGGRESSIVE':
        // All tokens (including memecoins) if they pass volume filter
        return filtered;

      default:
        return filtered;
    }
  }
}

export const tokenFilterService = new TokenFilterService();
