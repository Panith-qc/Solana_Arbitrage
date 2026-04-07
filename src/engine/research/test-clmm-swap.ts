/**
 * Phase A — Step A2: Raydium CLMM swap math verification
 *
 * Goal: simulate 0.01 SOL -> RAY swap using ONLY decoded pool state
 * (sqrtPriceX64, liquidity, fee from ammConfig) and compare against
 * Jupiter /quote for the same exact-in amount. Must match within 50 bps.
 *
 * Approximation used here (single-tick / current-liquidity assumption):
 *   For a tiny swap (0.01 SOL) the price impact is small enough that the
 *   active liquidity bracket does not change. Under that assumption the
 *   constant-liquidity CLMM math gives:
 *
 *     amountInAfterFee = amountIn * (1 - feeRate)
 *     // token0 -> token1 (we are swapping SOL=token0 -> RAY=token1):
 *     // sqrtP_new = (L * sqrtP) / (L + amountInAfterFee * sqrtP / 2^64)
 *     // amountOut = L * (sqrtP - sqrtP_new) / 2^64
 *
 *   Reference: Uniswap V3 whitepaper §6.2.2, Raydium CLMM uses identical math
 *   (https://github.com/raydium-io/raydium-clmm/blob/master/programs/amm/src/libraries/swap_math.rs)
 *
 * Worked example (RAY/SOL CLMM, mainnet snapshot from A1):
 *   L            = 32_849_857_801_310
 *   sqrtPriceX64 = 6_702_168_938_850_234_244
 *   priceRaw (RAY/SOL raw units) ≈ (sqrtP/2^64)^2 = 0.007806
 *   With dec adj 10^(9-6)=10^3 -> RAY-per-SOL ≈ 7.806 RAY/SOL... wait
 *   that's wrong. Actually SOL/RAY ≈ 0.00757 (verified A1), so RAY/SOL ≈ 132.
 *   For 0.01 SOL we expect ~1.32 RAY out, minus fee.
 *
 * Fee: read ammConfig.tradeFeeRate (u32, denominated in 1e6 -> 2500 = 25 bps).
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RAY_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const POOL = '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2';
const AMOUNT_IN_LAMPORTS = 10_000_000n; // 0.01 SOL

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
    { encoding: 'utf8' }
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

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU32LE(buf: Buffer, off: number): number { return buf.readUInt32LE(off); }
function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface PoolDecoded {
  ammConfig: string;
  tokenMint0: string;
  tokenMint1: string;
  mintDecimals0: number;
  mintDecimals1: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
}

function decodePool(data: Buffer): PoolDecoded {
  return {
    ammConfig: readPubkey(data, 9),
    tokenMint0: readPubkey(data, 73),
    tokenMint1: readPubkey(data, 105),
    mintDecimals0: readU8(data, 233),
    mintDecimals1: readU8(data, 234),
    liquidity: readU128LE(data, 237),
    sqrtPriceX64: readU128LE(data, 253),
  };
}

/**
 * Decode Raydium AmmConfig (Anchor account) — we only need tradeFeeRate.
 * Layout (after 8-byte discriminator):
 *   bump            u8           offset  8
 *   index           u16          offset  9
 *   owner           Pubkey       offset 11
 *   protocolFeeRate u32          offset 43
 *   tradeFeeRate    u32          offset 47   <-- this one (1e6 denom)
 *   tickSpacing     u16          offset 51
 *   ...
 */
function decodeAmmConfigTradeFee(data: Buffer): { tradeFeeRate: number; feeBps: number } {
  const tradeFeeRate = readU32LE(data, 47);
  // tradeFeeRate is denominated in 1e6. 2500 = 0.0025 = 25 bps.
  const feeBps = tradeFeeRate / 100;
  return { tradeFeeRate, feeBps };
}

/**
 * CLMM exact-in swap, token0 -> token1, single active liquidity bracket.
 *
 * Worked example with mainnet snapshot:
 *   L = 32849857801310
 *   sqrtP = 6702168938850234244
 *   amountIn = 10_000_000 (0.01 SOL)
 *   feeRate = 0.0025
 *   amountInAfterFee = 9_975_000
 *   sqrtP_new = (L * sqrtP) / (L + amountInAfterFee * sqrtP / 2^64)
 *   amountOut = L * (sqrtP - sqrtP_new) / 2^64
 *   With decimals (RAY=6) -> divide by 1e6 for human RAY.
 */
