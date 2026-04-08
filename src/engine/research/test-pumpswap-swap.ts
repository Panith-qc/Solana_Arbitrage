/**
 * Phase E — Step E2: PumpSwap AMM swap math verification
 *
 * Goal: simulate 0.1 SOL -> token swap using ONLY decoded PumpSwap Pool
 * state (vault balances + fee bps from GlobalConfig) and compare against
 * Jupiter /quote for the same exact-in. Must match within 50 bps.
 *
 * PumpSwap is constant-product (x*y=k), fee applied on input:
 *
 *   amountInAfterFee = amountIn * (10_000 - feeBps) / 10_000
 *   amountOut        = (amountInAfterFee * reserveOut)
 *                       / (reserveIn + amountInAfterFee)
 *
 * Reserves come from pool_base_token_account / pool_quote_token_account
 * SPL Token accounts (not from the pool itself). No PnL/fund-fee
 * subtraction — unlike CPMM, PumpSwap doesn't carry pending fees inside
 * the pool state.
 *
 * Resolve the pool address automatically by asking Jupiter for a direct
 * route on a known pump.fun-graduated token (default BONK).
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const AMOUNT_IN_LAMPORTS = 100_000_000n; // 0.1 SOL

// Default target token — BONK. Override via TOKEN env or POOL env.
const DEFAULT_TOKEN_MINT =
  process.env.TOKEN || 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

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

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface PumpPool {
  baseMint: string;
  quoteMint: string;
  poolBaseVault: string;
  poolQuoteVault: string;
}

function decodePool(data: Buffer): PumpPool {
  return {
    baseMint:       readPubkey(data, 43),
    quoteMint:      readPubkey(data, 75),
    poolBaseVault:  readPubkey(data, 139),
    poolQuoteVault: readPubkey(data, 171),
  };
}

function decodeTokenAmountAndMint(data: Buffer): { amount: bigint; mint: string } {
  // SPL Token account: mint at off 0 (32 bytes), amount at off 64 (u64 LE)
  return { mint: readPubkey(data, 0), amount: readU64LE(data, 64) };
}

function decodeMintDecimals(data: Buffer): number {
  // SPL Mint account layout: decimals at offset 44 (u8).
  return readU8(data, 44);
}

function cpSwapExactIn(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const DENOM = 10_000n;
  const amountInAfterFee = (amountIn * (DENOM - feeBps)) / DENOM;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

interface JupQuote {
  outAmount: string;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
}

async function jupiterQuote(outputMint: string): Promise<JupQuote | null> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}` +
    `&outputMint=${outputMint}&amount=${AMOUNT_IN_LAMPORTS}&slippageBps=50` +
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

async function resolvePumpSwapPool(mint: string): Promise<string | null> {
  const q = await jupiterQuote(mint);
  if (!q) return null;
  for (const r of q.routePlan) {
    const label = (r.swapInfo?.label || '').toLowerCase();
    if (label.includes('pump')) return r.swapInfo.ammKey;
  }
  return null;
}

async function main(): Promise<void> {
  console.log('=== Phase E2: PumpSwap Swap Math Verification ===');
  console.log('Token mint :', DEFAULT_TOKEN_MINT);
  console.log(`Swap       : ${AMOUNT_IN_LAMPORTS} lamports SOL -> token`);
  console.log('');

  // 1. Resolve pool address (either POOL env or via Jupiter).
  let poolAddress = process.env.POOL || null;
  if (!poolAddress) {
    console.log('Step 1: resolve PumpSwap pool via Jupiter direct route');
    poolAddress = await resolvePumpSwapPool(DEFAULT_TOKEN_MINT);
    if (!poolAddress) {
      console.error('FAIL: no PumpSwap route found for token. Try a different TOKEN.');
      process.exit(1);
    }
    console.log('  pool :', poolAddress);
  } else {
    console.log('Step 1: using POOL env =', poolAddress);
  }

  // 2. Fetch + decode the pool account.
  console.log('\nStep 2: fetch PumpSwap pool state');
  const poolAcct = await fetchAccount(poolAddress);
  if (!poolAcct) { console.error('FAIL: pool fetch'); process.exit(1); }
  if (poolAcct.owner !== PUMPSWAP_PROGRAM) {
    console.error(
      `FAIL: pool owner ${poolAcct.owner} != ${PUMPSWAP_PROGRAM}. Not a PumpSwap pool.`,
    );
    process.exit(1);
  }
  const poolBuf = Buffer.from(poolAcct.data[0], 'base64');
  const pool = decodePool(poolBuf);
  console.log('  base_mint        :', pool.baseMint);
  console.log('  quote_mint       :', pool.quoteMint, pool.quoteMint === SOL_MINT ? '(SOL)' : '');
  console.log('  pool_base_vault  :', pool.poolBaseVault);
  console.log('  pool_quote_vault :', pool.poolQuoteVault);

  if (pool.quoteMint !== SOL_MINT) {
    console.error('FAIL: PumpSwap pool does not have SOL as quote mint.');
    process.exit(1);
  }

  // 3. Fetch vault balances.
  console.log('\nStep 3: fetch vault balances');
  const [bv, qv] = await Promise.all([
    fetchAccount(pool.poolBaseVault),
    fetchAccount(pool.poolQuoteVault),
  ]);
  if (!bv || !qv) { console.error('FAIL: vault fetch'); process.exit(1); }
  const baseRaw = decodeTokenAmountAndMint(Buffer.from(bv.data[0], 'base64')).amount;
  const quoteRaw = decodeTokenAmountAndMint(Buffer.from(qv.data[0], 'base64')).amount;
  console.log('  base vault raw   :', baseRaw.toString());
  console.log('  quote vault raw  :', quoteRaw.toString());

  // 4. Fetch base mint decimals (quote is SOL = 9).
  console.log('\nStep 4: fetch base mint decimals');
  const baseMintAcct = await fetchAccount(pool.baseMint);
  if (!baseMintAcct) { console.error('FAIL: base mint fetch'); process.exit(1); }
  const baseMintBuf = Buffer.from(baseMintAcct.data[0], 'base64');
  const baseDecimals = decodeMintDecimals(baseMintBuf);
  console.log('  base decimals :', baseDecimals);

  // 5. Fee bps: default to 25 (PumpSwap total fee), override via FEE_BPS env.
  const feeBps = BigInt(process.env.FEE_BPS || '25');
  console.log('\nStep 5: fee_bps =', feeBps.toString(), '(override via FEE_BPS env)');

  // 6. Simulate swap.
  console.log('\nStep 6: simulate CP swap SOL -> base token');
  // SOL in → quote side is SOL. reserveIn = quoteRaw, reserveOut = baseRaw.
  const amountOut = cpSwapExactIn(AMOUNT_IN_LAMPORTS, quoteRaw, baseRaw, feeBps);
  const ourHuman = Number(amountOut) / 10 ** baseDecimals;
  console.log('  reserveIn  :', quoteRaw.toString());
  console.log('  reserveOut :', baseRaw.toString());
  console.log('  amountOut  :', amountOut.toString());
  console.log('  human      :', ourHuman.toFixed(8));

  // 7. Jupiter quote.
  console.log('\nStep 7: Jupiter /quote (direct routes only)');
  const jup = await jupiterQuote(pool.baseMint);
  if (!jup) { console.error('FAIL: no Jupiter quote'); process.exit(1); }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** baseDecimals;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  ammKey    :', route?.ammKey, `(${route?.label})`);
  console.log('  outAmount :', jupRaw.toString(), `(${jupHuman.toFixed(8)})`);
  if (route && route.ammKey !== poolAddress) {
    console.log('  WARN: Jupiter routed through a different pool than ours.');
  }

  // 8. Diff.
  console.log('\nStep 8: comparison');
  const diff = ourHuman - jupHuman;
  const diffBps = jupHuman === 0 ? 0 : (diff / jupHuman) * 10_000;
  console.log('  ours    :', ourHuman.toFixed(8));
  console.log('  jupiter :', jupHuman.toFixed(8));
  console.log(`  diff    : ${diff.toFixed(8)} (${diffBps.toFixed(2)} bps)`);

  if (Math.abs(diffBps) <= 50) {
    console.log('\nPASS: within 50 bps. PumpSwap math verified.');
  } else {
    console.log('\nFAIL: > 50 bps. Investigate before E3.');
    console.log('  - Confirm same pool ammKey');
    console.log('  - Try FEE_BPS=20 or FEE_BPS=30 (LP+protocol+creator may differ)');
    console.log('  - Verify vault offset / base_mint decimals');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
