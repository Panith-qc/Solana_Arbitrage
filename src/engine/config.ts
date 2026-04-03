// UNIFIED CONFIGURATION
// Single source of truth for all bot settings

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const USDC_DECIMALS = 6;

// ── On-chain fee constants (single source of truth) ──────────────────────────
// These are the REAL Solana protocol fees — never duplicate these values elsewhere.
export const BASE_GAS_LAMPORTS = 5_000;        // 5000 lamports per signature (Solana protocol fixed)
export const PRIORITY_FEE_LAMPORTS = 10_000;   // Priority fee for staked connection inclusion
// Minimum Jito tip for Helius Sender dual-routing (SWQoS + Jito).
// Below 200,000 lamports, Sender only uses SWQoS (no Jito auction).
export const JITO_TIP_LAMPORTS = 200_000;

// Fee estimates for SCANNING (profit threshold).
// Use minimum Jito tip (1,000) for scanning — executor uses dynamic tip (40% of profit).
// This ensures scanner doesn't discard opportunities that executor would accept.
export const SINGLE_LEG_FEE_LAMPORTS = BASE_GAS_LAMPORTS + PRIORITY_FEE_LAMPORTS + 1_000; // 16,000
export const TWO_LEG_FEE_LAMPORTS = BASE_GAS_LAMPORTS + PRIORITY_FEE_LAMPORTS + 1_000;   // 16,000
// Executor applies real fee: baseFee + dynamicTip, where dynamicTip = min(max(profit*0.40, 1000), 200000)
// Executor also gates on netProfit >= 10,000 lamports after dynamic tip.

// ── EXECUTION REALITY CONSTANTS ────────────────────────────────────────────
// These account for the physical reality of Solana execution latency.
// From quote to on-chain confirmation takes ~1.5-2s. During that window,
// the market moves. If the profit margin is thinner than typical movement,
// the TX will always revert (slippage error 6024) and you burn TX fees.

/** Maximum accounts Jupiter can use per quote — keeps routes simple enough
 *  to combine 2 swaps into 1 atomic TX within Solana's 1232-byte limit.
 *  Without this, complex tokens (wBTC, wETH) produce 30+ account routes
 *  that overflow when combined. 20 accounts × 2 swaps = 40, fits with ALTs. */
export const JUPITER_MAX_ACCOUNTS = 20;

/** Expected slippage during ~1.6s execution window, in basis points.
 *  This is deducted as a cost in profit calculations so the bot only
 *  fires on spreads wide enough to survive execution latency. */
export const EXECUTION_SLIPPAGE_BPS = 5;

/** Minimum net profit in USD after TX fees.
 *  Set to 0 — any positive profit triggers execution.
 *  Atomic TX reverts safely if unprofitable, so the only cost of
 *  a failed trade is ~$0.002 in TX fees. */
export const MIN_VIABLE_PROFIT_USD = 0;

/** Slippage tolerance for the REVERSE leg quotes, in bps.
 *  Higher than forward slippage because the reverse quote is based on
 *  the forward's EXPECTED output, not actual. In combined atomic TXs,
 *  error 6024 is NOT slippage — it's ZeroAmountSpecified (Raydium CLMM)
 *  or InsufficientFunds (Jupiter), caused by the forward leg producing
 *  fewer tokens than the reverse leg's instruction expects.
 *  The executor now simulates combined TXs and falls back to sequential
 *  execution (which uses real token balances) when simulation fails. */
export const REVERSE_LEG_SLIPPAGE_BPS = 300;

// Token list for scanning
export interface TokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
}

// PAIR SELECTION — avoid ultra-fast pairs (SOL/USDC, SOL/USDT) where latency
// matters most. Focus on LSTs, mid-cap tokens where spreads persist longer.
export const SCAN_TOKENS: TokenInfo[] = [
  // LSTs — slow-moving, persistent spreads across DEXes
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', decimals: 9 },
  // Mid-cap — lower competition, wider spreads
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6 },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', decimals: 9 },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 },
];

// ── Raydium pool addresses for WebSocket monitoring ─────────────────────────
// These are the highest-liquidity Raydium pools for each scan token paired with SOL.
// Used by PoolMonitor to subscribe via Helius WebSocket for instant price change detection.
// Both AMM V4 (standard) and CLMM (concentrated) pools included for broader coverage.
export interface PoolRegistryEntry {
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  poolType: 'amm-v4' | 'clmm';
  label: string;
}

