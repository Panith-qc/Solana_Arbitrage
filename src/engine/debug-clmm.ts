/**
 * Debug script: compare CLMM vs AMM V4 price for RAY/SOL
 * Run: npx tsx src/engine/debug-clmm.ts
 */
import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// RAY pool addresses from config.ts
const RAY_CLMM = '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2';
const RAY_AMM  = 'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Raydium AMM V4 layout offsets
const AMM_BASE_VAULT_OFFSET = 336;
const AMM_QUOTE_VAULT_OFFSET = 368;
const AMM_BASE_PNL_OFFSET = 192;
const AMM_QUOTE_PNL_OFFSET = 200;
const SPL_TOKEN_AMOUNT_OFFSET = 64;

// Raydium CLMM layout offsets
const CLMM_MINT0_OFFSET = 73;
const CLMM_MINT1_OFFSET = 105;
const CLMM_DEC0_OFFSET = 233;
const CLMM_DEC1_OFFSET = 234;
const CLMM_SQRT_PRICE_OFFSET = 253;

async function rpcCall(method: string, params: any[]): Promise<any> {
  const { execSync } = await import('child_process');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const escaped = body.replace(/'/g, "'\\''");
  const cmd = `curl -s --max-time 25 -X POST "${RPC_URL}" -H "Content-Type: application/json" -d '${escaped}'`;
  const raw = execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const json = JSON.parse(raw);
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getAccountData(address: string): Promise<Buffer> {
  const result = await rpcCall('getAccountInfo', [address, { encoding: 'base64' }]);
  if (!result.value) throw new Error(`Account not found: ${address}`);
  return Buffer.from(result.value.data[0], 'base64');
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  RAY/SOL CLMM vs AMM V4 Price Debug');
  console.log('═══════════════════════════════════════════════\n');

  // ── STEP 1: Fetch RAY/SOL CLMM account ──────────────────
  console.log('1. Fetching RAY/SOL CLMM account...');
  const clmmData = await getAccountData(RAY_CLMM);
  console.log(`   Account data length: ${clmmData.length} bytes\n`);

  // ── STEP 2: Read sqrtPriceX64 raw bytes ──────────────────
  console.log('2. sqrtPriceX64 raw bytes (offset 253-268):');
  const sqrtBytes = clmmData.subarray(CLMM_SQRT_PRICE_OFFSET, CLMM_SQRT_PRICE_OFFSET + 16);
  console.log(`   hex: ${sqrtBytes.toString('hex')}`);

  const lo = clmmData.readBigUInt64LE(CLMM_SQRT_PRICE_OFFSET);
  const hi = clmmData.readBigUInt64LE(CLMM_SQRT_PRICE_OFFSET + 8);
  const sqrtPriceX64 = (hi << 64n) | lo;
  console.log(`   lo: ${lo}`);
  console.log(`   hi: ${hi}`);
  console.log(`   sqrtPriceX64: ${sqrtPriceX64}\n`);

  // ── STEP 3: Read mint0 and mint1 ────────────────────────
  console.log('3. Token mints:');
  const mint0 = new PublicKey(clmmData.subarray(CLMM_MINT0_OFFSET, CLMM_MINT0_OFFSET + 32));
  const mint1 = new PublicKey(clmmData.subarray(CLMM_MINT1_OFFSET, CLMM_MINT1_OFFSET + 32));
  console.log(`   mint0: ${mint0.toString()}`);
  console.log(`   mint1: ${mint1.toString()}`);
  const mint0IsSol = mint0.toString() === SOL_MINT;
  console.log(`   mint0 is SOL: ${mint0IsSol}\n`);

  // ── STEP 4: Read decimals ───────────────────────────────
  console.log('4. Decimals:');
  const dec0 = clmmData[CLMM_DEC0_OFFSET];
  const dec1 = clmmData[CLMM_DEC1_OFFSET];
  console.log(`   dec0 (offset ${CLMM_DEC0_OFFSET}): ${dec0}`);
  console.log(`   dec1 (offset ${CLMM_DEC1_OFFSET}): ${dec1}`);
  console.log(`   dec0 - dec1: ${dec0 - dec1}\n`);

  // ── STEP 5: Calculate CLMM price ───────────────────────
  console.log('5. CLMM price calculation:');
  const sqrtPrice = Number(sqrtPriceX64) / (2 ** 64);
  console.log(`   sqrtPrice = sqrtPriceX64 / 2^64 = ${sqrtPrice}`);

  const rawPrice = sqrtPrice * sqrtPrice;
  console.log(`   rawPrice = sqrtPrice^2 = ${rawPrice}`);

  const adjPrice = rawPrice * (10 ** (dec0 - dec1));
  console.log(`   adjPrice = rawPrice * 10^(${dec0}-${dec1}) = ${adjPrice}`);
  console.log(`   adjPrice meaning: how many mint1_human per 1 mint0_human`);

  let solPerToken: number;
  if (mint0IsSol) {
    // mint0=SOL, mint1=RAY → adjPrice = RAY per SOL → invert
    solPerToken = adjPrice > 0 ? 1 / adjPrice : 0;
    console.log(`   mint0=SOL → adjPrice = RAY_per_SOL = ${adjPrice}`);
    console.log(`   solPerToken = 1/adjPrice = ${solPerToken}`);
  } else {
    // mint0=RAY, mint1=SOL → adjPrice = SOL per RAY → use directly
    solPerToken = adjPrice;
    console.log(`   mint0=RAY → adjPrice = SOL_per_RAY = ${adjPrice}`);
    console.log(`   solPerToken = adjPrice = ${solPerToken}`);
  }
  console.log(`\n   *** CLMM SOL per RAY: ${solPerToken} ***\n`);

  // ── STEP 6: Fetch RAY/SOL AMM V4 account + vaults ──────
  console.log('6. Fetching RAY/SOL AMM V4 account...');
  const ammData = await getAccountData(RAY_AMM);
  console.log(`   AMM data length: ${ammData.length} bytes`);

  const baseVault = new PublicKey(ammData.subarray(AMM_BASE_VAULT_OFFSET, AMM_BASE_VAULT_OFFSET + 32));
  const quoteVault = new PublicKey(ammData.subarray(AMM_QUOTE_VAULT_OFFSET, AMM_QUOTE_VAULT_OFFSET + 32));
  console.log(`   baseVault: ${baseVault.toString()}`);
  console.log(`   quoteVault: ${quoteVault.toString()}`);

  const basePnl = ammData.readBigUInt64LE(AMM_BASE_PNL_OFFSET);
  const quotePnl = ammData.readBigUInt64LE(AMM_QUOTE_PNL_OFFSET);
  console.log(`   basePnl: ${basePnl}`);
  console.log(`   quotePnl: ${quotePnl}\n`);

  console.log('   Fetching vault token accounts...');
  const [baseVaultData, quoteVaultData] = await Promise.all([
    getAccountData(baseVault.toString()),
    getAccountData(quoteVault.toString()),
  ]);

  const baseReserve = baseVaultData.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
  const quoteReserve = quoteVaultData.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
  console.log(`   baseReserve (RAY raw): ${baseReserve}`);
  console.log(`   quoteReserve (SOL raw): ${quoteReserve}`);

  const effectiveBase = baseReserve > basePnl ? baseReserve - basePnl : 0n;
  const effectiveQuote = quoteReserve > quotePnl ? quoteReserve - quotePnl : 0n;
  console.log(`   effectiveBase (RAY): ${effectiveBase}`);
  console.log(`   effectiveQuote (SOL): ${effectiveQuote}`);

  // AMM V4: base = RAY (6 decimals), quote = SOL (9 decimals)
  // price (SOL per RAY) = (quoteReserve / 10^9) / (baseReserve / 10^6)
  const RAY_DECIMALS = 6;
  const SOL_DECIMALS = 9;
  const baseFloat = Number(effectiveBase) / (10 ** RAY_DECIMALS);
  const quoteFloat = Number(effectiveQuote) / (10 ** SOL_DECIMALS);
  const ammSolPerToken = quoteFloat / baseFloat;
  console.log(`   baseFloat (RAY human): ${baseFloat}`);
  console.log(`   quoteFloat (SOL human): ${quoteFloat}`);
  console.log(`\n   *** AMM V4 SOL per RAY: ${ammSolPerToken} ***\n`);

  // ── STEP 7: Compare ────────────────────────────────────
  console.log('═══════════════════════════════════════════════');
  console.log('  COMPARISON');
  console.log('═══════════════════════════════════════════════');
  console.log(`  CLMM  SOL/RAY: ${solPerToken.toFixed(10)}`);
  console.log(`  AMM   SOL/RAY: ${ammSolPerToken.toFixed(10)}`);

  const spreadBps = Math.abs(solPerToken - ammSolPerToken) / Math.min(solPerToken, ammSolPerToken) * 10000;
  console.log(`  Spread:        ${spreadBps.toFixed(2)} bps`);

  if (spreadBps <= 10) {
    console.log(`\n  ✅ PASS — prices match within 10 bps\n`);
  } else {
    console.log(`\n  ❌ FAIL — spread ${spreadBps.toFixed(2)} bps > 10 bps threshold`);
    console.log(`  The CLMM formula is WRONG. Debug values above.\n`);
  }

  // ── STEP 8: Also test what poolMonitor.calculatePrice would return ──
  console.log('═══════════════════════════════════════════════');
  console.log('  poolMonitor.calculatePrice() simulation');
  console.log('═══════════════════════════════════════════════');

  // CLMM pseudo-reserves as stored by parseClmmPoolData
  const SCALE = 1_000_000_000n;
  const clmmReserveA = BigInt(Math.round(solPerToken * 1e9)); // SOL_per_token * 1e9
  const clmmReserveB = SCALE;
  console.log(`  CLMM reserveA: ${clmmReserveA} (solPerToken * 1e9)`);
  console.log(`  CLMM reserveB: ${clmmReserveB} (1e9 sentinel)`);
  const clmmCalcPrice = Number(clmmReserveA) / Number(clmmReserveB);
  console.log(`  CLMM calculatePrice = reserveA/reserveB = ${clmmCalcPrice}`);

  // AMM V4 reserves as stored by handleVaultChange
  console.log(`  AMM  reserveA: ${effectiveBase} (token = base)`);
  console.log(`  AMM  reserveB: ${effectiveQuote} (SOL = quote)`);
  // OLD code: reserveA/reserveB = token_raw/SOL_raw (no decimals — WRONG)
  const ammCalcOld = Number(effectiveBase) / Number(effectiveQuote);
  console.log(`  AMM  OLD calculatePrice = reserveA/reserveB = ${ammCalcOld} (raw token/raw SOL — WRONG)`);

  // NEW code: decimal-adjusted (reserveB/1e9) / (reserveA/10^tokenDec)
  const ammTokenFloat = Number(effectiveBase) / (10 ** RAY_DECIMALS);
  const ammSolFloat = Number(effectiveQuote) / 1e9;
  const ammCalcNew = ammSolFloat / ammTokenFloat;
  console.log(`  AMM  NEW calculatePrice = (${ammSolFloat.toFixed(4)} SOL) / (${ammTokenFloat.toFixed(4)} RAY) = ${ammCalcNew} (SOL/token — CORRECT)`);

  const oldSpread = Math.abs(clmmCalcPrice - ammCalcOld) / Math.min(clmmCalcPrice, ammCalcOld) * 10000;
  const newSpread = Math.abs(clmmCalcPrice - ammCalcNew) / Math.min(clmmCalcPrice, ammCalcNew) * 10000;
  console.log(`\n  OLD spread (CLMM vs AMM): ${oldSpread.toFixed(0)} bps — this is what caused 155776 bps`);
  console.log(`  NEW spread (CLMM vs AMM): ${newSpread.toFixed(2)} bps`);

  if (newSpread <= 50) {
    console.log(`\n  ✅ NEW calculatePrice PASSES — ${newSpread.toFixed(2)} bps (within normal DEX spread)\n`);
  } else {
    console.log(`\n  ❌ NEW calculatePrice FAILS — ${newSpread.toFixed(2)} bps > 50 bps\n`);
  }
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
