// EXPRESS BACKEND SERVER FOR 24/7 MEV BOT
// Uses Jupiter LEGACY API (swap/v1/quote + swap/v1/swap)

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

// Simple auth middleware
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next(); // Dev mode
  if (req.headers['x-admin-token'] === token) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Bot state
let botRunning = false;
let botStats = {
  totalScans: 0,
  profitableFound: 0,
  tradesExecuted: 0,
  totalProfitUSD: 0,
  lastScanTime: null,
  status: 'stopped'
};

// RPC connection
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY';
let connection = null;

try {
  connection = new Connection(RPC_URL, 'confirmed');
  console.log('✅ RPC connection initialized');
} catch (error) {
  console.error('⚠️ RPC connection failed:', error.message);
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
    status: 'ok', 
    botRunning,
    uptime: process.uptime(),
    wallet: wallet?.publicKey.toString() || null
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
  botRunning = true;
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

    const swapRequest = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 'auto',
      dynamicComputeUnitLimit: true,
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
// MEV BOT LOGIC
// ==========================================

async function startMEVBot() {
  console.log('🚀 Starting 24/7 MEV Bot...');
  
  while (botRunning) {
    try {
      botStats.totalScans++;
      botStats.lastScanTime = new Date().toISOString();

      const opportunities = await scanForOpportunities();

      if (opportunities.length > 0) {
        console.log(`💎 Found ${opportunities.length} opportunities`);
        botStats.profitableFound += opportunities.length;

        for (const opp of opportunities) {
          if (!botRunning) break;
          
          const result = await executeTradeServerSide(opp);
          
          if (result.success) {
            botStats.tradesExecuted++;
            botStats.totalProfitUSD += result.profitUSD || 0;
            console.log(`✅ Trade executed: ${result.signature}`);
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 800));
    } catch (error) {
      console.error('❌ Bot error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log('⏹️  MEV Bot stopped');
}

async function scanForOpportunities() {
  const tokens = [
    { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP' },
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
    { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  ];

  const opportunities = [];

  for (const token of tokens) {
    try {
      const forwardQuote = await getQuote(
        'So11111111111111111111111111111111111111112',
        token.mint,
        100000000
      );

      const backwardQuote = await getQuote(
        token.mint,
        'So11111111111111111111111111111111111111112',
        forwardQuote.outAmount
      );

      const profit = (parseInt(backwardQuote.outAmount) - 100000000) / 1e9;
      const profitUSD = profit * 200;

      if (profitUSD > 0.01) {
        opportunities.push({
          token: token.symbol,
          inputAmount: 0.1,
          profitUSD,
          forwardQuote,
          backwardQuote
        });
      }
    } catch (error) {
      // Skip failed quotes
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
  if (!response.ok) throw new Error('Quote failed');
  return await response.json();
}

async function executeTradeServerSide(opportunity) {
  try {
    if (!wallet || !connection) {
      return { success: false, error: 'No wallet or RPC' };
    }

    const swapRequest = {
      quoteResponse: opportunity.forwardQuote,
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
      throw new Error(`Swap failed: ${response.status}`);
    }

    const { swapTransaction } = await response.json();

    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(signature, 'confirmed');

    return { 
      success: true, 
      signature,
      profitUSD: opportunity.profitUSD 
    };
  } catch (error) {
    console.error('❌ Trade execution failed:', error.message);
    return { success: false, error: error.message };
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
// START SERVER
// ==========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           MEV BOT BACKEND SERVER                       ║
╚════════════════════════════════════════════════════════╝

🚀 Server running on port ${PORT}
📊 React UI: http://localhost:${PORT}
🔌 API: http://localhost:${PORT}/api/*

${wallet ? '✅ Wallet loaded: ' + wallet.publicKey.toString() : '⚠️  No wallet configured'}

Ready for 24/7 trading! 🎯
  `);
});
