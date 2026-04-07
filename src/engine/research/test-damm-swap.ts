/**
 * Phase D - Step D7: Meteora Dynamic AMM v1 swap math verification.
 *
 * The pool stores no token reserves directly; instead it holds LP shares of
 * Meteora dynamic-vaults. Effective reserves per side are computed as:
 *
 *   unlocked = vault.total_amount - locked_profit_at(now)
 *   reserveX = floor(pool.vault_lp.amount * unlocked / vault.lp_mint.supply)
 *
 * The pool's curve is either ConstantProduct OR Stable. For SOL liquid-staking
 * pairs (jitoSOL/SOL, mSOL/SOL, bSOL/SOL) the curve is Stable with depeg
 * (SplStake / Marinade / Lido), which uses Saber-style stable swap math
 * combined with a virtual-price scaling on the depeg side.
 *
 * Sources:
 *   https://github.com/MeteoraAg/damm-v1-sdk
 *   https://github.com/MeteoraAg/stable-swap   (compute_d2 / compute_y_raw2)
 *   https://github.com/MeteoraAg/vault-sdk     (Vault state + locked profit)
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DAMM_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

// Default: jitoSOL/SOL DAMM (Stable + SplStake depeg). Override via POOL env var.
const POOL = process.env.POOL || 'ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw';
const AMOUNT_IN_LAMPORTS = 100_000_000n; // 0.1 SOL

const RPC_URLS: string[] = [
  process.env.HELIUS_RPC_URL || '',
  process.env.RPC_URL || '',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

const LOCKED_PROFIT_DEGRADATION_DENOMINATOR = 1_000_000_000_000n;
const SPL_TOKEN_AMOUNT_OFFSET = 64;
const SPL_MINT_SUPPLY_OFFSET = 36;
const STAKE_POOL_TOTAL_LAMPORTS_OFFSET = 258;
const STAKE_POOL_TOKEN_SUPPLY_OFFSET   = 266;
const PRECISION = 1_000_000n;

// Pool offsets (post 8-byte Anchor discriminator)
const P = {
  TOKEN_A_MINT:  32,
  TOKEN_B_MINT:  64,
  A_VAULT:       96,
  B_VAULT:      128,
  A_VAULT_LP:   160,
  B_VAULT_LP:   192,
  TRADE_FEE_NUM: 322,
  TRADE_FEE_DEN: 330,
  STAKE_POOL_PK: 355,
  CURVE_TYPE:    866, // last field; tag (1) + Stable variant (50) = 51 bytes
} as const;

// Vault offsets (post 8-byte Anchor discriminator)
const V = {
  TOTAL_AMOUNT:  3,
  LP_MINT:       107,
  LAST_UPDATED:  1195,
  LAST_REPORT:   1203,
  DEGRADATION:   1211,
} as const;

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
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface VaultState {
  totalAmount: bigint;
  lpMint: string;
  lastUpdatedLockedProfit: bigint;
  lastReport: bigint;
  lockedProfitDegradation: bigint;
}
function decodeVault(data: Buffer): VaultState {
  const body = data.subarray(8);
  return {
    totalAmount:             readU64LE(body, V.TOTAL_AMOUNT),
    lpMint:                  readPubkey(body, V.LP_MINT),
    lastUpdatedLockedProfit: readU64LE(body, V.LAST_UPDATED),
    lastReport:              readU64LE(body, V.LAST_REPORT),
    lockedProfitDegradation: readU64LE(body, V.DEGRADATION),
  };
}

function calcUnlockedAmount(v: VaultState, nowSec: bigint): bigint {
  if (nowSec < v.lastReport) return v.totalAmount;
  const duration = nowSec - v.lastReport;
  const ratio = duration * v.lockedProfitDegradation;
  const clampedRatio = ratio > LOCKED_PROFIT_DEGRADATION_DENOMINATOR
    ? LOCKED_PROFIT_DEGRADATION_DENOMINATOR
    : ratio;
  const locked =
    (v.lastUpdatedLockedProfit * (LOCKED_PROFIT_DEGRADATION_DENOMINATOR - clampedRatio))
    / LOCKED_PROFIT_DEGRADATION_DENOMINATOR;
  return v.totalAmount > locked ? v.totalAmount - locked : 0n;
}

// === Curve type decoding ===
//
// Pool's curve_type is the LAST field in the struct (offset 866 post-disc).
// Encoding:
//   tag u8                     // 0 = ConstantProduct, 1 = Stable
//   if Stable:
//     amp                       u64
//     token_a_multiplier        u64
//     token_b_multiplier        u64
//     precision_factor          u8
//     depeg.base_virtual_price  u64
//     depeg.base_cache_updated  u64
//     depeg.depeg_type          u8   // 0 None, 1 Marinade, 2 Lido, 3 SplStake
//     last_amp_updated_timestamp u64

type DepegType = 'None' | 'Marinade' | 'Lido' | 'SplStake';

interface ConstantProductCurve {
  kind: 'ConstantProduct';
}
interface StableCurve {
  kind: 'Stable';
  amp: bigint;
  tokenAMultiplier: bigint;
  tokenBMultiplier: bigint;
  precisionFactor: number;
  depegBaseVirtualPrice: bigint;
  depegType: DepegType;
}
type Curve = ConstantProductCurve | StableCurve;

function decodeCurveType(poolBody: Buffer): Curve {
  const tag = readU8(poolBody, P.CURVE_TYPE);
  if (tag === 0) return { kind: 'ConstantProduct' };
  if (tag !== 1) throw new Error(`unknown curve_type tag ${tag}`);
  const o = P.CURVE_TYPE + 1;
  const amp                = readU64LE(poolBody, o);
  const tokenAMultiplier   = readU64LE(poolBody, o + 8);
  const tokenBMultiplier   = readU64LE(poolBody, o + 16);
  const precisionFactor    = readU8   (poolBody, o + 24);
  const depegBaseVirtualPrice = readU64LE(poolBody, o + 25);
  // base_cache_updated u64 at o+33
  const depegTypeTag       = readU8   (poolBody, o + 41);
  const depegTypes: DepegType[] = ['None', 'Marinade', 'Lido', 'SplStake'];
  const depegType = depegTypes[depegTypeTag] || 'None';
  return {
    kind: 'Stable',
    amp,
    tokenAMultiplier,
    tokenBMultiplier,
    precisionFactor,
    depegBaseVirtualPrice,
    depegType,
  };
}

// === Constant-product swap math ===
function cpSwap(amountIn: bigint, reserveIn: bigint, reserveOut: bigint,
                feeNum: bigint, feeDen: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const amountInAfterFee = (amountIn * (feeDen - feeNum)) / feeDen;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

// === Saber-style stable swap math (n=2) ===
const N_COINS = 2n;

function computeD(amp: bigint, x: bigint, y: bigint): bigint {
  const sumX = x + y;
  if (sumX === 0n) return 0n;
  const ann = amp * N_COINS;
  const aN = x * N_COINS;
  const bN = y * N_COINS;
  let d = sumX;
  for (let i = 0; i < 256; i++) {
    let dProd = d;
    dProd = (dProd * d) / aN;
    dProd = (dProd * d) / bN;
    const dPrev = d;
    const leverage = sumX * ann;
    const numerator = d * (dProd * N_COINS + leverage);
    const denominator = d * (ann - 1n) + dProd * (N_COINS + 1n);
    d = numerator / denominator;
    const diff = d > dPrev ? d - dPrev : dPrev - d;
    if (diff <= 1n) break;
  }
  return d;
}

function computeY(amp: bigint, x: bigint, d: bigint): bigint {
  const ann = amp * N_COINS;
  let c = (d * d) / (x * N_COINS);
  c = (c * d) / (ann * N_COINS);
  const b = d / ann + x;
  let y = d;
  for (let i = 0; i < 256; i++) {
    const yPrev = y;
    const num = y * y + c;
    const den = 2n * y + b - d;
    y = num / den;
    const diff = y > yPrev ? y - yPrev : yPrev - y;
    if (diff <= 1n) break;
  }
  return y;
}

// Upscale a token amount per the Meteora StableSwap rules:
//   side=A: amount * token_a_multiplier * (PRECISION if depeg)
//   side=B: amount * token_b_multiplier * (base_virtual_price if depeg)
function upscale(curve: StableCurve, side: 'A' | 'B', amt: bigint): bigint {
  const mul = side === 'A' ? curve.tokenAMultiplier : curve.tokenBMultiplier;
  const scale = side === 'A' ? PRECISION : curve.depegBaseVirtualPrice;
  if (curve.depegType === 'None') return amt * mul;
  return amt * mul * scale;
}
function downscale(curve: StableCurve, side: 'A' | 'B', amt: bigint): bigint {
  const mul = side === 'A' ? curve.tokenAMultiplier : curve.tokenBMultiplier;
  const scale = side === 'A' ? PRECISION : curve.depegBaseVirtualPrice;
  if (curve.depegType === 'None') return amt / mul;
  return amt / mul / scale;
}

function stableSwap(
  curve: StableCurve,
  amountInAfterFee: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  inSide: 'A' | 'B',
  outSide: 'A' | 'B',
): bigint {
  const usrc = upscale(curve, inSide, amountInAfterFee);
  const uIn  = upscale(curve, inSide, reserveIn);
  const uOut = upscale(curve, outSide, reserveOut);
  const d = computeD(curve.amp, uIn, uOut);
  const y = computeY(curve.amp, uIn + usrc, d);
  if (uOut <= y + 1n) return 0n;
  const dy = uOut - y - 1n;
  return downscale(curve, outSide, dy);
}

interface JupQuote {
  outAmount: string;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
}
function jupiterQuote(outputMint: string): JupQuote | null {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}` +
    `&outputMint=${outputMint}&amount=${AMOUNT_IN_LAMPORTS}&slippageBps=100` +
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
  console.log('=== Phase D7: Meteora Dynamic AMM v1 Swap Math Verification ===');
  console.log(`Pool: ${POOL}`);
  console.log(`Swap: ${AMOUNT_IN_LAMPORTS} lamports SOL -> token`);
  console.log('');

  // 1. Pool
  console.log('Step 1: fetch DAMM Pool state');
  const poolAcct = await fetchAccount(POOL);
  if (!poolAcct) { console.error('FAIL: pool fetch'); process.exit(1); }
  if (poolAcct.owner !== DAMM_PROGRAM) {
    console.log('  WARN: owner mismatch. Got:', poolAcct.owner);
  }
  const poolBody = Buffer.from(poolAcct.data[0], 'base64').subarray(8);
  const tokenAMint = readPubkey(poolBody, P.TOKEN_A_MINT);
  const tokenBMint = readPubkey(poolBody, P.TOKEN_B_MINT);
  const aVault = readPubkey(poolBody, P.A_VAULT);
  const bVault = readPubkey(poolBody, P.B_VAULT);
  const aVaultLp = readPubkey(poolBody, P.A_VAULT_LP);
  const bVaultLp = readPubkey(poolBody, P.B_VAULT_LP);
  const tradeFeeNum = readU64LE(poolBody, P.TRADE_FEE_NUM);
  const tradeFeeDen = readU64LE(poolBody, P.TRADE_FEE_DEN);
  const curve = decodeCurveType(poolBody);
  console.log('  tokenAMint:', tokenAMint, tokenAMint === SOL_MINT ? '(SOL)' : '');
  console.log('  tokenBMint:', tokenBMint, tokenBMint === SOL_MINT ? '(SOL)' : '');
  console.log('  aVault    :', aVault);
  console.log('  bVault    :', bVault);
  console.log('  aVaultLp  :', aVaultLp);
  console.log('  bVaultLp  :', bVaultLp);
  console.log('  tradeFee  :', tradeFeeNum.toString(), '/', tradeFeeDen.toString(),
    `(${Number(tradeFeeNum * 10_000n / (tradeFeeDen || 1n))} bps)`);
  if (curve.kind === 'ConstantProduct') {
    console.log('  curveType : ConstantProduct');
  } else {
    console.log('  curveType : Stable');
    console.log('    amp                :', curve.amp.toString());
    console.log('    tokenAMultiplier   :', curve.tokenAMultiplier.toString());
    console.log('    tokenBMultiplier   :', curve.tokenBMultiplier.toString());
    console.log('    precisionFactor    :', curve.precisionFactor);
    console.log('    depegType          :', curve.depegType);
    console.log('    base_virtual_price :', curve.depegBaseVirtualPrice.toString(),
      curve.depegBaseVirtualPrice > 0n
        ? `(~${(Number(curve.depegBaseVirtualPrice) / 1e6).toFixed(6)})`
        : '');
  }

  const aIsSol = tokenAMint === SOL_MINT;
  const bIsSol = tokenBMint === SOL_MINT;
  if (!aIsSol && !bIsSol) { console.error('FAIL: no SOL side'); process.exit(1); }
  const outputMint = aIsSol ? tokenBMint : tokenAMint;

  // 2. Fetch vaults
  console.log('\nStep 2: fetch both dynamic-vaults');
  const [aVaultAcct, bVaultAcct] = await Promise.all([fetchAccount(aVault), fetchAccount(bVault)]);
  if (!aVaultAcct || !bVaultAcct) { console.error('FAIL: vault fetch'); process.exit(1); }
  const aV = decodeVault(Buffer.from(aVaultAcct.data[0], 'base64'));
  const bV = decodeVault(Buffer.from(bVaultAcct.data[0], 'base64'));
  console.log('  A vault total:', aV.totalAmount.toString(), ' lpMint:', aV.lpMint);
  console.log('  B vault total:', bV.totalAmount.toString(), ' lpMint:', bV.lpMint);

  // 3. Fetch vault-lp token accounts + lp mint supplies
  console.log('\nStep 3: fetch pool vault-LP balances + vault LP mint supplies');
  const [aVaultLpAcct, bVaultLpAcct, aLpMintAcct, bLpMintAcct] = await Promise.all([
    fetchAccount(aVaultLp),
    fetchAccount(bVaultLp),
    fetchAccount(aV.lpMint),
    fetchAccount(bV.lpMint),
  ]);
  if (!aVaultLpAcct || !bVaultLpAcct || !aLpMintAcct || !bLpMintAcct) {
    console.error('FAIL: vault-lp / lp-mint fetch'); process.exit(1);
  }
  const aShare = Buffer.from(aVaultLpAcct.data[0], 'base64').readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
  const bShare = Buffer.from(bVaultLpAcct.data[0], 'base64').readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
  const aLpSupply = Buffer.from(aLpMintAcct.data[0], 'base64').readBigUInt64LE(SPL_MINT_SUPPLY_OFFSET);
  const bLpSupply = Buffer.from(bLpMintAcct.data[0], 'base64').readBigUInt64LE(SPL_MINT_SUPPLY_OFFSET);
  console.log('  pool share A :', aShare.toString(), '/ supply', aLpSupply.toString());
  console.log('  pool share B :', bShare.toString(), '/ supply', bLpSupply.toString());

  // 4. Compute effective reserves
  console.log('\nStep 4: compute effective reserves');
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const aUnlocked = calcUnlockedAmount(aV, nowSec);
  const bUnlocked = calcUnlockedAmount(bV, nowSec);
  const reserveA = aLpSupply === 0n ? 0n : (aShare * aUnlocked) / aLpSupply;
  const reserveB = bLpSupply === 0n ? 0n : (bShare * bUnlocked) / bLpSupply;
  console.log('  A unlocked :', aUnlocked.toString(), ' -> reserveA:', reserveA.toString());
  console.log('  B unlocked :', bUnlocked.toString(), ' -> reserveB:', reserveB.toString());

  // 4b. For Stable+SplStake, refresh base_virtual_price from the live stake pool
  let activeCurve = curve;
  if (activeCurve.kind === 'Stable' && activeCurve.depegType === 'SplStake') {
    console.log('\nStep 4b: refresh base_virtual_price from live SPL stake pool');
    const stakePoolPk = readPubkey(poolBody, P.STAKE_POOL_PK);
    console.log('  stake pool:', stakePoolPk);
    const stakeAcct = await fetchAccount(stakePoolPk);
    if (!stakeAcct) {
      console.log('  WARN: stake pool fetch failed; using cached virtual price');
    } else {
      const sb = Buffer.from(stakeAcct.data[0], 'base64');
      const totalLamports = sb.readBigUInt64LE(STAKE_POOL_TOTAL_LAMPORTS_OFFSET);
      const tokenSupply   = sb.readBigUInt64LE(STAKE_POOL_TOKEN_SUPPLY_OFFSET);
      if (tokenSupply > 0n) {
        const livePrice = (totalLamports * PRECISION) / tokenSupply;
        console.log(`  live virtual_price = ${livePrice} (cached: ${activeCurve.depegBaseVirtualPrice})`);
        activeCurve = { ...activeCurve, depegBaseVirtualPrice: livePrice };
      }
    }
  }

  // 5. Simulate swap (apply trade fee, then run curve)
  console.log('\nStep 5: simulate DAMM swap');
  const reserveIn  = aIsSol ? reserveA : reserveB;
  const reserveOut = aIsSol ? reserveB : reserveA;
  const inSide:  'A' | 'B' = aIsSol ? 'A' : 'B';
  const outSide: 'A' | 'B' = aIsSol ? 'B' : 'A';
  const tradeFee = (AMOUNT_IN_LAMPORTS * tradeFeeNum) / tradeFeeDen;
  const amountInAfterFee = AMOUNT_IN_LAMPORTS - tradeFee;
  console.log(`  trade fee: ${tradeFee} -> after fee: ${amountInAfterFee}`);

  let amountOut: bigint;
  if (activeCurve.kind === 'ConstantProduct') {
    amountOut = cpSwap(AMOUNT_IN_LAMPORTS, reserveIn, reserveOut, tradeFeeNum, tradeFeeDen);
  } else {
    amountOut = stableSwap(activeCurve, amountInAfterFee, reserveIn, reserveOut, inSide, outSide);
  }

  // Mint decimals for the output side
  const outMintAcct = await fetchAccount(outputMint);
  if (!outMintAcct) { console.error('FAIL: out mint fetch'); process.exit(1); }
  const outDecimals = readU8(Buffer.from(outMintAcct.data[0], 'base64'), 44);
  const ourHuman = Number(amountOut) / 10 ** outDecimals;
  console.log('  amountOut raw:', amountOut.toString(), `(${ourHuman.toFixed(8)})`);

  // 6. Jupiter
  console.log('\nStep 6: Jupiter /quote (direct routes)');
  const jup = jupiterQuote(outputMint);
  if (!jup) { console.error('FAIL: no Jupiter quote'); process.exit(1); }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** outDecimals;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  ammKey   :', route?.ammKey, `(${route?.label})`);
  console.log('  outAmount:', jupRaw.toString(), `(${jupHuman.toFixed(8)})`);
  if (route && route.ammKey !== POOL) {
    console.log('  WARN: Jupiter routed through a different pool than ours.');
  }

  // 7. Diff
  console.log('\nStep 7: comparison');
  const diff = ourHuman - jupHuman;
  const diffBps = jupHuman === 0 ? Infinity : (diff / jupHuman) * 10_000;
  console.log(`  ours    : ${ourHuman.toFixed(8)}`);
  console.log(`  jupiter : ${jupHuman.toFixed(8)}`);
  console.log(`  diff    : ${diff.toFixed(8)} (${diffBps.toFixed(2)} bps)`);

  if (Math.abs(diffBps) <= 50) {
    console.log('\nPASS: within 50 bps. DAMM math verified.');
  } else {
    console.log('\nFAIL: > 50 bps. Investigate before D8.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
