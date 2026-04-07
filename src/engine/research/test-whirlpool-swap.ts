/**
 * Phase B — Step B2: Orca Whirlpool swap math verification
 *
 * Goal: simulate 0.1 SOL -> mSOL swap using ONLY decoded Whirlpool state
 * (sqrtPrice, liquidity, feeRate from the pool itself) and compare against
 * Jupiter /quote for the same exact-in. Must match within 50 bps.
 *
 * Whirlpool uses identical Uniswap V3 constant-L math as Raydium CLMM.
 * The only differences from Phase A2 are:
 *   1. Layout offsets (see whirlpool-layout.ts)
 *   2. feeRate is read directly from the pool account (offset 45, u16,
 *      hundredths of bps; 3000 = 30 bps = 0.30%). No separate AmmConfig.
 *   3. Mint decimals are NOT stored in the pool — fetch the SPL Mint
 *      account and read byte 44 (decimals u8 in standard Mint layout).
 *   4. Token A/B are sorted lexicographically by mint pubkey, so SOL
 *      may be on either side; pick swap direction at runtime.
 *
 * Single-bracket assumption: 0.1 SOL is small enough that the active
 * liquidity range will not be crossed. We use the same exact-in formulae
 * as A2:
 *
 *   amountInAfterFee = amountIn * (1e6 - feeRate) / 1e6
 *
 *   // tokenA -> tokenB (i.e. price decreases, sqrtP decreases):
 *   sqrtP_new = (L * sqrtP * Q64) / (L * Q64 + amountInAfterFee * sqrtP)
 *   amountOut = L * (sqrtP - sqrtP_new) / Q64
 *
 *   // tokenB -> tokenA (price increases, sqrtP increases):
 *   sqrtP_new = sqrtP + (amountInAfterFee * Q64) / L
 *   amountOut = L * (sqrtP_new - sqrtP) / (sqrtP_new * sqrtP / Q64)
 *
 * Reference: Uniswap V3 whitepaper §6.2.1 / 6.2.2
 *            https://github.com/orca-so/whirlpools (math identical)
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const MSOL_MINT = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
// Candidate mSOL/SOL Whirlpool — verify in B4 against the orca pools list.
const POOL = 'HQcY5n2zP6rW74fyFEhWeBd3LnJpBcZechkvJpmdb8cx';
const AMOUNT_IN_LAMPORTS = 100_000_000n; // 0.1 SOL

const RPC_URLS: string[] = [
  process.env.HELIUS_RPC_URL || '',
  process.env.RPC_URL || '',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

interface AccountValue {
  data: [string, string];
  owner: string;
}

function curlPost(url: string, body: string): string {
  return execSync(
    `curl -s --max-time 10 -X POST -H "Content-Type: application/json" -d '${body}' '${url}'`,
    { encoding: 'utf8' },
  );
}
function curlGet(url: string): string {
  return execSync(`curl -s --max-time 10 '${url}'`, { encoding: 'utf8' });
}

async function fetchAccount(address: string): Promise<AccountValue | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [address, { encoding: 'base64' }],
  });
  for (const rpc of RPC_URLS) {
    try {
      const out = curlPost(rpc, body);
      const json = JSON.parse(out);
      if (json?.result?.value) return json.result.value as AccountValue;
    } catch {
      /* try next */
    }
  }
  return null;
}

