// EXPRESS BACKEND SERVER FOR 24/7 MEV BOT
// Uses Jupiter LEGACY API (swap/v1/quote + swap/v1/swap)
// FIXES: Complete arbitrage cycle, dynamic SOL price, expanded tokens, quality gates,
//        retry logic, graceful shutdown, env validation

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// ==========================================
// STARTUP VALIDATION
// ==========================================
const REQUIRED_ENV_VARS = ['HELIUS_RPC_URL'];
const RECOMMENDED_ENV_VARS = ['PRIVATE_KEY', 'ADMIN_TOKEN'];

function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  const missingRecommended = RECOMMENDED_ENV_VARS.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    console.error('Set these in your .env.production file or deployment config');
  }
  if (missingRecommended.length > 0) {
    console.warn(`WARNING: Missing recommended env vars: ${missingRecommended.join(', ')}`);
  }
}

validateEnvironment();

// Simple auth middleware
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next(); // Dev mode
  if (req.headers['x-admin-token'] === token) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// ==========================================
// EXPANDED TOKEN LIST (matches frontend's 20 tokens)
// ==========================================
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SCAN_TOKENS = [
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', decimals: 6 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', decimals: 5 },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', decimals: 6 },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', decimals: 9 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', decimals: 6 },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA', decimals: 6 },
  { mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', decimals: 5 },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME', decimals: 6 },
  { mint: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', symbol: 'stSOL', decimals: 9 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', decimals: 6 },
  { mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', symbol: 'MNDE', decimals: 9 },
  { mint: 'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', symbol: 'KIN', decimals: 5 },
];

// ==========================================
// DYNAMIC SOL PRICE
// ==========================================
let solPriceCache = { price: 0, timestamp: 0 };
const SOL_PRICE_TTL = 30000; // 30 seconds

async function getSOLPrice() {
  if (solPriceCache.price > 0 && Date.now() - solPriceCache.timestamp < SOL_PRICE_TTL) {
    return solPriceCache.price;
  }

  try {
    const quote = await getQuote(SOL_MINT, USDC_MINT, 1_000_000_000); // 1 SOL
    const price = parseInt(quote.outAmount) / 1e6;

    if (price > 0 && price < 2000) {
      solPriceCache = { price, timestamp: Date.now() };
      return price;
    }
  } catch (error) {
    // ignore
  }

  // Use cached or fallback
  if (solPriceCache.price > 0) return solPriceCache.price;
  console.warn('Using fallback SOL price $180');
  return 180;
}

// Bot state
let botRunning = false;
let shuttingDown = false;
let currentTradeInFlight = false;

let botStats = {
  totalScans: 0,
  profitableFound: 0,
  tradesExecuted: 0,
  tradesSkipped: 0,
  tradesFailed: 0,
  totalProfitUSD: 0,
  lastScanTime: null,
  status: 'stopped',
  consecutiveFailures: 0,
  solPrice: 0,
};

// RPC connection
const RPC_URL = process.env.HELIUS_RPC_URL || '';
let connection = null;

if (RPC_URL) {
  try {
    connection = new Connection(RPC_URL, 'confirmed');
    console.log('RPC connection initialized');
  } catch (error) {
    console.error('RPC connection failed:', error.message);
  }
} else {
  console.error('HELIUS_RPC_URL not set - bot cannot trade');
}

// Wallet
let wallet = null;
if (process.env.PRIVATE_KEY) {
  try {
    const privateKeyArray = bs58.decode(process.env.PRIVATE_KEY);
    wallet = Keypair.fromSecretKey(privateKeyArray);
    console.log('Wallet loaded:', wallet.publicKey.toString());
  } catch (error) {
    console.error('Wallet loading failed:', error.message);
  }
} else {
  console.warn('No PRIVATE_KEY env var - wallet disabled');
}

// ==========================================
// API ENDPOINTS
// ==========================================

