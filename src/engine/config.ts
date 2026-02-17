// UNIFIED CONFIGURATION
// Single source of truth for all bot settings

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const USDC_DECIMALS = 6;

// Token list for scanning
export interface TokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

export const SCAN_TOKENS: TokenInfo[] = [
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6 },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6 },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9 },
  { mint: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', symbol: 'stSOL', decimals: 9 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6 },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', decimals: 5 },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME', decimals: 6 },
  { mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9 },
  { mint: 'Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1', symbol: 'SBR', decimals: 6 },
  { mint: 'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', symbol: 'KIN', decimals: 5 },
];

// Jito Block Engine endpoints (ordered by geography)
export const JITO_BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

// Jito tip accounts for bundle tips
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bPg2HbkAsfBf5q6rxjR4um',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLoffNDcgLmF5GjpyD',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL6d5F',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

// Risk profiles
export type RiskLevel = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

export interface RiskProfile {
  level: RiskLevel;
  maxPositionSol: number;
  maxTradeAmountSol: number;
  maxDailyLossSol: number;
  maxDailyLossPercent: number;
  maxConcurrentTrades: number;
  stopLossPercent: number;
  slippageBps: number;
  minProfitUsd: number;
  maxDrawdownPercent: number;
  circuitBreakerFailures: number;
  circuitBreakerCooldownMs: number;
  strategies: {
    cyclicArbitrage: boolean;
    multiHopArbitrage: boolean;
    crossDexArbitrage: boolean;
    sandwich: boolean;
    frontrun: boolean;
    backrun: boolean;
    liquidation: boolean;
    jitLiquidity: boolean;
  };
}

export const RISK_PROFILES: Record<RiskLevel, RiskProfile> = {
  CONSERVATIVE: {
    level: 'CONSERVATIVE',
    maxPositionSol: 1.0,
    maxTradeAmountSol: 2.0,
    maxDailyLossSol: 0.5,
    maxDailyLossPercent: 5,
    maxConcurrentTrades: 1,
    stopLossPercent: 1.0,
    slippageBps: 50,
    minProfitUsd: 0.50,
    maxDrawdownPercent: 5,
    circuitBreakerFailures: 5,
    circuitBreakerCooldownMs: 600000, // 10 min
    strategies: {
      cyclicArbitrage: true,
      multiHopArbitrage: true,
      crossDexArbitrage: true,
      sandwich: false,
      frontrun: false,
      backrun: false,
      liquidation: false,
      jitLiquidity: false,
    },
  },
  BALANCED: {
    level: 'BALANCED',
    maxPositionSol: 3.0,
    maxTradeAmountSol: 5.0,
    maxDailyLossSol: 2.0,
    maxDailyLossPercent: 15,
    maxConcurrentTrades: 3,
    stopLossPercent: 2.0,
    slippageBps: 100,
    minProfitUsd: 0.25,
    maxDrawdownPercent: 10,
    circuitBreakerFailures: 10,
    circuitBreakerCooldownMs: 300000, // 5 min
    strategies: {
      cyclicArbitrage: true,
      multiHopArbitrage: true,
      crossDexArbitrage: true,
      sandwich: false,
      frontrun: false,
      backrun: true,
      liquidation: true,
      jitLiquidity: true,
    },
  },
  AGGRESSIVE: {
    level: 'AGGRESSIVE',
    maxPositionSol: 5.0,
    maxTradeAmountSol: 8.0,
    maxDailyLossSol: 5.0,
    maxDailyLossPercent: 30,
    maxConcurrentTrades: 5,
    stopLossPercent: 3.0,
    slippageBps: 150,
    minProfitUsd: 0.10,
    maxDrawdownPercent: 20,
    circuitBreakerFailures: 15,
    circuitBreakerCooldownMs: 120000, // 2 min
    strategies: {
      cyclicArbitrage: true,
      multiHopArbitrage: true,
      crossDexArbitrage: true,
      sandwich: true,
      frontrun: true,
      backrun: true,
      liquidation: true,
      jitLiquidity: true,
    },
  },
};

// Main bot configuration
export interface BotConfig {
  // RPC
  rpcUrl: string;
  rpcBackupUrl: string;
  rpcCommitment: 'processed' | 'confirmed' | 'finalized';

  // Wallet
  privateKey: string;

  // Risk
  riskLevel: RiskLevel;
  capitalSol: number;
  scanAmountSol: number;

  // API
  jupiterApiUrl: string;
  jupiterApiKey: string;
  heliusApiKey: string;

  // Jito
  jitoEnabled: boolean;
  jitoTipLamports: number;
  jitoMaxTipLamports: number;

  // Geyser (for mempool access)
  geyserUrl: string;
  geyserToken: string;

  // Rate limiting
  maxRequestsPerSecond: number;

  // Admin
  adminToken: string;
  port: number;

  // Monitoring
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
}

export function loadConfig(): BotConfig {
  return {
    rpcUrl: process.env.HELIUS_RPC_URL || '',
    rpcBackupUrl: process.env.QUICKNODE_RPC_URL || '',
    rpcCommitment: (process.env.RPC_COMMITMENT as any) || 'confirmed',
    privateKey: process.env.PRIVATE_KEY || '',
    riskLevel: (process.env.RISK_LEVEL as RiskLevel) || 'BALANCED',
    capitalSol: parseFloat(process.env.CAPITAL_SOL || '10'),
    scanAmountSol: parseFloat(process.env.SCAN_AMOUNT_SOL || '0.1'),
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://lite-api.jup.ag',
    jupiterApiKey: process.env.JUPITER_ULTRA_API_KEY || '',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    jitoEnabled: process.env.JITO_ENABLED !== 'false',
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '100000'),
    jitoMaxTipLamports: parseInt(process.env.JITO_MAX_TIP_LAMPORTS || '500000'),
    geyserUrl: process.env.GEYSER_URL || '',
    geyserToken: process.env.GEYSER_TOKEN || '',
    maxRequestsPerSecond: parseInt(process.env.JUPITER_RATE_LIMIT_PER_SEC || '2'),
    adminToken: process.env.ADMIN_TOKEN || '',
    port: parseInt(process.env.PORT || '8080'),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  };
}
