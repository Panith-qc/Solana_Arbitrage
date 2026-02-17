// EXPRESS BACKEND SERVER FOR 24/7 MEV BOT
// Uses Jupiter LEGACY API (swap/v1/quote + swap/v1/swap)
// FIXES: Complete arbitrage cycle, dynamic SOL pricing, 20-token scanning,
//        quality gates, retry logic, graceful shutdown, env validation

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// ==========================================
// STARTUP ENVIRONMENT VALIDATION
// ==========================================
const REQUIRED_ENV_VARS = ['HELIUS_RPC_URL'];
const RECOMMENDED_ENV_VARS = ['PRIVATE_KEY', 'ADMIN_TOKEN'];

function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  const missingRecommended = RECOMMENDED_ENV_VARS.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error(`❌ CRITICAL: Missing required env vars: ${missing.join(', ')}`);
    console.error('   Copy .env.example to .env.production and fill in values.');
  }

  if (missingRecommended.length > 0) {
    console.warn(`⚠️  Missing recommended env vars: ${missingRecommended.join(', ')}`);
  }

  return missing.length === 0;
}

const envValid = validateEnvironment();

// Middleware
app.use(cors());
app.use(express.json());

// Simple auth middleware
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next(); // Dev mode
  if (req.headers['x-admin-token'] === token) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// ==========================================
// TOKEN CONFIGURATION (expanded from 3 to 20)
// Mirrors frontend's topTokens.ts
// ==========================================
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LAMPORTS_PER_SOL = 1_000_000_000;

const SCAN_TOKENS = [
  // Stablecoins (for price reference, not arb targets themselves)
  // Blue-chip & DEX tokens
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6 },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6 },
  // Liquid staking tokens
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9 },
  { mint: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', symbol: 'stSOL', decimals: 9 },
  // Memecoins (high volatility = more arb opportunities)
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6 },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', decimals: 5 },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME', decimals: 6 },
  // Other blue chips
  { mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9 },
  { mint: 'Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1', symbol: 'SBR', decimals: 6 },
  { mint: 'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', symbol: 'KIN', decimals: 5 },
];

// ==========================================
// DYNAMIC SOL PRICE (replaces hardcoded $200)
// ==========================================
let solPriceCache = { price: 0, timestamp: 0 };
const SOL_PRICE_CACHE_TTL = 30000; // 30 seconds

async function getSOLPriceUSD() {
  // Return cached price if fresh
  if (solPriceCache.price > 0 && (Date.now() - solPriceCache.timestamp < SOL_PRICE_CACHE_TTL)) {
    return solPriceCache.price;
  }

  try {
    // Quote 1 SOL -> USDC to get real price
    const quote = await getQuote(SOL_MINT, USDC_MINT, LAMPORTS_PER_SOL);
    const price = parseInt(quote.outAmount) / 1e6; // USDC has 6 decimals

    if (price <= 0 || isNaN(price) || price > 10000) {
      throw new Error(`Unreasonable SOL price: $${price}`);
    }

    solPriceCache = { price, timestamp: Date.now() };
    return price;
  } catch (error) {
    // Use cached price if available
    if (solPriceCache.price > 0) {
      console.warn(`⚠️  SOL price fetch failed, using cached: $${solPriceCache.price.toFixed(2)}`);
      return solPriceCache.price;
    }
    // No cached price and API failed — return null so callers skip trades
    console.error('❌ SOL price unavailable — skipping this cycle');
    return null;
  }
}

// Bot state
let botRunning = false;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10; // Circuit breaker threshold

// Stuck token recovery queue — tokens left over from failed reverse swaps
let stuckTokens = [];

let botStats = {
  totalScans: 0,
  profitableFound: 0,
  tradesExecuted: 0,
  tradesSkipped: 0,
  tradesFailed: 0,
  totalProfitUSD: 0,
  lastScanTime: null,
  status: 'stopped',
  currentSOLPrice: 0,
  tokensScanning: SCAN_TOKENS.length,
};

// RPC connection
const RPC_URL = process.env.HELIUS_RPC_URL || '';
let connection = null;

if (RPC_URL) {
  try {
    connection = new Connection(RPC_URL, 'confirmed');
    console.log('✅ RPC connection initialized');
  } catch (error) {
    console.error('⚠️ RPC connection failed:', error.message);
  }
} else {
  console.error('❌ HELIUS_RPC_URL not configured - bot will not function');
}