function readU16LE(buf: Buffer, off: number): number { return buf.readUInt16LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface Whirlpool {
  feeRate: number;        // hundredths of bps
  liquidity: bigint;
  sqrtPrice: bigint;      // Q64.64
  tokenMintA: string;
  tokenMintB: string;
}

function decodeWhirlpool(data: Buffer): Whirlpool {
  return {
    feeRate:    readU16LE(data, 45),
    liquidity:  readU128LE(data, 49),
    sqrtPrice:  readU128LE(data, 65),
    tokenMintA: readPubkey(data, 101),
    tokenMintB: readPubkey(data, 181),
  };
}

/**
 * SPL Mint account layout: decimals byte is at offset 44.
 * (mint_authority Option<Pubkey> [4+32], supply u64 [8], decimals u8 @ 44)
 */
function decodeMintDecimals(data: Buffer): number {
  return data.readUInt8(44);
}

/**
 * Whirlpool exact-in, tokenA -> tokenB (price decreases).
 */
function swapAToB(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  feeRate: number, // hundredths of bps, 1e6 denom
): { amountOut: bigint; sqrtPNewX64: bigint; amountInAfterFee: bigint } {
  const Q64 = 1n << 64n;
  const FEE_DENOM = 1_000_000n;
  const amountInAfterFee = (amountIn * (FEE_DENOM - BigInt(feeRate))) / FEE_DENOM;
  const numerator = L * sqrtPX64 * Q64;
  const denominator = L * Q64 + amountInAfterFee * sqrtPX64;
  const sqrtPNewX64 = numerator / denominator;
  const amountOut = (L * (sqrtPX64 - sqrtPNewX64)) / Q64;
  return { amountOut, sqrtPNewX64, amountInAfterFee };
}

/**
 * Whirlpool exact-in, tokenB -> tokenA (price increases).
 *
 *   sqrtP_new = sqrtP + (amountInAfterFee << 64) / L
 *   amountOut_A = L * (sqrtP_new - sqrtP) * Q64 / (sqrtP_new * sqrtP)
 */
function swapBToA(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  feeRate: number,
): { amountOut: bigint; sqrtPNewX64: bigint; amountInAfterFee: bigint } {
  const Q64 = 1n << 64n;
  const FEE_DENOM = 1_000_000n;
  const amountInAfterFee = (amountIn * (FEE_DENOM - BigInt(feeRate))) / FEE_DENOM;
  const sqrtPNewX64 = sqrtPX64 + (amountInAfterFee * Q64) / L;
  // amountOut = L * (sqrtP_new - sqrtP) * Q64 / (sqrtP_new * sqrtP)
  const numerator = L * (sqrtPNewX64 - sqrtPX64) * Q64;
  const denominator = sqrtPNewX64 * sqrtPX64;
  const amountOut = numerator / denominator;
  return { amountOut, sqrtPNewX64, amountInAfterFee };
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
}

async function jupiterQuote(): Promise<JupQuote | null> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}` +
    `&outputMint=${MSOL_MINT}&amount=${AMOUNT_IN_LAMPORTS}&slippageBps=50` +
    `&onlyDirectRoutes=true&swapMode=ExactIn`;
  try {
    const out = curlGet(url);
    const json = JSON.parse(out);
    if (json?.outAmount) return json as JupQuote;
    console.error('  Jupiter response had no outAmount:', out.slice(0, 200));
    return null;
  } catch (err) {
    console.error('  Jupiter quote failed:', (err as Error).message);
    return null;
  }
}

async function main(): Promise<void> {
  console.log('=== Phase B2: Whirlpool Swap Math Verification ===');
  console.log(`Pool   : ${POOL}`);
  console.log(`Swap   : ${AMOUNT_IN_LAMPORTS} lamports SOL -> mSOL`);
  console.log('');

  // 1. Fetch pool
  console.log('Step 1: fetch Whirlpool state');
  const poolAcct = await fetchAccount(POOL);
  if (!poolAcct) { console.error('FAIL: pool fetch'); process.exit(1); }
  const poolBuf = Buffer.from(poolAcct.data[0], 'base64');
  const pool = decodeWhirlpool(poolBuf);
  console.log('  tokenMintA :', pool.tokenMintA, pool.tokenMintA === SOL_MINT ? '(SOL)' : pool.tokenMintA === MSOL_MINT ? '(mSOL)' : '');
  console.log('  tokenMintB :', pool.tokenMintB, pool.tokenMintB === SOL_MINT ? '(SOL)' : pool.tokenMintB === MSOL_MINT ? '(mSOL)' : '');
  console.log('  feeRate    :', pool.feeRate, `(= ${(pool.feeRate / 10000).toFixed(4)}%)`);
  console.log('  liquidity  :', pool.liquidity.toString());
  console.log('  sqrtPrice  :', pool.sqrtPrice.toString());

  const solIsA = pool.tokenMintA === SOL_MINT;
  const tokenIsA = pool.tokenMintA === MSOL_MINT;
  if (!solIsA && !tokenIsA) {
    console.error('FAIL: pool does not contain SOL/mSOL pair');
    process.exit(1);
  }
  if (!solIsA && pool.tokenMintB !== SOL_MINT) {
    console.error('FAIL: SOL not present in pool');
    process.exit(1);
  }
  console.log('  -> swap direction:', solIsA ? 'A->B (SOL->mSOL)' : 'B->A (SOL->mSOL)');

  // 2. Fetch mint decimals (Whirlpool does not store decimals in the pool)
  console.log('\nStep 2: fetch SPL Mint decimals');
  const mintAcctA = await fetchAccount(pool.tokenMintA);
  const mintAcctB = await fetchAccount(pool.tokenMintB);
  if (!mintAcctA || !mintAcctB) { console.error('FAIL: mint fetch'); process.exit(1); }
  const decA = decodeMintDecimals(Buffer.from(mintAcctA.data[0], 'base64'));
  const decB = decodeMintDecimals(Buffer.from(mintAcctB.data[0], 'base64'));
  console.log('  decimals A :', decA);
  console.log('  decimals B :', decB);

  // 3. Run swap math
  console.log('\nStep 3: simulate Whirlpool swap (single-bracket assumption)');
  const result = solIsA
    ? swapAToB(pool.liquidity, pool.sqrtPrice, AMOUNT_IN_LAMPORTS, pool.feeRate)
    : swapBToA(pool.liquidity, pool.sqrtPrice, AMOUNT_IN_LAMPORTS, pool.feeRate);
  console.log('  amountInAfterFee :', result.amountInAfterFee.toString(), 'lamports');
  console.log('  sqrtPNewX64      :', result.sqrtPNewX64.toString());
  console.log('  amountOut raw    :', result.amountOut.toString());

  // mSOL is on the side opposite SOL
  const msolDecimals = solIsA ? decB : decA;
  const ourMsolHuman = Number(result.amountOut) / 10 ** msolDecimals;
  console.log(`  amountOut human  : ${ourMsolHuman.toFixed(9)} mSOL`);

  // 4. Jupiter compare
  console.log('\nStep 4: Jupiter /quote (direct routes only)');
  const jup = await jupiterQuote();
  if (!jup) { console.error('FAIL: no Jupiter quote'); process.exit(1); }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** msolDecimals;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  jupiter route ammKey:', route?.ammKey, `(${route?.label})`);
  console.log('  jupiter outAmount   :', jupRaw.toString(), `(${jupHuman.toFixed(9)} mSOL)`);
  if (route && route.ammKey !== POOL) {
    console.log('  WARN: Jupiter routed through a different mSOL/SOL pool than ours.');
    console.log('        Diff may exceed 50 bps purely due to pool divergence.');
  }

  // 5. Diff
  console.log('\nStep 5: comparison');
  const diff = ourMsolHuman - jupHuman;
  const diffBps = (diff / jupHuman) * 10000;
  console.log(`  ours    : ${ourMsolHuman.toFixed(9)} mSOL`);
  console.log(`  jupiter : ${jupHuman.toFixed(9)} mSOL`);
  console.log(`  diff    : ${diff.toFixed(9)} mSOL (${diffBps.toFixed(2)} bps)`);

  if (Math.abs(diffBps) <= 50) {
    console.log('\nPASS: within 50 bps. Whirlpool math verified.');
  } else {
    console.log('\nFAIL: > 50 bps. Investigate before B3.');
    console.log('  - Confirm same pool ammKey above');
    console.log('  - Check sort order of A/B and direction selection');
    console.log('  - Confirm feeRate read from offset 45 (u16, hundredths of bps)');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