export const RAYDIUM_POOL_REGISTRY: PoolRegistryEntry[] = [
  // LSTs — primary targets, slow-moving persistent spreads
  // mSOL/SOL — CLMM ($1.07M TVL)
  { poolAddress: '8EzbUfvcRT1Q6RL462ekGkgqbxsPmwC5FMLQZhSPMjJ3', tokenMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', tokenSymbol: 'mSOL', poolType: 'clmm', label: 'mSOL/SOL CLMM' },
  { poolAddress: 'EGyhb2uLAsRUbRx9dNFBjMVYnFaASWMvD6RE1aEf2LxL', tokenMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', tokenSymbol: 'mSOL', poolType: 'amm-v4', label: 'mSOL/SOL AMM' },
  // jitoSOL/SOL — CLMM ($1.77M TVL)
  { poolAddress: '2uoKbPEidR7KAMYtY4x7xdkHXWqYib5k4CutJauSL3Mc', tokenMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', tokenSymbol: 'jitoSOL', poolType: 'clmm', label: 'jitoSOL/SOL CLMM' },
  // bSOL/SOL
  { poolAddress: '7jQLGDGb3fjELEBM6BCvnqjxUGLkeAVUgh3ZimtkDs6Q', tokenMint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', tokenSymbol: 'bSOL', poolType: 'amm-v4', label: 'bSOL/SOL AMM' },
  // Mid-cap — lower competition, wider spreads
  // RAY/SOL
  { poolAddress: 'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA', tokenMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', tokenSymbol: 'RAY', poolType: 'amm-v4', label: 'RAY/SOL AMM' },
  { poolAddress: '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2', tokenMint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', tokenSymbol: 'RAY', poolType: 'clmm', label: 'RAY/SOL CLMM' },
  // JUP/SOL
  { poolAddress: 'EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw', tokenMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', tokenSymbol: 'JUP', poolType: 'clmm', label: 'JUP/SOL CLMM' },
  { poolAddress: 'EYErUp5muPYEEkeaUCY22JibeZX7E9UuMcJFZkmNAN7c', tokenMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', tokenSymbol: 'JUP', poolType: 'amm-v4', label: 'JUP/SOL AMM' },
];

// Jito Block Engine endpoints (ordered by geography)
export const JITO_BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

// Jito tip accounts — these are the official addresses recognized by
// Helius Sender and Jito block engine for tip routing.
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
    slippageBps: 50,           // 50 bps — atomic TX reverts entirely if unprofitable
    minProfitUsd: MIN_VIABLE_PROFIT_USD,  // Must exceed TX fee cost on failed attempts
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
  rpcWsUrl: string;
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
  /** Additional Jupiter API keys (free tier accounts) for parallel calls */
  jupiterApiKey2: string;
  jupiterApiKey3: string;
  jupiterApiKey4: string;
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
    rpcWsUrl: process.env.HELIUS_WS_URL || '',
    rpcCommitment: (process.env.RPC_COMMITMENT as any) || 'confirmed',
    privateKey: process.env.PRIVATE_KEY || '',
    riskLevel: (process.env.RISK_LEVEL as RiskLevel) || 'AGGRESSIVE',
    capitalSol: parseFloat(process.env.CAPITAL_SOL || '10'),
    scanAmountSol: parseFloat(process.env.SCAN_AMOUNT_SOL || '1.0'),
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://lite-api.jup.ag',
    jupiterApiKey: process.env.JUPITER_API_KEY || '',
    jupiterApiKey2: process.env.JUPITER_API_KEY_2 || '',
    jupiterApiKey3: process.env.JUPITER_API_KEY_3 || '',
    jupiterApiKey4: process.env.JUPITER_API_KEY_4 || '',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    jitoEnabled: process.env.JITO_ENABLED !== 'false',
    // CRITICAL: Must match JITO_TIP_LAMPORTS (200,000) used in profit calculations.
    // 200k lamports = 0.0002 SOL = minimum for Helius Sender dual routing (SWQoS + Jito).
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '200000'),
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

/**
 * Build headers for Jupiter API calls.
 * Includes x-api-key if configured. Pass json=true for POST requests.
 */
export function jupiterHeaders(config: BotConfig, json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey;
  return headers;
}
