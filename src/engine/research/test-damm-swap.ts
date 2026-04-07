/**
 * Phase D — Step D7: Meteora Dynamic AMM v1 swap math verification
 *
 * Goal: simulate a small SOL -> token swap using ONLY decoded Pool state
 * plus the underlying dynamic-vault accounts, and compare against Jupiter
 * /quote (direct route, Meteora DAMM only).
 *
 * Effective reserves (per side):
 *
 *   unlocked   = vault.total_amount - locked_profit_at(now)
 *   reserveX   = floor(pool.vault_lp.amount * unlocked / vault_lp_mint.supply)
 *
 * locked_profit_at(t):
 *   duration = t - vault.last_report
 *   ratio    = min(duration * locked_profit_degradation, 1e12)
 *   locked   = vault.last_updated_locked_profit * (1e12 - ratio) / 1e12
 *
 * Swap math (Uniswap V2 constant product with DAMM trade fee):
 *
 *   amountInAfterFee = amountIn * (tradeFeeDen - tradeFeeNum) / tradeFeeDen
 *   amountOut        = amountInAfterFee * reserveOut
 *                      / (reserveIn + amountInAfterFee)
 *
 * Reference:
 *   https://github.com/MeteoraAg/damm-v1-sdk
 *   programs/dynamic-vault/src/state.rs  (Vault, LockedProfitTracker)
 *   programs/dynamic-amm/src/state.rs    (Pool, PoolFees)
 *
 * Vault layout (post 8-byte Anchor discriminator):
 *   off    0  enabled                            u8
 *   off    1  bumps.vault_bump                   u8
 *   off    2  bumps.token_vault_bump             u8
 *   off    3  total_amount                       u64
 *   off   11  token_vault                        Pubkey
 *   off   43  fee_vault                          Pubkey
 *   off   75  token_mint                         Pubkey
 *   off  107  lp_mint                            Pubkey
 *   off  139  strategies [Pubkey;30]             (960 bytes)
 *   off 1099  base                               Pubkey
 *   off 1131  admin                              Pubkey
 *   off 1163  operator                           Pubkey
 *   off 1195  locked_profit_tracker.last_updated u64
 *   off 1203  locked_profit_tracker.last_report  u64
 *   off 1211  locked_profit_tracker.degradation  u64
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DAMM_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

// Default: jitoSOL/SOL DAMM (highest TVL). Override via POOL env var.
//   mSOL/SOL HcjZvfeSNJbNkfLD4eEcRBr96AD3w1GpmMppaeRZf7ur
//   bSOL/SOL DvWpLaNUPqoCGn4foM6hekAPKqMtADJJbJWhwuMiT6vK
const POOL = process.env.POOL || 'ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw';
const AMOUNT_IN_LAMPORTS = 100_000_000n; // 0.1 SOL

const RPC_URLS: string[] = [
  process.env.HELIUS_RPC_URL || '',
  process.env.RPC_URL || '',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

const LOCKED_PROFIT_DEGRADATION_DENOMINATOR = 1_000_000_000_000n;
const SPL_TOKEN_AMOUNT_OFFSET = 64;     // SPL Token account: amount u64
const SPL_MINT_SUPPLY_OFFSET = 36;      // SPL Mint: supply u64

// Pool offsets (post-disc)
const P = {
  TOKEN_A_MINT:  32,
  TOKEN_B_MINT:  64,
  A_VAULT:       96,
  B_VAULT:      128,
  A_VAULT_LP:   160,
  B_VAULT_LP:   192,
  TRADE_FEE_NUM: 322,
  TRADE_FEE_DEN: 330,
} as const;

// Vault offsets (post-disc)
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

function cpSwap(amountIn: bigint, reserveIn: bigint, reserveOut: bigint,
                feeNum: bigint, feeDen: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const amountInAfterFee = (amountIn * (feeDen - feeNum)) / feeDen;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
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
  console.log('  tokenAMint:', tokenAMint, tokenAMint === SOL_MINT ? '(SOL)' : '');
  console.log('  tokenBMint:', tokenBMint, tokenBMint === SOL_MINT ? '(SOL)' : '');
  console.log('  aVault    :', aVault);
  console.log('  bVault    :', bVault);
  console.log('  aVaultLp  :', aVaultLp);
  console.log('  bVaultLp  :', bVaultLp);
  console.log('  tradeFee  :', tradeFeeNum.toString(), '/', tradeFeeDen.toString(),
    `(${Number(tradeFeeNum * 10_000n / (tradeFeeDen || 1n))} bps)`);

  const aIsSol = tokenAMint === SOL_MINT;
  const bIsSol = tokenBMint === SOL_MINT;
  if (!aIsSol && !bIsSol) { console.error('FAIL: no SOL side'); process.exit(1); }
  const outputMint = aIsSol ? tokenBMint : tokenAMint;

  // 2. Fetch vaults (in parallel)
  console.log('\nStep 2: fetch both dynamic-vaults');
  const [aVaultAcct, bVaultAcct] = await Promise.all([fetchAccount(aVault), fetchAccount(bVault)]);
  if (!aVaultAcct || !bVaultAcct) { console.error('FAIL: vault fetch'); process.exit(1); }
  const aV = decodeVault(Buffer.from(aVaultAcct.data[0], 'base64'));
  const bV = decodeVault(Buffer.from(bVaultAcct.data[0], 'base64'));
  console.log('  A vault total:', aV.totalAmount.toString(), ' lpMint:', aV.lpMint);
  console.log('  B vault total:', bV.totalAmount.toString(), ' lpMint:', bV.lpMint);

  // 3. Fetch vault-lp token accounts (pool's shares) + lp mint supplies
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

  // 5. Simulate swap
  console.log('\nStep 5: simulate DAMM swap');
  const reserveIn = aIsSol ? reserveA : reserveB;
  const reserveOut = aIsSol ? reserveB : reserveA;
  const amountOut = cpSwap(AMOUNT_IN_LAMPORTS, reserveIn, reserveOut, tradeFeeNum, tradeFeeDen);

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
    console.log('  - Confirm vault offsets (total_amount, lp_mint, tracker)');
    console.log('  - Check pool vault_lp SPL account balance');
    console.log('  - Verify locked profit subtraction');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
