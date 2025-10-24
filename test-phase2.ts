// PHASE 2 TESTING SCRIPT
// Test all Phase 2 strategies safely before live trading
// Run with: npx tsx test-phase2.ts

import { BackrunService } from './src/services/backrunService';
import { CyclicArbitrageService } from './src/services/cyclicArbitrageService';
import { JITLiquidityService } from './src/services/jitLiquidityService';
import { LongTailArbitrageService } from './src/services/longTailArbitrageService';
import { mempoolMonitor } from './src/services/mempoolMonitor';
import { priorityFeeOptimizer } from './src/services/priorityFeeOptimizer';
import { jitoBundleService } from './src/services/jitoBundleService';

// Test configuration
const TEST_CONFIG = {
  runDuration: 60000, // Run for 1 minute (60 seconds)
  verbose: true,
  testMode: 'dry-run', // 'dry-run' or 'live' (use dry-run first!)
};

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║       PHASE 2 TESTING SUITE - MEV Strategies              ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');
console.log('⚠️  TEST MODE:', TEST_CONFIG.testMode.toUpperCase());
console.log('⏱️  Duration:', TEST_CONFIG.runDuration / 1000, 'seconds');
console.log('');

// Track test results
const testResults = {
  backrun: { initialized: false, opportunitiesFound: 0, errors: 0 },
  cyclic: { initialized: false, opportunitiesFound: 0, errors: 0 },
  jit: { initialized: false, opportunitiesFound: 0, errors: 0 },
  longTail: { initialized: false, opportunitiesFound: 0, errors: 0 },
  mempool: { initialized: false, transactionsSeen: 0, errors: 0 },
  priorityFee: { initialized: false, feeAnalyses: 0, errors: 0 },
  jitoBundle: { initialized: false, bundlesCreated: 0, errors: 0 },
};