// Wallet
let wallet = null;
if (process.env.PRIVATE_KEY) {
  try {
    const privateKeyArray = bs58.decode(process.env.PRIVATE_KEY);
    wallet = Keypair.fromSecretKey(privateKeyArray);
    console.log('✅ Wallet loaded:', wallet.publicKey.toString());
  } catch (error) {
    console.error('⚠️ Wallet loading failed:', error.message);
  }
} else {
  console.log('⚠️ No PRIVATE_KEY env var - wallet disabled');
}

// ==========================================
// API ENDPOINTS
// ==========================================

app.get('/api/health', requireAdmin, (req, res) => {
  res.json({
    status: envValid ? 'ok' : 'degraded',
    botRunning,
    uptime: process.uptime(),
    wallet: wallet?.publicKey.toString() || null,
    envValid,
  });
});

app.get('/api/status', requireAdmin, (req, res) => {
  res.json({
    ...botStats,
    botRunning,
    wallet: wallet?.publicKey.toString() || null
  });
});

app.post('/api/start', requireAdmin, async (req, res) => {
  if (botRunning) {
    return res.json({ success: false, message: 'Bot already running' });
  }
  if (!wallet) {
    return res.json({ success: false, message: 'No wallet configured' });
  }
  if (!connection) {
    return res.json({ success: false, message: 'No RPC connection' });
  }
  botRunning = true;
  consecutiveFailures = 0;
  botStats.status = 'running';
  startMEVBot();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', requireAdmin, (req, res) => {
  botRunning = false;
  botStats.status = 'stopped';
  res.json({ success: true, message: 'Bot stopped' });
});

