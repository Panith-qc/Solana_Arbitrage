// ⚡ PHASE 2.5 SPEED TEST
// Measure actual execution time in MILLISECONDS (not seconds!)
// Goal: Complete scans in <5000ms with profitable opportunities

import { Connection } from '@solana/web3.js';
import { initFastJupiterService, getFastJupiterService } from './src/services/fastJupiterService';

// Token mints for testing
const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};

async function testSpeed() {
  console.log('\n═══════════════════════════════════════');
  console.log('⚡ PHASE 2.5 SPEED TEST');
  console.log('═══════════════════════════════════════\n');

  // Initialize connection
  const connection = new Connection(
    process.env.VITE_HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
    'confirmed'
  );

  // Initialize fast Jupiter service
  const fastJupiter = initFastJupiterService(connection);
  console.log('✅ Fast Jupiter service initialized\n');

  // TEST 1: Single quote speed
  console.log('📊 TEST 1: Single Quote Speed');
  console.log('─────────────────────────────────────');
  
  const singleStartTime = Date.now();
  const quote1 = await fastJupiter.getQuote(
    TOKENS.SOL,
    TOKENS.USDC,
    100_000_000, // 0.1 SOL
    50
  );
  const singleTime = Date.now() - singleStartTime;
  
  if (quote1) {
    console.log(`✅ Quote received in ${singleTime}ms`);
    console.log(`   Input: 0.1 SOL`);
    console.log(`   Output: ${(parseInt(quote1.outAmount) / 1e6).toFixed(2)} USDC`);
    console.log(`   Price impact: ${(quote1.priceImpactPct * 100).toFixed(4)}%`);
  } else {
    console.log(`❌ Quote failed in ${singleTime}ms`);
  }
  console.log();

  // TEST 2: Parallel quotes (3 quotes simultaneously)
  console.log('📊 TEST 2: Parallel Quotes (3 quotes)');
  console.log('─────────────────────────────────────');
  
  const parallelStartTime = Date.now();
  const parallelQuotes = await fastJupiter.getQuotesBatch([
    { inputMint: TOKENS.SOL, outputMint: TOKENS.USDC, amount: 100_000_000 },
    { inputMint: TOKENS.SOL, outputMint: TOKENS.USDT, amount: 100_000_000 },
    { inputMint: TOKENS.SOL, outputMint: TOKENS.JUP, amount: 100_000_000 },
  ]);
  const parallelTime = Date.now() - parallelStartTime;
  
  const successCount = parallelQuotes.filter(q => q !== null).length;
  console.log(`✅ ${successCount}/3 quotes in ${parallelTime}ms`);
  console.log(`   Avg per quote: ${Math.round(parallelTime / 3)}ms`);
  console.log();

  // TEST 3: Cyclic arbitrage simulation (SOL → USDC → USDT → SOL)
  console.log('📊 TEST 3: Cyclic Arbitrage Simulation');
  console.log('─────────────────────────────────────');
  
  const cycleStartTime = Date.now();
  
  try {
    // Hop 1: SOL → USDC
    const hop1Start = Date.now();
    const hop1 = await fastJupiter.getQuote(TOKENS.SOL, TOKENS.USDC, 100_000_000, 50);
    const hop1Time = Date.now() - hop1Start;
    
    if (!hop1) {
      console.log('❌ Hop 1 failed');
      return;
    }
    
    console.log(`✅ Hop 1 (SOL → USDC): ${hop1Time}ms`);
    
    // Hop 2: USDC → USDT
    const hop2Start = Date.now();
    const hop2 = await fastJupiter.getQuote(TOKENS.USDC, TOKENS.USDT, parseInt(hop1.outAmount), 50);
    const hop2Time = Date.now() - hop2Start;
    
    if (!hop2) {
      console.log('❌ Hop 2 failed');
      return;
    }
    
    console.log(`✅ Hop 2 (USDC → USDT): ${hop2Time}ms`);
    
    // Hop 3: USDT → SOL
    const hop3Start = Date.now();
    const hop3 = await fastJupiter.getQuote(TOKENS.USDT, TOKENS.SOL, parseInt(hop2.outAmount), 50);
    const hop3Time = Date.now() - hop3Start;
    
    if (!hop3) {
      console.log('❌ Hop 3 failed');
      return;
    }
    
    console.log(`✅ Hop 3 (USDT → SOL): ${hop3Time}ms`);
    
    const totalCycleTime = Date.now() - cycleStartTime;
    
    // Calculate profit
    const startingSol = 0.1;
    const endingSol = parseInt(hop3.outAmount) / 1e9;
    const grossProfit = endingSol - startingSol;
    const gasCost = 0.0009; // 3 hops × 0.0003 SOL
    const netProfit = grossProfit - gasCost;
    const profitPercent = (netProfit / startingSol) * 100;
    
    console.log();
    console.log('💰 Cycle Results:');
    console.log(`   Starting: ${startingSol.toFixed(4)} SOL`);
    console.log(`   Ending: ${endingSol.toFixed(6)} SOL`);
    console.log(`   Gross profit: ${grossProfit.toFixed(6)} SOL`);
    console.log(`   Gas cost: ${gasCost.toFixed(6)} SOL`);
    console.log(`   Net profit: ${netProfit.toFixed(6)} SOL (${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(4)}%)`);
    console.log(`   Total time: ${totalCycleTime}ms`);
    console.log(`   Avg per hop: ${Math.round(totalCycleTime / 3)}ms`);
    
    if (netProfit > 0) {
      console.log(`\n   🎯 PROFITABLE! (${netProfit.toFixed(6)} SOL)`);
    } else {
      console.log(`\n   ⚠️  Not profitable (${netProfit.toFixed(6)} SOL loss)`);
    }
    
  } catch (error: any) {
    const cycleTime = Date.now() - cycleStartTime;
    console.log(`❌ Cycle failed in ${cycleTime}ms: ${error.message}`);
  }
  
  console.log();

  // TEST 4: Performance metrics
  console.log('📊 TEST 4: Service Performance Metrics');
  console.log('─────────────────────────────────────');
  
  const metrics = fastJupiter.getMetrics();
  console.log(`Total quotes: ${metrics.totalQuotes}`);
  console.log(`Successful: ${metrics.successfulQuotes}`);
  console.log(`Failed: ${metrics.failedQuotes}`);
  console.log(`Success rate: ${metrics.successRate}`);
  console.log(`Avg time: ${Math.round(metrics.avgQuoteTimeMs)}ms`);
  console.log(`Fastest: ${Math.round(metrics.fastestQuoteMs)}ms`);
  console.log(`Slowest: ${Math.round(metrics.slowestQuoteMs)}ms`);
  console.log();

  // TEST 5: Health check
  console.log('📊 TEST 5: Health Check');
  console.log('─────────────────────────────────────');
  
  const health = await fastJupiter.healthCheck();
  console.log(`Status: ${health.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
  console.log(`Latency: ${health.latencyMs}ms`);
  console.log();

  // SUMMARY
  console.log('═══════════════════════════════════════');
  console.log('📊 SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log();
  
  const avgQuoteTime = Math.round(metrics.avgQuoteTimeMs);
  const estimated3HopTime = avgQuoteTime * 3;
  
  console.log(`⏱️  Average quote time: ${avgQuoteTime}ms`);
  console.log(`⏱️  Estimated 3-hop cycle: ${estimated3HopTime}ms`);
  console.log();
  
  if (avgQuoteTime < 500) {
    console.log('✅ EXCELLENT: Quotes under 500ms (competitive for MEV)');
  } else if (avgQuoteTime < 1000) {
    console.log('✅ GOOD: Quotes under 1 second (acceptable for arbitrage)');
  } else if (avgQuoteTime < 2000) {
    console.log('⚠️  SLOW: Quotes over 1 second (may miss opportunities)');
  } else {
    console.log('❌ TOO SLOW: Quotes over 2 seconds (not competitive)');
  }
  
  console.log();
  
  if (estimated3HopTime < 2000) {
    console.log('✅ 3-hop cycles can complete in <2 seconds');
  } else if (estimated3HopTime < 5000) {
    console.log('✅ 3-hop cycles can complete in <5 seconds');
  } else {
    console.log('❌ 3-hop cycles taking >5 seconds (too slow)');
  }
  
  console.log();
  console.log('═══════════════════════════════════════\n');
}

// Run test
testSpeed().catch(console.error);