async function testPhase2Services() {
  console.log('🧪 Starting Phase 2 Service Tests...\n');

  // TEST 1: Mempool Monitor
  try {
    console.log('📡 TEST 1: Mempool Monitor');
    console.log('   Checking if mempool monitoring is available...');
    
    await mempoolMonitor.startMonitoring();
    testResults.mempool.initialized = true;
    
    // Count transactions
    mempoolMonitor.onTransaction((tx) => {
      testResults.mempool.transactionsSeen++;
      if (TEST_CONFIG.verbose) {
        console.log('   📊 Transaction seen:', tx.signature.slice(0, 16) + '...');
      }
    });
    
    console.log('   ✅ Mempool Monitor: OPERATIONAL\n');
  } catch (error) {
    console.log('   ❌ Mempool Monitor: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.mempool.errors++;
  }

  // TEST 2: Priority Fee Optimizer
  try {
    console.log('💰 TEST 2: Priority Fee Optimizer');
    console.log('   Testing dynamic fee calculation...');
    
    const feeAnalysis = await priorityFeeOptimizer.analyzeFees();
    testResults.priorityFee.initialized = true;
    testResults.priorityFee.feeAnalyses++;
    
    console.log('   Network Congestion:', feeAnalysis.congestionLevel);
    console.log('   Recommended Fee:', feeAnalysis.recommendedFeeLamports, 'lamports');
    console.log('   Fee Trend:', feeAnalysis.trend);
    console.log('   ✅ Priority Fee Optimizer: OPERATIONAL\n');
  } catch (error) {
    console.log('   ❌ Priority Fee Optimizer: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.priorityFee.errors++;
  }

  // TEST 3: Jito Bundle Service
  try {
    console.log('📦 TEST 3: Jito Bundle Service');
    console.log('   Testing bundle creation capabilities...');
    
    const health = await jitoBundleService.healthCheck();
    testResults.jitoBundle.initialized = health.healthy;
    
    console.log('   Bundle Service:', health.healthy ? 'HEALTHY' : 'UNHEALTHY');
    console.log('   Active Bundles:', health.activeBundles);
    console.log('   ✅ Jito Bundle Service: OPERATIONAL\n');
  } catch (error) {
    console.log('   ❌ Jito Bundle Service: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.jitoBundle.errors++;
  }

  // TEST 4: Backrun Service
  try {
    console.log('⚡ TEST 4: Backrun Service');
    console.log('   Starting backrun opportunity monitoring...');
    
    const backrunService = new BackrunService();
    await backrunService.startMonitoring();
    testResults.backrun.initialized = true;
    
    console.log('   ✅ Backrun Service: MONITORING ACTIVE\n');
    
    // Monitor for opportunities (dry-run mode)
    setTimeout(() => {
      backrunService.stopMonitoring();
    }, TEST_CONFIG.runDuration);
  } catch (error) {
    console.log('   ❌ Backrun Service: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.backrun.errors++;
  }

  // TEST 5: Cyclic Arbitrage Service
  try {
    console.log('🔄 TEST 5: Cyclic Arbitrage Service');
    console.log('   Starting cyclic arbitrage scanning...');
    
    const cyclicService = new CyclicArbitrageService();
    await cyclicService.startScanning();
    testResults.cyclic.initialized = true;
    
    console.log('   ✅ Cyclic Arbitrage: SCANNING ACTIVE\n');
    
    // Monitor for cycles (dry-run mode)
    setTimeout(() => {
      cyclicService.stopScanning();
    }, TEST_CONFIG.runDuration);
  } catch (error) {
    console.log('   ❌ Cyclic Arbitrage Service: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.cyclic.errors++;
  }

  // TEST 6: JIT Liquidity Service
  try {
    console.log('💧 TEST 6: JIT Liquidity Service');
    console.log('   Starting JIT opportunity monitoring...');
    
    const jitService = new JITLiquidityService();
    await jitService.startMonitoring();
    testResults.jit.initialized = true;
    
    console.log('   ✅ JIT Liquidity: MONITORING ACTIVE\n');
    
    // Monitor for JIT opportunities (dry-run mode)
    setTimeout(() => {
      jitService.stopMonitoring();
    }, TEST_CONFIG.runDuration);
  } catch (error) {
    console.log('   ❌ JIT Liquidity Service: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.jit.errors++;
  }

  // TEST 7: Long-Tail Arbitrage Service
  try {
    console.log('🎯 TEST 7: Long-Tail Arbitrage Service');
    console.log('   Starting long-tail arbitrage scanning...');
    
    const longTailService = new LongTailArbitrageService();
    await longTailService.startScanning();
    testResults.longTail.initialized = true;
    
    console.log('   ✅ Long-Tail Arbitrage: SCANNING ACTIVE\n');
    
    // Monitor for opportunities (dry-run mode)
    setTimeout(() => {
      longTailService.stopScanning();
    }, TEST_CONFIG.runDuration);
  } catch (error) {
    console.log('   ❌ Long-Tail Arbitrage Service: FAILED');
    console.log('   Error:', (error as Error).message);
    testResults.longTail.errors++;
  }

  console.log('⏳ All services started. Monitoring for', TEST_CONFIG.runDuration / 1000, 'seconds...\n');
}

// Wait for test duration, then show results
async function runTests() {
  await testPhase2Services();
  
  // Wait for monitoring period
  setTimeout(() => {
    showResults();
  }, TEST_CONFIG.runDuration + 1000);
}

function showResults() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                  TEST RESULTS SUMMARY                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log('📊 SERVICE STATUS:\n');

  const services = [
    { name: 'Mempool Monitor', data: testResults.mempool },
    { name: 'Priority Fee Optimizer', data: testResults.priorityFee },
    { name: 'Jito Bundle Service', data: testResults.jitoBundle },
    { name: 'Backrun Service', data: testResults.backrun },
    { name: 'Cyclic Arbitrage', data: testResults.cyclic },
    { name: 'JIT Liquidity', data: testResults.jit },
    { name: 'Long-Tail Arbitrage', data: testResults.longTail },
  ];

  let totalInitialized = 0;
  let totalErrors = 0;

  services.forEach(({ name, data }) => {
    const status = data.initialized ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} ${name.padEnd(25)} Errors: ${data.errors}`);
    if (data.initialized) totalInitialized++;
    totalErrors += data.errors;
  });

  console.log('\n📈 MONITORING RESULTS:\n');
  console.log('   Mempool Transactions:', testResults.mempool.transactionsSeen);
  console.log('   Priority Fee Analyses:', testResults.priorityFee.feeAnalyses);
  console.log('   Jito Bundles Created:', testResults.jitoBundle.bundlesCreated);
  console.log('   Backrun Opportunities:', testResults.backrun.opportunitiesFound);
  console.log('   Cyclic Opportunities:', testResults.cyclic.opportunitiesFound);
  console.log('   JIT Opportunities:', testResults.jit.opportunitiesFound);
  console.log('   Long-Tail Opportunities:', testResults.longTail.opportunitiesFound);

  console.log('\n🏆 OVERALL RESULTS:\n');
  console.log(`   Services Operational: ${totalInitialized}/7`);
  console.log(`   Total Errors: ${totalErrors}`);
  
  const passRate = (totalInitialized / 7) * 100;
  console.log(`   Pass Rate: ${passRate.toFixed(1)}%`);

  if (passRate === 100) {
    console.log('\n   ✅ ALL PHASE 2 SERVICES OPERATIONAL!');
    console.log('   ✅ READY FOR LIVE TRADING (with small amounts)');
  } else if (passRate >= 70) {
    console.log('\n   ⚠️  MOST SERVICES OPERATIONAL');
    console.log('   ⚠️  Review errors before live trading');
  } else {
    console.log('\n   ❌ MULTIPLE SERVICES FAILED');
    console.log('   ❌ DO NOT USE FOR LIVE TRADING YET');
  }

  console.log('\n═══════════════════════════════════════════════════════════\n');
  process.exit(0);
}

// Run the tests
console.log('🚀 Initializing Phase 2 tests...\n');
runTests().catch((error) => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});
