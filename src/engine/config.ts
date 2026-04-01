// UNIFIED CONFIGURATION
// Single source of truth for all bot settings

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const USDC_DECIMALS = 6;

// ── On-chain fee constants (single source of truth) ──────────────────────────
// These are the REAL Solana protocol fees — never duplicate these values elsewhere.
export const BASE_GAS_LAMPORTS = 5_000;        // 5000 lamports per signature (Solana protocol fixed)
export const PRIORITY_FEE_LAMPORTS = 5_000;    // Minimal priority fee — Jito handles block inclusion
export const JITO_TIP_LAMPORTS = 10_000;       // Minimum viable Jito tip for bundle inclusion

// Derived: total cost for a single-leg swap (1 signature + priority + Jito)
export const SINGLE_LEG_FEE_LAMPORTS = BASE_GAS_LAMPORTS + PRIORITY_FEE_LAMPORTS + JITO_TIP_LAMPORTS; // 20,000
// Derived: total cost for a 2-leg arbitrage cycle (2 signatures + priority + Jito)
export const TWO_LEG_FEE_LAMPORTS = (BASE_GAS_LAMPORTS * 2) + PRIORITY_FEE_LAMPORTS + JITO_TIP_LAMPORTS; // 25,000

// Token list for scanning
export interface TokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

// FOCUSED: Only 6 tokens that showed profitable or near-profitable spreads in live scans.
// Removed: JTO (-207bps), BONK (-107bps), WIF (-50bps), wETH (-54bps) — too far negative.
// 6 tokens instead of 10 = 40% faster scan = fresher quotes when opportunity hits.
export const SCAN_TOKENS: TokenInfo[] = [
  // Profitable: RAY showed +1.5 to +7.9 bps cross-dex spreads
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6 },
  // Near-profitable: wBTC showed micro-spreads in micro-arbitrage
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'wBTC', decimals: 8 },
  // Near-profitable: JUP showed small spreads occasionally
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 },
  // LSTs: tightest spreads (-0.8bps), closest to breakeven
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', decimals: 9 },
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
    sniping: boolean;
    longTailArbitrage: boolean;
    microArbitrage: boolean;
  };
}

export const RISK_PROFILES: Record<RiskLevel, RiskProfile> = {
  CONSERVATIVE: {
    level: 'CONSERVATIVE',
    maxPositionSol: 0.5,
    maxTradeAmountSol: 1.0,
    maxDailyLossSol: 0.3,
    maxDailyLossPercent: 3,
    maxConcurrentTrades: 1,
    stopLossPercent: 1.0,
    slippageBps: 50,
    minProfitUsd: 0.001,
    maxDrawdownPercent: 3,
    circuitBreakerFailures: 5,
    circuitBreakerCooldownMs: 600000, // 10 min
    strategies: {
      cyclicArbitrage: false,
      multiHopArbitrage: false,
      crossDexArbitrage: true,
      sandwich: false,
      frontrun: false,
      backrun: false,
      liquidation: false,
      jitLiquidity: false,
      sniping: false,
      longTailArbitrage: false,
      microArbitrage: false,
    },
  },
  BALANCED: {
    level: 'BALANCED',
    maxPositionSol: 3.0,
    maxTradeAmountSol: 2.0,
    maxDailyLossSol: 0.8,
    maxDailyLossPercent: 8,
    maxConcurrentTrades: 2,
    stopLossPercent: 2.0,
    slippageBps: 15,
    minProfitUsd: 0.001,
    maxDrawdownPercent: 8,
    circuitBreakerFailures: 8,
    circuitBreakerCooldownMs: 300000, // 5 min
    strategies: {
      cyclicArbitrage: false,
      multiHopArbitrage: false,
      crossDexArbitrage: true,
      sandwich: false,
      frontrun: false,
      backrun: true,
      liquidation: false,
      jitLiquidity: false,
      sniping: true,
      longTailArbitrage: false,
      microArbitrage: false,
    },
  },
  AGGRESSIVE: {
    level: 'AGGRESSIVE',
    maxPositionSol: 3.0,       // Never risk more than ~30% of 10 SOL wallet
    maxTradeAmountSol: 2.0,    // Match scan amounts where profits were found (0.5-2 SOL)
    maxDailyLossSol: 1.5,
    maxDailyLossPercent: 15,
    maxConcurrentTrades: 3,
    stopLossPercent: 3.0,
    slippageBps: 10,           // 10 bps max — profits are 1-5 bps, 100 bps slippage would eat them
    minProfitUsd: 0,           // ANY positive profit triggers execution
    maxDrawdownPercent: 15,
    circuitBreakerFailures: 15,
    circuitBreakerCooldownMs: 60000, // 1 min
    strategies: {
      cyclicArbitrage: false,     // DISABLED: duplicates cross-dex with 2x more Jupiter calls; never found profits
      multiHopArbitrage: false,   // DISABLED: 3-leg paths burn 6 Jupiter calls, never found profits
      crossDexArbitrage: true,    // PRIMARY: Raydium buy (FREE) → Jupiter sell (1 call)
      sandwich: false,            // needs Geyser
      frontrun: false,            // needs Geyser
      backrun: true,              // poll-based confirmed TX scanning
      liquidation: false,         // stub only
      jitLiquidity: false,        // needs Geyser
      sniping: true,              // new pool detection + execution
      longTailArbitrage: false,   // DISABLED: consistently -25 to -970 bps, wastes 10 Jupiter calls/cycle
      microArbitrage: true,       // small rapid trades across many tokens
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

  // Sniping
  snipingEnabled: boolean;
  snipeAmountSol: number;

  // Dynamic runtime state (updated by bot engine)
  /** Current SOL/USD price - updated every scan cycle from Jupiter */
  solPriceUsd: number;
}

export function loadConfig(): BotConfig {
  return {
    rpcUrl: process.env.HELIUS_RPC_URL || '',
    rpcBackupUrl: process.env.QUICKNODE_RPC_URL || '',
    rpcCommitment: (process.env.RPC_COMMITMENT as any) || 'confirmed',
    privateKey: process.env.PRIVATE_KEY || '',
    riskLevel: (process.env.RISK_LEVEL as RiskLevel) || 'AGGRESSIVE',
    capitalSol: parseFloat(process.env.CAPITAL_SOL || '10'),
    scanAmountSol: parseFloat(process.env.SCAN_AMOUNT_SOL || '1.0'),
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://lite-api.jup.ag',
    jupiterApiKey: process.env.JUPITER_ULTRA_API_KEY || '',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    jitoEnabled: process.env.JITO_ENABLED !== 'false',
    // CRITICAL: Must match JITO_TIP_LAMPORTS (10,000) used in profit calculations.
    // 100k default was eating ALL profit. 10k is the minimum viable Jito tip.
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '10000'),
    jitoMaxTipLamports: parseInt(process.env.JITO_MAX_TIP_LAMPORTS || '500000'),
    geyserUrl: process.env.GEYSER_URL || '',
    geyserToken: process.env.GEYSER_TOKEN || '',
    maxRequestsPerSecond: parseInt(process.env.JUPITER_RATE_LIMIT_PER_SEC || '2'),
    adminToken: process.env.ADMIN_TOKEN || '',
    port: parseInt(process.env.PORT || '8080'),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    snipingEnabled: process.env.SNIPING_ENABLED !== 'false',
    snipeAmountSol: parseFloat(process.env.SNIPE_AMOUNT_SOL || '0.5'),
    solPriceUsd: 0,
  };
}
