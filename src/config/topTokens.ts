// TOP LIQUID TOKENS ON SOLANA - Ranked by 24h volume and liquidity
// Updated: 2025-11-19

export interface TokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
  name: string;
  category: 'stablecoin' | 'blue-chip' | 'dex-token' | 'lst' | 'memecoin';
  avgVolume24h: number; // USD
}

export const TOP_TOKENS: TokenInfo[] = [
  // ═══════════════════════════════════════════════════════════════
  // STABLECOINS (Highest volume, lowest risk)
  // ═══════════════════════════════════════════════════════════════
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    name: 'USD Coin',
    category: 'stablecoin',
    avgVolume24h: 500_000_000
  },
  {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6,
    name: 'Tether USD',
    category: 'stablecoin',
    avgVolume24h: 200_000_000
  },

  // ═══════════════════════════════════════════════════════════════
  // LIQUID STAKING TOKENS (High volume, SOL-correlated)
  // ═══════════════════════════════════════════════════════════════
  {
    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    symbol: 'mSOL',
    decimals: 9,
    name: 'Marinade Staked SOL',
    category: 'lst',
    avgVolume24h: 50_000_000
  },
  {
    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    symbol: 'bSOL',
    decimals: 9,
    name: 'BlazeStake Staked SOL',
    category: 'lst',
    avgVolume24h: 10_000_000
  },
  {
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'jitoSOL',
    decimals: 9,
    name: 'Jito Staked SOL',
    category: 'lst',
    avgVolume24h: 80_000_000
  },

  // ═══════════════════════════════════════════════════════════════
  // BLUE CHIP DEX/AGGREGATOR TOKENS (High volume)
  // ═══════════════════════════════════════════════════════════════
  {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    decimals: 6,
    name: 'Jupiter',
    category: 'dex-token',
    avgVolume24h: 100_000_000
  },
  {
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    symbol: 'RAY',
    decimals: 6,
    name: 'Raydium',
    category: 'dex-token',
    avgVolume24h: 80_000_000
  },
  {
    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    symbol: 'ORCA',
    decimals: 6,
    name: 'Orca',
    category: 'dex-token',
    avgVolume24h: 15_000_000
  },

  // ═══════════════════════════════════════════════════════════════
  // HIGH-VOLUME MEMECOINS (Volatile = more opportunities)
  // ═══════════════════════════════════════════════════════════════
  {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    decimals: 5,
    name: 'Bonk',
    category: 'memecoin',
    avgVolume24h: 150_000_000
  },
  {
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'WIF',
    decimals: 6,
    name: 'dogwifhat',
    category: 'memecoin',
    avgVolume24h: 200_000_000
  },
  {
    mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
    symbol: 'MEW',
    decimals: 5,
    name: 'cat in a dogs world',
    category: 'memecoin',
    avgVolume24h: 50_000_000
  },
  {
    mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    symbol: 'BOME',
    decimals: 6,
    name: 'BOOK OF MEME',
    category: 'memecoin',
    avgVolume24h: 40_000_000
  },

  // ═══════════════════════════════════════════════════════════════
  // OTHER BLUE CHIPS (DeFi, Infrastructure)
  // ═══════════════════════════════════════════════════════════════
  {
    mint: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
    symbol: 'stSOL',
    decimals: 9,
    name: 'Lido Staked SOL',
    category: 'lst',
    avgVolume24h: 30_000_000
  },
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'WSOL',
    decimals: 9,
    name: 'Wrapped SOL',
    category: 'blue-chip',
    avgVolume24h: 1_000_000_000
  },
  {
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    symbol: 'PYTH',
    decimals: 6,
    name: 'Pyth Network',
    category: 'blue-chip',
    avgVolume24h: 25_000_000
  },
  {
    mint: 'Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1',
    symbol: 'SBR',
    decimals: 6,
    name: 'Saber',
    category: 'dex-token',
    avgVolume24h: 5_000_000
  },
  {
    mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',
    symbol: 'MNDE',
    decimals: 9,
    name: 'Marinade',
    category: 'blue-chip',
    avgVolume24h: 8_000_000
  },
  {
    mint: 'FnKE9n6aGjQoNWRBZXy4RW6LZVao7qwBonUbiD7edUmZ',
    symbol: 'SRM',
    decimals: 6,
    name: 'Serum',
    category: 'dex-token',
    avgVolume24h: 3_000_000
  },
  {
    mint: 'FWJhGHohPKBRnVjsVMJVLvLq2gZMU8KBvLYnfG3sJhQk',
    symbol: 'FIDA',
    decimals: 6,
    name: 'Bonfida',
    category: 'blue-chip',
    avgVolume24h: 2_000_000
  },
  {
    mint: 'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6',
    symbol: 'KIN',
    decimals: 5,
    name: 'Kin',
    category: 'blue-chip',
    avgVolume24h: 1_000_000
  }
];

// Get tokens by category
export function getTokensByCategory(category: TokenInfo['category']): TokenInfo[] {
  return TOP_TOKENS.filter(t => t.category === category);
}

// Get top N tokens by volume
export function getTopTokensByVolume(n: number): TokenInfo[] {
  return [...TOP_TOKENS]
    .sort((a, b) => b.avgVolume24h - a.avgVolume24h)
    .slice(0, n);
}

// Get stablecoins only
export function getStablecoins(): TokenInfo[] {
  return getTokensByCategory('stablecoin');
}

// Get high-volume tokens (>$10M/day)
export function getHighVolumeTokens(): TokenInfo[] {
  return TOP_TOKENS.filter(t => t.avgVolume24h > 10_000_000);
}
