/**
 * Phase C — Step C2: Raydium CPMM swap math verification
 *
 * Goal: simulate 0.1 SOL -> token swap using ONLY decoded CPMM pool state
 * (vault balances minus accumulated fees, fee rate from AmmConfig) and
 * compare against Jupiter /quote for the same exact-in. Must match within
 * 50 bps.
 *
 * CPMM is constant-product (x*y=k), identical to Uniswap V2:
 *
 *   amountInAfterFee = amountIn * (1e6 - tradeFeeRate) / 1e6
 *   amountOut        = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee)
 *
 * Effective reserves:
 *   reserve0 = vault0.amount - protocolFeesToken0 - fundFeesToken0
 *   reserve1 = vault1.amount - protocolFeesToken1 - fundFeesToken1
 *
 * Reference:
 *   https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/curve/calculator.rs
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
// Default: USELESS/SOL CPMM (top SOL-paired CPMM pool by TVL, ~$1.31M).
// Override via POOL env var. Other verified options:
//   EGO/SOL  HKRn6cDo5ACgWYY4N52ScCNzziAMSgS5YaEfwsBu4nu3
//   LION/SOL 9SxEcmwzHtSZu2jJSpSxuyxweYECvvtykoP3qtEprkvj
const POOL = process.env.POOL || 'Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp';
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

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface CpmmPool {
  ammConfig: string;
  token0Vault: string;
  token1Vault: string;
  token0Mint: string;
  token1Mint: string;
  mint0Decimals: number;
  mint1Decimals: number;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
}

function decodePool(data: Buffer): CpmmPool {
  return {
    ammConfig:          readPubkey(data, 8),
    token0Vault:        readPubkey(data, 72),
    token1Vault:        readPubkey(data, 104),
    token0Mint:         readPubkey(data, 168),
    token1Mint:         readPubkey(data, 200),
    mint0Decimals:      readU8(data, 331),
    mint1Decimals:      readU8(data, 332),
    protocolFeesToken0: readU64LE(data, 341),
    protocolFeesToken1: readU64LE(data, 349),
    fundFeesToken0:     readU64LE(data, 357),
    fundFeesToken1:     readU64LE(data, 365),
  };
}

function decodeAmmConfigTradeFee(data: Buffer): bigint {
  // tradeFeeRate u64 at offset 12 (after 8-byte discriminator + bump u8 +
  // disableCreatePool bool + index u16 = offset 12).
  return readU64LE(data, 12);
}

// SPL Token account amount is at offset 64
function decodeTokenAmount(data: Buffer): bigint {
  return readU64LE(data, 64);
}

function cpmmSwapExactIn(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  tradeFeeRate1e6: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const FEE_DENOM = 1_000_000n;
  const amountInAfterFee = (amountIn * (FEE_DENOM - tradeFeeRate1e6)) / FEE_DENOM;
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

async function main(): Promise<void> {
  console.log('=== Phase C2: CPMM Swap Math Verification ===');
  console.log(`Pool: ${POOL}`);
  console.log(`Swap: ${AMOUNT_IN_LAMPORTS} lamports SOL -> token`);
  console.log('');

  // 1. Pool
  console.log('Step 1: fetch CPMM pool state');
  const poolAcct = await fetchAccount(POOL);
  if (!poolAcct) { console.error('FAIL: pool fetch'); process.exit(1); }
  const poolBuf = Buffer.from(poolAcct.data[0], 'base64');
  const pool = decodePool(poolBuf);
  console.log('  ammConfig    :', pool.ammConfig);
  console.log('  token0Mint   :', pool.token0Mint, pool.token0Mint === SOL_MINT ? '(SOL)' : '');
  console.log('  token1Mint   :', pool.token1Mint, pool.token1Mint === SOL_MINT ? '(SOL)' : '');
  console.log('  token0Vault  :', pool.token0Vault);
  console.log('  token1Vault  :', pool.token1Vault);
  console.log('  decimals     :', pool.mint0Decimals, '/', pool.mint1Decimals);
  console.log('  protocolFees :', pool.protocolFeesToken0.toString(), '/', pool.protocolFeesToken1.toString());
  console.log('  fundFees     :', pool.fundFeesToken0.toString(), '/', pool.fundFeesToken1.toString());

  const sol0 = pool.token0Mint === SOL_MINT;
  const sol1 = pool.token1Mint === SOL_MINT;
  if (!sol0 && !sol1) { console.error('FAIL: no SOL side'); process.exit(1); }
  const outputMint = sol0 ? pool.token1Mint : pool.token0Mint;
  const outputDecimals = sol0 ? pool.mint1Decimals : pool.mint0Decimals;

  // 2. AmmConfig
  console.log('\nStep 2: fetch ammConfig');
  const cfgAcct = await fetchAccount(pool.ammConfig);
  if (!cfgAcct) { console.error('FAIL: ammConfig'); process.exit(1); }
  const tradeFeeRate = decodeAmmConfigTradeFee(Buffer.from(cfgAcct.data[0], 'base64'));
  console.log('  tradeFeeRate (1e6) :', tradeFeeRate.toString(), `(${Number(tradeFeeRate) / 100} bps)`);

  // 3. Vault balances
  console.log('\nStep 3: fetch vault balances');
  const v0 = await fetchAccount(pool.token0Vault);
  const v1 = await fetchAccount(pool.token1Vault);
  if (!v0 || !v1) { console.error('FAIL: vault fetch'); process.exit(1); }
  const vault0Raw = decodeTokenAmount(Buffer.from(v0.data[0], 'base64'));
  const vault1Raw = decodeTokenAmount(Buffer.from(v1.data[0], 'base64'));
  const reserve0 = vault0Raw - pool.protocolFeesToken0 - pool.fundFeesToken0;
  const reserve1 = vault1Raw - pool.protocolFeesToken1 - pool.fundFeesToken1;
  console.log('  vault0 raw   :', vault0Raw.toString(), '-> reserve0:', reserve0.toString());
  console.log('  vault1 raw   :', vault1Raw.toString(), '-> reserve1:', reserve1.toString());

  // 4. Math
  console.log('\nStep 4: simulate CPMM swap');
  const reserveIn = sol0 ? reserve0 : reserve1;
  const reserveOut = sol0 ? reserve1 : reserve0;
  const amountOut = cpmmSwapExactIn(AMOUNT_IN_LAMPORTS, reserveIn, reserveOut, tradeFeeRate);
  const ourHuman = Number(amountOut) / 10 ** outputDecimals;
  console.log('  reserveIn    :', reserveIn.toString());
  console.log('  reserveOut   :', reserveOut.toString());
  console.log('  amountOut    :', amountOut.toString());
  console.log(`  amountOut hum: ${ourHuman.toFixed(8)}`);

  // 5. Jupiter
  console.log('\nStep 5: Jupiter /quote (direct routes only)');
  const jup = await jupiterQuote(outputMint);
  if (!jup) { console.error('FAIL: no Jupiter quote'); process.exit(1); }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** outputDecimals;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  ammKey       :', route?.ammKey, `(${route?.label})`);
  console.log('  outAmount    :', jupRaw.toString(), `(${jupHuman.toFixed(8)})`);
  if (route && route.ammKey !== POOL) {
    console.log('  WARN: Jupiter routed through a different pool than ours.');
  }

  // 6. Diff
  console.log('\nStep 6: comparison');
  const diff = ourHuman - jupHuman;
  const diffBps = (diff / jupHuman) * 10000;
  console.log(`  ours    : ${ourHuman.toFixed(8)}`);
  console.log(`  jupiter : ${jupHuman.toFixed(8)}`);
  console.log(`  diff    : ${diff.toFixed(8)} (${diffBps.toFixed(2)} bps)`);

  if (Math.abs(diffBps) <= 50) {
    console.log('\nPASS: within 50 bps. CPMM math verified.');
  } else {
    console.log('\nFAIL: > 50 bps. Investigate before C3.');
    console.log('  - Confirm same pool ammKey');
    console.log('  - Check protocol/fund fee subtraction');
    console.log('  - Confirm tradeFeeRate offset (12 in ammConfig)');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