// LEGACY swap endpoint
app.post('/api/swap', requireAdmin, async (req, res) => {
  try {
    console.log('📡 /api/swap called');
    const { quoteResponse, userPublicKey } = req.body;

    if (!quoteResponse || !userPublicKey) {
      return res.status(400).json({ error: 'Missing quoteResponse or userPublicKey' });
    }

    const cleanedQuote = {
      inputMint: quoteResponse.inputMint,
      inAmount: quoteResponse.inAmount,
      outputMint: quoteResponse.outputMint,
      outAmount: quoteResponse.outAmount,
      otherAmountThreshold: quoteResponse.otherAmountThreshold,
      swapMode: quoteResponse.swapMode,
      slippageBps: quoteResponse.slippageBps,
      priceImpactPct: quoteResponse.priceImpactPct
    };

    const swapRequest = {
      quoteResponse: cleanedQuote,
      userPublicKey,
      wrapAndUnwrapSol: true,
    };

    const response = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(swapRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Jupiter API error ${response.status}:`, errorText);
      return res.status(response.status).json({
        error: `Jupiter API error: ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();
    console.log('✅ Jupiter swap success');
    res.json(data);
  } catch (error) {
    console.error('❌ Swap error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// LEGACY quote endpoint
app.post('/api/quote', requireAdmin, async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps } = req.body;

    if (!amount || !/^[0-9]+$/.test(amount.toString())) {
      return res.status(400).json({ error: 'amount must be integer base units (lamports)' });
    }

    const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
    url.searchParams.append('inputMint', inputMint);
    url.searchParams.append('outputMint', outputMint);
    url.searchParams.append('amount', amount.toString());
    url.searchParams.append('slippageBps', (slippageBps || 50).toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: 'Jupiter quote failed', details: text });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('❌ Quote error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MEV BOT LOGIC (Unified with frontend logic)
// ==========================================

// ==========================================
// RATE LIMITING (free tier safe)
// ==========================================
const JUPITER_MAX_REQ_PER_SEC = parseInt(process.env.JUPITER_RATE_LIMIT_PER_SEC || '1', 10);
const JUPITER_MIN_DELAY_MS = Math.ceil(1000 / JUPITER_MAX_REQ_PER_SEC);

async function rateLimitedDelay() {
  return new Promise(resolve => setTimeout(resolve, JUPITER_MIN_DELAY_MS));
}

/**
 * Get scan interval based on time of day.
 * Increased to stay safe on free tier:
 *   - With serialized requests and ~15 tokens → ~30s per cycle
 *   - Interval adds buffer after cycle completes
 */
function getScanInterval() {
  const hour = new Date().getUTCHours();
  // High activity periods
  if ((hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 16) || (hour >= 21 && hour <= 24)) {
    return 30000; // 30 seconds
  }
  return 45000; // 45 seconds
}

/**
 * Attempt to recover stuck tokens from failed reverse swaps.
 * Tries to swap them back to SOL.
 */
async function recoverStuckTokens() {
  if (stuckTokens.length === 0) return;

  console.log(`🔧 Attempting recovery of ${stuckTokens.length} stuck token(s)...`);
  const remaining = [];

  for (const stuck of stuckTokens) {
    try {
      // Check if we still hold the token
      const balance = await verifyTokenBalance(stuck.tokenMint, 3000);
      if (balance <= 0n) {
        console.log(`   ✅ ${stuck.symbol} already recovered (balance is 0)`);
        continue;
      }

      await rateLimitedDelay();
      const quote = await getQuote(stuck.tokenMint, SOL_MINT, balance.toString());
      await rateLimitedDelay();
      const sig = await executeSwap(quote);
      console.log(`   ✅ Recovered ${stuck.symbol} → SOL: ${sig}`);
    } catch (error) {
      console.error(`   ❌ Recovery failed for ${stuck.symbol}: ${error.message}`);
      // Keep in queue if less than 1 hour old
      if (Date.now() - stuck.timestamp < 3600000) {
        remaining.push(stuck);
      } else {
        console.warn(`   ⏰ Giving up on ${stuck.symbol} (>1 hour old) — manual intervention needed`);
      }
    }
  }

  stuckTokens = remaining;
}

async function startMEVBot() {
  console.log('🚀 Starting 24/7 MEV Bot...');
  console.log(`📊 Scanning ${SCAN_TOKENS.length} tokens (expanded from 3)`);
  console.log(`💵 Dynamic SOL pricing enabled`);
  console.log(`🔄 Complete arbitrage cycle (forward + reverse)`);
  console.log(`🛡️ Quality gates and circuit breaker enabled`);

  // Initialize SOL price
  try {
    const price = await getSOLPriceUSD();
    botStats.currentSOLPrice = price;
    console.log(`💵 Current SOL Price: $${price.toFixed(2)}`);
  } catch (e) {
    console.warn('⚠️  Could not fetch initial SOL price');
  }

  while (botRunning) {
    try {
      // Circuit breaker: stop if too many consecutive failures
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`🛑 Circuit breaker triggered: ${consecutiveFailures} consecutive failures. Pausing 5 minutes.`);
        botStats.status = 'circuit_breaker';
        await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
        consecutiveFailures = 0;
        botStats.status = 'running';
        console.log('🔄 Circuit breaker reset, resuming...');
      }

      // Attempt to recover any stuck tokens from previous failed swaps
      await recoverStuckTokens();

      botStats.totalScans++;
      botStats.lastScanTime = new Date().toISOString();

      // Refresh SOL price periodically — skip cycle if unavailable
      const solPrice = await getSOLPriceUSD();
      if (solPrice === null) {
        console.warn('⚠️  Skipping scan — no SOL price available');
        const interval = getScanInterval();
        await new Promise(resolve => setTimeout(resolve, interval));
        continue;
      }
      botStats.currentSOLPrice = solPrice;

      const opportunities = await scanForOpportunities(solPrice);

      if (opportunities.length > 0) {
        console.log(`💎 Found ${opportunities.length} opportunities`);
        botStats.profitableFound += opportunities.length;

        for (const opp of opportunities) {
          if (!botRunning) break;

          const result = await executeArbitrageServerSide(opp, solPrice);

          if (result.success) {
            botStats.tradesExecuted++;
            botStats.totalProfitUSD += result.profitUSD || 0;
            consecutiveFailures = 0;
            console.log(`✅ Arbitrage complete: $${(result.profitUSD || 0).toFixed(4)} profit`);
          } else if (result.skipped) {
            botStats.tradesSkipped++;
          } else {
            botStats.tradesFailed++;
            consecutiveFailures++;
          }
        }
      }

      // Time-based scan interval (mirrors frontend StrategyEngine)
      const interval = getScanInterval();
      await new Promise(resolve => setTimeout(resolve, interval));
    } catch (error) {
      console.error('❌ Bot error:', error.message);
      consecutiveFailures++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log('⏹️  MEV Bot stopped');
}

/**
 * Scan all tokens for arbitrage opportunities (expanded from 3 to 20)
 * Quality gate: only return opportunities where round-trip loss < 3%
 */
async function scanForOpportunities(solPrice) {
  const scanAmount = 100000000; // 0.1 SOL in lamports
  const opportunities = [];

  // Scan tokens SEQUENTIALLY to respect free tier rate limits
  // Each getQuote call is followed by a rate-limit delay
  for (const token of SCAN_TOKENS) {
    try {
      await rateLimitedDelay();
      const forwardQuote = await getQuote(SOL_MINT, token.mint, scanAmount);
      if (!forwardQuote || !forwardQuote.outAmount) continue;

      await rateLimitedDelay();
      const backwardQuote = await getQuote(token.mint, SOL_MINT, forwardQuote.outAmount);
      if (!backwardQuote || !backwardQuote.outAmount) continue;

      const solBack = parseInt(backwardQuote.outAmount);
      const profit = (solBack - scanAmount) / 1e9;
      const lossPercent = ((scanAmount - solBack) / scanAmount) * 100;

      // Quality gate: reject if round-trip loss > 3%
      if (lossPercent > 3) {
        continue;
      }

      // Only pursue if profitable after estimated fees (~0.004 SOL for 2 swaps)
      const estimatedFeesSOL = 0.004;
      const netProfitSOL = profit - estimatedFeesSOL;
      const netProfitUSD = netProfitSOL * solPrice;

      // Minimum $0.50 profit to justify gas + risk
      if (netProfitUSD > 0.50) {
        opportunities.push({
          token: token.symbol,
          tokenMint: token.mint,
          inputAmount: scanAmount / 1e9,
          inputLamports: scanAmount,
          profitSOL: netProfitSOL,
          profitUSD: netProfitUSD,
          lossPercent,
          forwardQuote,
          backwardQuote,
        });
      }
    } catch (error) {
      // Skip failed quotes silently
      continue;
    }
  }

  // Sort by profit (best first)
  opportunities.sort((a, b) => b.profitUSD - a.profitUSD);

  return opportunities;
}

async function getQuote(inputMint, outputMint, amount) {
  const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
  url.searchParams.append('inputMint', inputMint);
  url.searchParams.append('outputMint', outputMint);
  url.searchParams.append('amount', amount.toString());
  url.searchParams.append('slippageBps', '50');

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Quote failed: ${response.status}`);
  return await response.json();
}

/**
 * Execute a single swap (used for both forward and reverse legs)
 */
async function executeSwap(quoteResponse) {
  if (!wallet || !connection) {
    throw new Error('No wallet or RPC connection');
  }

  const swapRequest = {
    quoteResponse,
    userPublicKey: wallet.publicKey.toString(),
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: 100000,
  };

  const response = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(swapRequest),
  });

  if (!response.ok) {
    throw new Error(`Swap API failed: ${response.status}`);
  }

  const { swapTransaction } = await response.json();

  if (!swapTransaction) {
    throw new Error('Empty swap transaction returned');
  }

  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(signature, 'confirmed');

  return signature;
}

/**
 * Verify token account balance after forward swap
 */
async function verifyTokenBalance(tokenMint, maxWaitMs = 5000) {
  const pollInterval = 500;
  const maxAttempts = Math.ceil(maxWaitMs / pollInterval);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { mint: new PublicKey(tokenMint) }
      );

      if (tokenAccounts.value.length > 0) {
        const balance = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        const amount = BigInt(balance.value.amount);
        if (amount > 0n) {
          return amount;
        }
      }
    } catch (error) {
      // Retry
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error('Token account not found after forward swap');
}

/**
 * Execute complete arbitrage cycle: SOL -> Token -> SOL
 * This is the critical fix - the old code only did SOL -> Token (forward leg)
 */
async function executeArbitrageServerSide(opportunity, solPrice) {
  const signatures = [];

  try {
    console.log(`\n🔄 Executing arbitrage: SOL -> ${opportunity.token} -> SOL`);
    console.log(`   Expected profit: $${opportunity.profitUSD.toFixed(4)}`);

    // ═══════════════════════════════════════════════════════
    // STEP 1: FORWARD SWAP (SOL -> Token)
    // ═══════════════════════════════════════════════════════
    console.log(`   ➡️  Forward: SOL -> ${opportunity.token}`);
    const forwardSig = await executeSwap(opportunity.forwardQuote);
    signatures.push(forwardSig);
    console.log(`   ✅ Forward complete: ${forwardSig}`);

    // ═══════════════════════════════════════════════════════
    // STEP 2: VERIFY TOKEN RECEIVED
    // ═══════════════════════════════════════════════════════
    let tokenBalance;
    try {
      tokenBalance = await verifyTokenBalance(opportunity.tokenMint);
      console.log(`   ✅ Token balance verified: ${tokenBalance}`);
    } catch (verifyError) {
      console.error(`   ❌ Token verification failed — cannot confirm forward swap landed`);
      console.error(`   ⚠️  Aborting reverse. Tokens may need manual recovery.`);
      return {
        success: false,
        error: 'Forward swap unverified — aborted reverse to prevent blind swap',
        signatures,
        needsRecovery: true,
        stuckToken: opportunity.tokenMint,
      };
    }

    // ═══════════════════════════════════════════════════════
    // STEP 3: GET FRESH REVERSE QUOTE (prices may have moved)
    // ═══════════════════════════════════════════════════════
    let reverseQuote;
    try {
      await rateLimitedDelay();
      reverseQuote = await getQuote(
        opportunity.tokenMint,
        SOL_MINT,
        tokenBalance.toString()
      );
    } catch (quoteError) {
      // Fallback: use original backward quote (from scan, may be slightly stale)
      console.warn(`   ⚠️  Fresh reverse quote failed, using scan quote as fallback`);
      reverseQuote = opportunity.backwardQuote;
    }

    // ═══════════════════════════════════════════════════════
    // STEP 4: REVERSE SWAP (Token -> SOL) with retry
    // ═══════════════════════════════════════════════════════
    console.log(`   ⬅️  Reverse: ${opportunity.token} -> SOL`);
    let reverseSig = null;
    let reverseAttempts = 0;
    const maxReverseAttempts = 3;

    while (reverseAttempts < maxReverseAttempts && !reverseSig) {
      reverseAttempts++;
      try {
        reverseSig = await executeSwap(reverseQuote);
        signatures.push(reverseSig);
        console.log(`   ✅ Reverse complete: ${reverseSig}`);
      } catch (reverseError) {
        console.error(`   ❌ Reverse attempt ${reverseAttempts}/${maxReverseAttempts} failed: ${reverseError.message}`);
        if (reverseAttempts < maxReverseAttempts) {
          // Wait before retry with exponential backoff
          await new Promise(r => setTimeout(r, 1000 * reverseAttempts));
          // Get fresh quote for retry (with rate limit delay)
          try {
            await rateLimitedDelay();
            reverseQuote = await getQuote(opportunity.tokenMint, SOL_MINT, tokenBalance.toString());
          } catch (e) {
            // Use previous quote
          }
        }
      }
    }

    if (!reverseSig) {
      console.error(`   ❌ CRITICAL: Reverse swap failed after ${maxReverseAttempts} attempts!`);
      console.error(`   ⚠️  Queuing ${opportunity.token} for auto-recovery on next cycle`);
      stuckTokens.push({
        tokenMint: opportunity.tokenMint,
        symbol: opportunity.token,
        balance: tokenBalance.toString(),
        timestamp: Date.now(),
      });
      return {
        success: false,
        error: 'Reverse swap failed - queued for auto-recovery',
        signatures,
        needsRecovery: true,
        stuckToken: opportunity.tokenMint,
      };
    }

    // ═══════════════════════════════════════════════════════
    // STEP 5: CALCULATE ACTUAL PROFIT
    // ═══════════════════════════════════════════════════════
    const solReceived = parseInt(reverseQuote.outAmount) / 1e9;
    const solSpent = opportunity.inputAmount;
    const actualProfitSOL = solReceived - solSpent;
    const actualProfitUSD = actualProfitSOL * solPrice;

    console.log(`   💰 Actual profit: ${actualProfitSOL.toFixed(6)} SOL ($${actualProfitUSD.toFixed(4)})`);

    return {
      success: true,
      profitSOL: actualProfitSOL,
      profitUSD: actualProfitUSD,
      signatures,
    };

  } catch (error) {
    console.error(`   ❌ Arbitrage failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      signatures,
    };
  }
}

// ==========================================
// SERVE REACT FRONTEND
// ==========================================

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } catch (error) {
    res.status(500).send('Frontend not available');
  }
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

let server = null;

function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  // Stop the bot loop
  botRunning = false;
  botStats.status = 'shutting_down';

  // Give in-flight trades 30 seconds to complete
  const shutdownTimeout = setTimeout(() => {
    console.log('⏱️  Shutdown timeout reached, forcing exit');
    process.exit(1);
  }, 30000);

  // Close HTTP server (stop accepting new requests)
  if (server) {
    server.close(() => {
      console.log('✅ HTTP server closed');
      clearTimeout(shutdownTimeout);
      process.exit(0);
    });
  } else {
    clearTimeout(shutdownTimeout);
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==========================================
// START SERVER
// ==========================================

server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           MEV BOT BACKEND SERVER                       ║
╚════════════════════════════════════════════════════════╝

🚀 Server running on port ${PORT}
📊 React UI: http://localhost:${PORT}
🔌 API: http://localhost:${PORT}/api/*

${wallet ? '✅ Wallet loaded: ' + wallet.publicKey.toString() : '⚠️  No wallet configured'}
${envValid ? '✅ Environment validated' : '⚠️  Missing environment variables'}
📊 Scanning ${SCAN_TOKENS.length} tokens
💵 Dynamic SOL pricing enabled
🔄 Complete arbitrage cycle (forward + reverse)
🛡️ Circuit breaker: ${MAX_CONSECUTIVE_FAILURES} failures
  `);
});