function clmmSwapToken0For1(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  tradeFeeRate1e6: number
): { amountOut: bigint; sqrtPNewX64: bigint; amountInAfterFee: bigint } {
  const Q64 = 1n << 64n;
  const FEE_DENOM = 1_000_000n;
  const feeNum = BigInt(tradeFeeRate1e6);
  const amountInAfterFee = (amountIn * (FEE_DENOM - feeNum)) / FEE_DENOM;

  // sqrtP_new = (L * sqrtP) / (L + amountInAfterFee * sqrtP / Q64)
  // To preserve precision: sqrtP_new = (L * sqrtP * Q64) / (L * Q64 + amountInAfterFee * sqrtP)
  const numerator = L * sqrtPX64 * Q64;
  const denominator = L * Q64 + amountInAfterFee * sqrtPX64;
  const sqrtPNewX64 = numerator / denominator;

  // amountOut = L * (sqrtP - sqrtP_new) / Q64
  const amountOut = (L * (sqrtPX64 - sqrtPNewX64)) / Q64;

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
    `&outputMint=${RAY_MINT}&amount=${AMOUNT_IN_LAMPORTS}&slippageBps=50` +
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
  console.log('=== Phase A2: CLMM Swap Math Verification ===');
  console.log(`Pool: ${POOL}`);
  console.log(`Swap: ${AMOUNT_IN_LAMPORTS} lamports SOL -> RAY`);
  console.log('');

  // 1. Fetch pool
  console.log('Step 1: fetch pool state');
  const poolAcct = await fetchAccount(POOL);
  if (!poolAcct) { console.error('FAIL: pool fetch'); process.exit(1); }
  const poolBuf = Buffer.from(poolAcct.data[0], 'base64');
  const pool = decodePool(poolBuf);
  console.log('  ammConfig    :', pool.ammConfig);
  console.log('  tokenMint0   :', pool.tokenMint0, pool.tokenMint0 === SOL_MINT ? '(SOL)' : '');
  console.log('  tokenMint1   :', pool.tokenMint1, pool.tokenMint1 === RAY_MINT ? '(RAY)' : '');
  console.log('  decimals     :', pool.mintDecimals0, '/', pool.mintDecimals1);
  console.log('  liquidity    :', pool.liquidity.toString());
  console.log('  sqrtPriceX64 :', pool.sqrtPriceX64.toString());

  if (pool.tokenMint0 !== SOL_MINT || pool.tokenMint1 !== RAY_MINT) {
    console.error('FAIL: this script assumes mint0=SOL, mint1=RAY for this pool');
    process.exit(1);
  }

  // 2. Fetch ammConfig for fee
  console.log('\nStep 2: fetch ammConfig for fee rate');
  const cfgAcct = await fetchAccount(pool.ammConfig);
  if (!cfgAcct) { console.error('FAIL: ammConfig fetch'); process.exit(1); }
  const cfgBuf = Buffer.from(cfgAcct.data[0], 'base64');
  const { tradeFeeRate, feeBps } = decodeAmmConfigTradeFee(cfgBuf);
  console.log('  tradeFeeRate (1e6 denom):', tradeFeeRate);
  console.log('  feeBps                  :', feeBps);

  // 3. Run CLMM math
  console.log('\nStep 3: simulate CLMM swap (single-bracket assumption)');
  const { amountOut, sqrtPNewX64, amountInAfterFee } = clmmSwapToken0For1(
    pool.liquidity,
    pool.sqrtPriceX64,
    AMOUNT_IN_LAMPORTS,
    tradeFeeRate
  );
  console.log('  amountInAfterFee :', amountInAfterFee.toString(), 'lamports');
  console.log('  sqrtPNewX64      :', sqrtPNewX64.toString());
  console.log('  amountOut        :', amountOut.toString(), 'raw RAY units');
  const ourRayHuman = Number(amountOut) / 10 ** pool.mintDecimals1;
  console.log(`  amountOut human  : ${ourRayHuman.toFixed(8)} RAY`);

  // 4. Jupiter compare
  console.log('\nStep 4: Jupiter /quote (direct routes only)');
  const jup = await jupiterQuote();
  if (!jup) {
    console.error('FAIL: no Jupiter quote');
    process.exit(1);
  }
  const jupOutRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupOutRaw) / 10 ** pool.mintDecimals1;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  jupiter route ammKey:', route?.ammKey, '(' + route?.label + ')');
  console.log('  jupiter outAmount   :', jupOutRaw.toString(), `(${jupHuman.toFixed(8)} RAY)`);

  // 5. Diff
  console.log('\nStep 5: comparison');
  const diff = ourRayHuman - jupHuman;
  const diffBps = (diff / jupHuman) * 10000;
  console.log(`  ours    : ${ourRayHuman.toFixed(8)} RAY`);
  console.log(`  jupiter : ${jupHuman.toFixed(8)} RAY`);
  console.log(`  diff    : ${diff.toFixed(8)} RAY (${diffBps.toFixed(2)} bps)`);

  if (Math.abs(diffBps) <= 50) {
    console.log('\nPASS: within 50 bps. CLMM math verified.');
  } else {
    console.log('\nFAIL: > 50 bps. Investigate before A3.');
    console.log('  Note: Jupiter may have routed through a different RAY/SOL pool.');
    console.log('  Compare ammKey above to our pool address to confirm same pool.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
