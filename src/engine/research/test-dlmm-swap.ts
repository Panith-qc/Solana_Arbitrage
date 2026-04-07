/**
 * Phase D — Step D2: Meteora DLMM swap math verification (single-active-bin)
 *
 * Goal: simulate a tiny SOL -> token swap using ONLY decoded LbPair state
 * (active_id, bin_step, base_factor) and compare against Jupiter /quote
 * (direct route via Meteora DLMM only) for the same exact-in.
 *
 * Approach (single active bin, no bin-array traversal):
 *   price_per_X_in_Y = (1 + bin_step / 10000) ^ active_id
 *   base_fee_bps     = (base_factor * bin_step) / 10000
 *   amount_in_after_fee = amount_in * (1 - base_fee_bps / 10000)
 *
 *   X -> Y:  out_y = floor(in_x_after_fee * price)
 *   Y -> X:  out_x = floor(in_y_after_fee / price)
 *
 * This intentionally ignores variable fee + bin traversal — accuracy is
 * sufficient for VERY small swaps (≤ 0.01 SOL) that stay inside the active
 * bin. Tolerance: 250 bps (DLMM variable-fee component, decimal inflation,
 * and bin-edge rounding all contribute drift). Bin-array traversal and the
 * variable-fee formula are added in D3 (the swap builder).
 *
 * Reference:
 *   https://github.com/MeteoraAg/dlmm-sdk
 *   programs/lb_clmm/src/math/price_math.rs (price formula)
 *   programs/lb_clmm/src/math/fee_helper.rs (fee formula)
 */

import { execSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Default: JUP/SOL DLMM (Jupiter routes JUP through DLMM directly).
// Override via POOL env var.
//   BONK/SOL 6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp
//   JLP/SOL  G7ixPyiyNeggVf1VanSetFMNbVuVCPtimJmd9axfQqng
const POOL = process.env.POOL || 'Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf';
// Tiny size to keep the swap inside the active bin.
const AMOUNT_IN_LAMPORTS = 10_000_000n; // 0.01 SOL

const RPC_URLS: string[] = [
  process.env.HELIUS_RPC_URL || '',
  process.env.RPC_URL || '',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

interface AccountValue { data: [string, string]; owner: string; }

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
    jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
    params: [address, { encoding: 'base64' }],
  });
  for (const rpc of RPC_URLS) {
    try {
      const out = curlPost(rpc, body);
      const json = JSON.parse(out);
      if (json?.result?.value) return json.result.value as AccountValue;
    } catch { /* try next */ }
  }
  return null;
}

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU16LE(buf: Buffer, off: number): number { return buf.readUInt16LE(off); }
function readI32LE(buf: Buffer, off: number): number { return buf.readInt32LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface LbPairLite {
  baseFactor: number;
  activeId: number;
  binStep: number;
  tokenXMint: string;
  tokenYMint: string;
}

function decodeLbPair(data: Buffer): LbPairLite {
  // body starts after 8-byte Anchor discriminator
  const body = data.subarray(8);
  return {
    baseFactor: readU16LE(body, 0),
    activeId:   readI32LE(body, 68),
    binStep:    readU16LE(body, 72),
    tokenXMint: readPubkey(body, 80),
    tokenYMint: readPubkey(body, 112),
  };
}

interface JupQuote {
  outAmount: string;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
}

async function jupiterQuote(outputMint: string): Promise<JupQuote | null> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}` +
    `&outputMint=${outputMint}&amount=${AMOUNT_IN_LAMPORTS}&slippageBps=200` +
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

/**
 * Single-active-bin DLMM swap simulator. Uses Number for the price math
 * (Math.pow with bin_step/10000) and converts to BigInt at the end.
 * Inputs/outputs are raw token base units (BigInt).
 */
function dlmmSwapSingleBin(
  amountIn: bigint,
  swapXForY: boolean,
  activeId: number,
  binStep: number,
  baseFactor: number,
): bigint {
  if (amountIn === 0n) return 0n;
  // Meteora bin price formula gives raw_Y_per_raw_X directly (not human).
  // bin_step is in basis points: factor = 1 + bin_step/10000.
  // priceYperX = factor ^ active_id  — units: Y_lamports per X_lamports.
  // No decimal adjustment is needed because the formula already operates
  // on base units; activeId implicitly encodes the decimal difference.
  const factor = 1 + binStep / 10_000;
  const priceYperX = Math.pow(factor, activeId);

  // Base fee: (base_factor * bin_step) / 10000  in bps
  const baseFeeBps = (baseFactor * binStep) / 10_000;
  const feeMul = 1 - baseFeeBps / 10_000;

  const amountInF = Number(amountIn);
  const outF = swapXForY
    ? amountInF * feeMul * priceYperX        // X -> Y
    : (amountInF * feeMul) / priceYperX;     // Y -> X
  if (!isFinite(outF) || outF < 0) return 0n;
  return BigInt(Math.floor(outF));
}

async function main(): Promise<void> {
  console.log('=== Phase D2: Meteora DLMM Swap Math Verification ===');
  console.log(`Pool : ${POOL}`);
  console.log(`Swap : ${AMOUNT_IN_LAMPORTS} lamports SOL -> token (single active bin)`);
  console.log('');

  console.log('Step 1: fetch LbPair state');
  const acct = await fetchAccount(POOL);
  if (!acct) { console.error('FAIL: pool fetch'); process.exit(1); }
  if (acct.owner !== METEORA_DLMM_PROGRAM) {
    console.log('  WARN: owner mismatch, expected DLMM program. Got:', acct.owner);
  }
  const data = Buffer.from(acct.data[0], 'base64');
  const pair = decodeLbPair(data);
  console.log('  baseFactor :', pair.baseFactor);
  console.log('  activeId   :', pair.activeId);
  console.log('  binStep    :', pair.binStep, '(bps)');
  console.log('  tokenXMint :', pair.tokenXMint, pair.tokenXMint === SOL_MINT ? '(SOL)' : '');
  console.log('  tokenYMint :', pair.tokenYMint, pair.tokenYMint === SOL_MINT ? '(SOL)' : '');

  const xIsSol = pair.tokenXMint === SOL_MINT;
  const yIsSol = pair.tokenYMint === SOL_MINT;
  if (!xIsSol && !yIsSol) { console.error('FAIL: no SOL side'); process.exit(1); }
  const outputMint = xIsSol ? pair.tokenYMint : pair.tokenXMint;

  // Fetch decimals from SPL Mint accounts (offset 44 = decimals u8)
  console.log('\nStep 2: fetch mint decimals');
  const mintXAcct = await fetchAccount(pair.tokenXMint);
  const mintYAcct = await fetchAccount(pair.tokenYMint);
  if (!mintXAcct || !mintYAcct) { console.error('FAIL: mint fetch'); process.exit(1); }
  const decX = readU8(Buffer.from(mintXAcct.data[0], 'base64'), 44);
  const decY = readU8(Buffer.from(mintYAcct.data[0], 'base64'), 44);
  console.log('  decX:', decX, ' decY:', decY);

  // 3. Math
  console.log('\nStep 3: simulate single-bin DLMM swap');
  const swapXForY = xIsSol; // SOL is X, swapping X for Y
  const decimalsOut = swapXForY ? decY : decX;
  const ourOut = dlmmSwapSingleBin(
    AMOUNT_IN_LAMPORTS,
    swapXForY,
    pair.activeId,
    pair.binStep,
    pair.baseFactor,
  );
  const ourHuman = Number(ourOut) / 10 ** decimalsOut;
  const baseFeeBps = (pair.baseFactor * pair.binStep) / 10_000;
  console.log('  swap dir   :', swapXForY ? 'X (SOL) -> Y' : 'Y (SOL) -> X');
  console.log('  baseFeeBps :', baseFeeBps);
  console.log('  ourOut raw :', ourOut.toString());
  console.log('  ourOut hum :', ourHuman.toFixed(8));

  // 4. Jupiter
  console.log('\nStep 4: Jupiter /quote (direct DLMM route)');
  const jup = await jupiterQuote(outputMint);
  if (!jup) { console.error('FAIL: no Jupiter quote'); process.exit(1); }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** decimalsOut;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  ammKey   :', route?.ammKey, `(${route?.label})`);
  console.log('  outRaw   :', jupRaw.toString(), `(${jupHuman.toFixed(8)})`);
  if (route && route.ammKey !== POOL) {
    console.log('  WARN: Jupiter routed through a different pool than ours.');
  }
  if (route && route.label && !route.label.includes('Meteora DLMM')) {
    console.log('  WARN: Jupiter route is not a Meteora DLMM (label =', route.label + ').');
  }

  // 5. Diff
  console.log('\nStep 5: comparison');
  const diff = ourHuman - jupHuman;
  const diffBps = jupHuman === 0 ? Infinity : (diff / jupHuman) * 10_000;
  console.log(`  ours    : ${ourHuman.toFixed(8)}`);
  console.log(`  jupiter : ${jupHuman.toFixed(8)}`);
  console.log(`  diff    : ${diff.toFixed(8)} (${diffBps.toFixed(2)} bps)`);

  // Lenient tolerance: single-bin approximation ignores variable fee +
  // bin traversal. Tighter math comes in D3.
  if (Math.abs(diffBps) <= 250) {
    console.log('\nPASS: within 250 bps. DLMM single-bin math verified.');
    console.log('NOTE: full bin-array traversal + variable fee added in D3.');
  } else {
    console.log('\nFAIL: > 250 bps. Investigate before D3.');
    console.log('  - Confirm activeId / binStep / baseFactor offsets');
    console.log('  - Check decimals fetched correctly');
    console.log('  - Verify swap direction (X vs Y)');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