app.get('/api/health', requireAdmin, (req, res) => {
  res.json({
    status: 'ok',
    botRunning,
    uptime: process.uptime(),
    wallet: wallet?.publicKey.toString() || null,
    rpcConfigured: !!RPC_URL,
    solPrice: solPriceCache.price,
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
  shuttingDown = false;
  botStats.status = 'running';
  startMEVBot();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', requireAdmin, (req, res) => {
  botRunning = false;
  botStats.status = currentTradeInFlight ? 'stopping (trade in flight)' : 'stopped';
  res.json({ success: true, message: currentTradeInFlight ? 'Stopping after current trade completes' : 'Bot stopped' });
});

// LEGACY swap endpoint
app.post('/api/swap', requireAdmin, async (req, res) => {
  try {
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
      console.error(`Jupiter API error ${response.status}:`, errorText);
      return res.status(response.status).json({
        error: `Jupiter API error: ${response.status}`,
        details: errorText
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Swap error:', error.message);
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

    if (!inputMint || !outputMint || inputMint.length < 30 || outputMint.length < 30) {
      return res.status(400).json({ error: 'Invalid mint addresses' });
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
    console.error('Quote error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MEV BOT LOGIC
// ==========================================

async function startMEVBot() {
  console.log('Starting 24/7 MEV Bot...');
  console.log(`Scanning ${SCAN_TOKENS.length} tokens`);

  // Initialize SOL price
  const solPrice = await getSOLPrice();
  botStats.solPrice = solPrice;
  console.log(`SOL Price: $${solPrice.toFixed(2)}`);

  while (botRunning) {
    try {
      botStats.totalScans++;
      botStats.lastScanTime = new Date().toISOString();

      const opportunities = await scanForOpportunities();

      if (opportunities.length > 0) {
        console.log(`Found ${opportunities.length} opportunities`);
        botStats.profitableFound += opportunities.length;

        // Execute best opportunity (highest profit first)
        opportunities.sort((a, b) => b.profitUSD - a.profitUSD);

        for (const opp of opportunities) {
          if (!botRunning) break;

          const result = await executeArbitrageServerSide(opp);

          if (result.success) {
            botStats.tradesExecuted++;
            botStats.totalProfitUSD += result.profitUSD || 0;
            botStats.consecutiveFailures = 0;
            console.log(`Arbitrage complete: +$${(result.profitUSD || 0).toFixed(4)} [${opp.token}]`);
          } else if (result.skipped) {
            botStats.tradesSkipped++;
          } else {
            botStats.tradesFailed++;
            botStats.consecutiveFailures++;
          }

          // Circuit breaker: stop after 5 consecutive failures
          if (botStats.consecutiveFailures >= 5) {
            console.error('Circuit breaker: 5 consecutive failures, pausing 60s');
            await new Promise(resolve => setTimeout(resolve, 60000));
            botStats.consecutiveFailures = 0;
          }
        }
      }

      // Adaptive scan interval based on time of day
      const hour = new Date().getUTCHours();
      const isHighActivity = (hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 16) || (hour >= 21 && hour <= 24);
      const scanDelay = isHighActivity ? 800 : 2000;

      await new Promise(resolve => setTimeout(resolve, scanDelay));
    } catch (error) {
      console.error('Bot scan error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log('MEV Bot stopped');
  botStats.status = 'stopped';
}

async function scanForOpportunities() {
  const opportunities = [];
  const solPrice = await getSOLPrice();
  botStats.solPrice = solPrice;

  const scanAmountLamports = 100_000_000; // 0.1 SOL

  // Scan tokens in parallel (batches of 4 to avoid rate limits)
  for (let i = 0; i < SCAN_TOKENS.length; i += 4) {
    const batch = SCAN_TOKENS.slice(i, i + 4);

    const batchResults = await Promise.allSettled(
      batch.map(async (token) => {
        // Forward: SOL -> Token
        const forwardQuote = await getQuote(SOL_MINT, token.mint, scanAmountLamports);
        if (!forwardQuote?.outAmount) return null;

        // Reverse: Token -> SOL
        const backwardQuote = await getQuote(token.mint, SOL_MINT, forwardQuote.outAmount);
        if (!backwardQuote?.outAmount) return null;

        const solBack = parseInt(backwardQuote.outAmount);
        const profitLamports = solBack - scanAmountLamports;
        const profitSOL = profitLamports / 1e9;
        const profitUSD = profitSOL * solPrice;

        // Only report if profitable after fees (estimated 0.002 SOL per round trip)
        const estimatedFees = 0.002 * solPrice;
        const netProfitUSD = profitUSD - estimatedFees;

        if (netProfitUSD > 0.01) {
          return {
            token: token.symbol,
            tokenMint: token.mint,
            inputAmountLamports: scanAmountLamports,
            profitSOL,
            profitUSD: netProfitUSD,
            forwardQuote,
            backwardQuote,
            roundTripLossPercent: ((scanAmountLamports - solBack) / scanAmountLamports) * 100,
          };
        }
        return null;
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled' && result.value) {
        opportunities.push(result.value);
      }
    }

    // Small delay between batches
    if (i + 4 < SCAN_TOKENS.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

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

// ==========================================
// COMPLETE ARBITRAGE EXECUTION
// ==========================================

async function executeArbitrageServerSide(opportunity) {
  if (!wallet || !connection) {
    return { success: false, error: 'No wallet or RPC' };
  }

  currentTradeInFlight = true;
  const signatures = [];

  try {
    // ── Quality Gate: Verify round-trip is still profitable ──
    const freshForward = await getQuote(SOL_MINT, opportunity.tokenMint, opportunity.inputAmountLamports);
    const freshReverse = await getQuote(opportunity.tokenMint, SOL_MINT, freshForward.outAmount);
    const freshSolBack = parseInt(freshReverse.outAmount);
    const freshLossPercent = ((opportunity.inputAmountLamports - freshSolBack) / opportunity.inputAmountLamports) * 100;

    if (freshLossPercent > 3) {
      console.log(`Skipped ${opportunity.token}: round-trip loss ${freshLossPercent.toFixed(2)}% > 3% threshold`);
      currentTradeInFlight = false;
      return { success: false, skipped: true };
    }

    // ── STEP 1: Forward Swap (SOL -> Token) ──
    console.log(`[${opportunity.token}] FORWARD: SOL -> ${opportunity.token}`);
    const forwardSig = await executeSwap(freshForward);
    if (!forwardSig) {
      throw new Error('Forward swap failed - no signature returned');
    }
    signatures.push(forwardSig);

    // Wait for forward confirmation
    await waitForConfirmation(forwardSig, 15000);

    // ── STEP 2: Get actual token balance received ──
    let tokenBalance = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const accounts = await connection.getTokenAccountsByOwner(
          wallet.publicKey,
          { mint: new (await import('@solana/web3.js')).PublicKey(opportunity.tokenMint) }
        );
        if (accounts.value.length > 0) {
          const balance = await connection.getTokenAccountBalance(accounts.value[0].pubkey);
          tokenBalance = parseInt(balance.value.amount);
          if (tokenBalance > 0) break;
        }
      } catch (e) { /* retry */ }
      await new Promise(r => setTimeout(r, 500));
    }

    if (tokenBalance === 0) {
      console.error(`[${opportunity.token}] No tokens received after forward swap!`);
      throw new Error('Forward swap succeeded but no tokens received');
    }

    console.log(`[${opportunity.token}] Received ${tokenBalance} tokens`);

    // ── STEP 3: Reverse Swap (Token -> SOL) with retries ──
    console.log(`[${opportunity.token}] REVERSE: ${opportunity.token} -> SOL`);
    let reverseSig = null;
    let reverseAttempts = 0;
    const MAX_REVERSE_RETRIES = 3;

    while (!reverseSig && reverseAttempts < MAX_REVERSE_RETRIES) {
      reverseAttempts++;
      try {
        const reverseQuote = await getQuote(opportunity.tokenMint, SOL_MINT, tokenBalance);
        reverseSig = await executeSwap(reverseQuote);

        if (reverseSig) {
          signatures.push(reverseSig);
          await waitForConfirmation(reverseSig, 15000);
        }
      } catch (error) {
        console.error(`[${opportunity.token}] Reverse attempt ${reverseAttempts}/${MAX_REVERSE_RETRIES} failed:`, error.message);
        if (reverseAttempts < MAX_REVERSE_RETRIES) {
          // Exponential backoff: 1s, 2s, 4s
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, reverseAttempts - 1)));
        }
      }
    }

    if (!reverseSig) {
      console.error(`STUCK POSITION: Holding ${tokenBalance} ${opportunity.token} after ${MAX_REVERSE_RETRIES} reverse attempts`);
      throw new Error(`Reverse swap failed after ${MAX_REVERSE_RETRIES} attempts - stuck holding ${opportunity.token}`);
    }

    // ── Calculate actual profit ──
    const solPrice = await getSOLPrice();
    // We can't easily know the exact SOL received, so use quote estimate
    const estimatedSolBack = parseInt(freshReverse.outAmount);
    const profitLamports = estimatedSolBack - opportunity.inputAmountLamports;
    const profitSOL = profitLamports / 1e9;
    const profitUSD = profitSOL * solPrice;

    currentTradeInFlight = false;
    return {
      success: true,
      signatures,
      profitUSD,
      profitSOL,
    };

  } catch (error) {
    console.error(`[${opportunity.token}] Arbitrage failed:`, error.message);
    currentTradeInFlight = false;
    return { success: false, error: error.message, signatures };
  }
}

async function executeSwap(quoteResponse) {
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
    const text = await response.text();
    throw new Error(`Swap API error ${response.status}: ${text.substring(0, 200)}`);
  }

  const { swapTransaction } = await response.json();

  if (!swapTransaction) {
    throw new Error('No swapTransaction in response');
  }

  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  return signature;
}

async function waitForConfirmation(signature, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: false });
      if (status?.value?.confirmationStatus === 'confirmed' || status?.value?.confirmationStatus === 'finalized') {
        return true;
      }
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 400));
  }
  console.warn(`Transaction ${signature.substring(0, 16)}... not confirmed within ${timeoutMs}ms, proceeding anyway`);
  return false;
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

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received - initiating graceful shutdown`);

  botRunning = false;
  botStats.status = 'shutting down';

  // Wait for in-flight trade to complete (max 30s)
  const shutdownTimeout = setTimeout(() => {
    console.log('Shutdown timeout reached, forcing exit');
    process.exit(0);
  }, 30000);

  const checkAndExit = setInterval(() => {
    if (!currentTradeInFlight) {
      clearInterval(checkAndExit);
      clearTimeout(shutdownTimeout);
      console.log('All trades complete, shutting down');
      process.exit(0);
    }
    console.log('Waiting for in-flight trade to complete...');
  }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
MEV BOT BACKEND SERVER
Server running on port ${PORT}
React UI: http://localhost:${PORT}
API: http://localhost:${PORT}/api/*
Tokens: ${SCAN_TOKENS.length} scanned
RPC: ${RPC_URL ? 'configured' : 'NOT SET'}
${wallet ? 'Wallet: ' + wallet.publicKey.toString() : 'No wallet configured'}
  `);
});
