/**
 * Diagnostic: verify config wiring, token decimals, pool registry,
 * and the corrected OpenBook Serum V3 market layout offsets.
 *
 * Run:  npx tsx src/engine/research/test-wiring.ts
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import {
  TOKEN_DECIMALS,
  ALL_POOL_REGISTRY,
  SOL_MINT,
} from '../config.js';

// ── 1. TOKEN_DECIMALS count ────────────────────────────────────────────────
const decCount = Object.keys(TOKEN_DECIMALS).length;
console.log(`\n1. TOKEN_DECIMALS entries: ${decCount} (expect 23)`);
console.log(`   ${decCount === 23 ? '✓ PASS' : '✗ FAIL'}`);

// ── 2. Unique token mints in ALL_POOL_REGISTRY ────────────────────────────
const uniqueMints = new Set(ALL_POOL_REGISTRY.map(p => p.tokenMint));
console.log(`\n2. ALL_POOL_REGISTRY: ${ALL_POOL_REGISTRY.length} pools, ${uniqueMints.size} unique token mints`);
console.log(`   ${uniqueMints.size >= 8 ? '✓ PASS' : '✗ FAIL'} (expect 8+)`);

// ── 3. Pools per token ────────────────────────────────────────────────────
const byToken = new Map<string, { symbol: string; count: number; types: string[] }>();
for (const p of ALL_POOL_REGISTRY) {
  const entry = byToken.get(p.tokenMint) ?? { symbol: p.tokenSymbol, count: 0, types: [] };
  entry.count++;
  entry.types.push(p.poolType);
  byToken.set(p.tokenMint, entry);
}
console.log('\n3. Pools per token:');
for (const [mint, info] of [...byToken.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const decOk = TOKEN_DECIMALS[mint] !== undefined;
  console.log(`   ${info.symbol.padEnd(8)} ${String(info.count).padStart(2)} pools  decimals=${TOKEN_DECIMALS[mint] ?? '??'}  ${decOk ? '✓' : '✗ MISSING'}  [${info.types.join(', ')}]`);
}

// Check every registry token has decimals
const missingDec = [...uniqueMints].filter(m => TOKEN_DECIMALS[m] === undefined);
if (missingDec.length > 0) {
  console.log(`\n   ✗ ${missingDec.length} token(s) missing from TOKEN_DECIMALS:`);
  for (const m of missingDec) console.log(`     ${m}`);
} else {
  console.log(`\n   ✓ All ${uniqueMints.size} registry tokens have decimals`);
}

// ── 4. OpenBook market layout: verify PDA derivation ──────────────────────
// Use the SOL/RAY AMM V4 pool (AVs9TA4n...) to test the corrected offsets.
const RAY_AMM_POOL = 'AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA';
const RAYDIUM_AMM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Corrected Serum V3 offsets
const MARKET_LAYOUT = {
  VAULT_SIGNER_NONCE: 45,
  BASE_VAULT: 117,
  QUOTE_VAULT: 165,
  EVENT_QUEUE: 253,
  BIDS: 285,
  ASKS: 317,
} as const;

// AMM V4 layout offsets for reading marketId + marketProgramId
const AMM_MARKET_ID_OFFSET = 528;
const AMM_MARKET_PROGRAM_ID_OFFSET = 560;

// ── RPC helper (curl-based, no Connection needed) ─────────────────────────
const RPC_URL = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

function rpcGetAccountBase64(address: string): Buffer | null {
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64' }],
    }).replace(/'/g, "'\\''");
    const raw = execSync(
      `curl -sX POST -H 'Content-Type: application/json' -d '${body}' --max-time 15 '${RPC_URL}'`,
      { encoding: 'utf8' },
    );
    const resp = JSON.parse(raw);
    const b64 = resp?.result?.value?.data?.[0];
    if (!b64) return null;
    return Buffer.from(b64, 'base64');
  } catch { return null; }
}

async function testMarketLayout(): Promise<void> {
  console.log(`\n4. OpenBook market layout test (pool: RAY/SOL AMM ${RAY_AMM_POOL.slice(0, 8)}...)`);
  console.log(`   RPC: ${RPC_URL.replace(/apikey.*/, 'apikey=***')}`);

  // Step A: fetch AMM account → read marketId + marketProgramId
  const ammData = rpcGetAccountBase64(RAY_AMM_POOL);
  if (!ammData || ammData.length < 752) {
    console.log(`   ✗ FAIL — could not fetch AMM account (got ${ammData?.length ?? 0} bytes)`);
    return;
  }
  const marketId = new PublicKey(ammData.subarray(AMM_MARKET_ID_OFFSET, AMM_MARKET_ID_OFFSET + 32));
  const marketProgramId = new PublicKey(ammData.subarray(AMM_MARKET_PROGRAM_ID_OFFSET, AMM_MARKET_PROGRAM_ID_OFFSET + 32));
  console.log(`   marketId:        ${marketId.toString()}`);
  console.log(`   marketProgramId: ${marketProgramId.toString()}`);

  // Step B: fetch market account → read fields at corrected offsets
  const mktData = rpcGetAccountBase64(marketId.toString());
  if (!mktData || mktData.length < 350) {
    console.log(`   ✗ FAIL — could not fetch market account (got ${mktData?.length ?? 0} bytes)`);
    return;
  }

  const vaultSignerNonce = mktData.readBigUInt64LE(MARKET_LAYOUT.VAULT_SIGNER_NONCE);
  const baseVault = new PublicKey(mktData.subarray(MARKET_LAYOUT.BASE_VAULT, MARKET_LAYOUT.BASE_VAULT + 32));
  const quoteVault = new PublicKey(mktData.subarray(MARKET_LAYOUT.QUOTE_VAULT, MARKET_LAYOUT.QUOTE_VAULT + 32));
  const eventQueue = new PublicKey(mktData.subarray(MARKET_LAYOUT.EVENT_QUEUE, MARKET_LAYOUT.EVENT_QUEUE + 32));
  const bids = new PublicKey(mktData.subarray(MARKET_LAYOUT.BIDS, MARKET_LAYOUT.BIDS + 32));
  const asks = new PublicKey(mktData.subarray(MARKET_LAYOUT.ASKS, MARKET_LAYOUT.ASKS + 32));

  console.log(`   vaultSignerNonce: ${vaultSignerNonce}`);
  console.log(`   baseVault:   ${baseVault.toString()}`);
  console.log(`   quoteVault:  ${quoteVault.toString()}`);
  console.log(`   eventQueue:  ${eventQueue.toString()}`);
  console.log(`   bids:        ${bids.toString()}`);
  console.log(`   asks:        ${asks.toString()}`);

  // Step C: derive vault signer PDA — must NOT throw "Invalid seeds"
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(vaultSignerNonce);
  try {
    const vaultSigner = await PublicKey.createProgramAddress(
      [marketId.toBuffer(), nonceBuffer],
      marketProgramId,
    );
    console.log(`   vaultSigner: ${vaultSigner.toString()}`);
    console.log('   ✓ PASS — PDA derived successfully (address falls off the curve)');
  } catch (err: any) {
    console.log(`   ✗ FAIL — PDA derivation error: ${err.message}`);
  }

  // Step D: sanity check — vault accounts should be real SPL Token accounts
  const baseVaultData = rpcGetAccountBase64(baseVault.toString());
  const quoteVaultData = rpcGetAccountBase64(quoteVault.toString());
  const baseOk = baseVaultData !== null && baseVaultData.length >= 72;
  const quoteOk = quoteVaultData !== null && quoteVaultData.length >= 72;
  console.log(`   baseVault exists:  ${baseOk ? '✓' : '✗'} (${baseVaultData?.length ?? 0} bytes)`);
  console.log(`   quoteVault exists: ${quoteOk ? '✓' : '✗'} (${quoteVaultData?.length ?? 0} bytes)`);
}

testMarketLayout().then(() => {
  console.log('\n— done —\n');
}).catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
