// METEORA DYNAMIC AMM v1 (DAMM) SWAP BUILDER
// Builds raw Meteora DAMM v1 swap instructions from cached Pool + dynamic-vault
// state — no SDK, no Jupiter. Phase D8 of multi-DEX expansion.
//
// DAMM v1 is unusual: the Pool itself holds NO token reserves. Instead it owns
// LP shares of two Meteora dynamic-vault accounts (separate program). Effective
// reserve per side is:
//
//   unlocked  = vault.total_amount - locked_profit_at(now)
//   reserveX  = floor(pool.vault_lp_balance * unlocked / vault.lp_mint.supply)
//
// Curve types:
//   - ConstantProduct  (Uniswap V2 with PoolFees trade fee)
//   - Stable + Depeg   (Saber-style stable swap, with virtual-price upscaling on
//                        the depeg side; SplStake / Marinade / Lido)
//
// Swap math is verified vs Jupiter in src/engine/research/test-damm-swap.ts
// at -0.27 bps on the jitoSOL/SOL Stable+SplStake pool.
//
// References:
//   - https://github.com/MeteoraAg/damm-v1-sdk
//   - https://github.com/MeteoraAg/vault-sdk
//   - https://github.com/MeteoraAg/stable-swap   (compute_d2 / compute_y_raw2)
//
// Programs:
//   DAMM (Pool):  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
//   Dynamic Vault: 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi

import {
  PublicKey,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import { executionLog } from './logger.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const METEORA_DAMM_PROGRAM = new PublicKey(
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
);
export const METEORA_DYNAMIC_VAULT_PROGRAM = new PublicKey(
  '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
);

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';

// Pool body offsets (post 8-byte Anchor discriminator). See research/damm-layout.ts.
const P = {
  TOKEN_A_MINT:  32,
  TOKEN_B_MINT:  64,
  A_VAULT:       96,
  B_VAULT:      128,
  A_VAULT_LP:   160,
  B_VAULT_LP:   192,
  PROTOCOL_FEE_A: 226,
  PROTOCOL_FEE_B: 258,
  TRADE_FEE_NUM: 322,
  TRADE_FEE_DEN: 330,
  STAKE_POOL_PK: 355,
  CURVE_TYPE:    866, // last field; ConstantProduct (1) or Stable variant (51)
  MIN_LEN_DISC:  8 + 917, // 8 disc + 866 + 51 (max stable variant size)
} as const;

// Vault body offsets (post 8-byte Anchor discriminator)
const V = {
  TOTAL_AMOUNT:  3,
  TOKEN_VAULT:   11,
  LP_MINT:       107,
  LAST_UPDATED:  1195,
  LAST_REPORT:   1203,
  DEGRADATION:   1211,
  MIN_LEN_DISC:  8 + 1219,
} as const;

// SPL Token / Mint offsets
const SPL_TOKEN_AMOUNT_OFFSET = 64;
const SPL_MINT_SUPPLY_OFFSET  = 36;

// SPL Stake Pool offsets
const STAKE_POOL_TOTAL_LAMPORTS_OFFSET = 258;
const STAKE_POOL_TOKEN_SUPPLY_OFFSET   = 266;
const STAKE_POOL_MIN_LEN = 274;

// Stable swap constants
const PRECISION = 1_000_000n;                       // depeg PRECISION
const LOCKED_PROFIT_DEGRADATION_DENOMINATOR = 1_000_000_000_000n;
const N_COINS = 2n;

// Anchor discriminator: sha256("global:swap")[:8]
const SWAP_DISCRIMINATOR = createHash('sha256')
  .update('global:swap')
  .digest()
  .subarray(0, 8);

// ═══════════════════════════════════════════════════════════════
// Curve types
// ═══════════════════════════════════════════════════════════════

export type DammDepegType = 'None' | 'Marinade' | 'Lido' | 'SplStake';

export interface DammConstantProductCurve {
  kind: 'ConstantProduct';
}
export interface DammStableCurve {
  kind: 'Stable';
  amp: bigint;
  tokenAMultiplier: bigint;
  tokenBMultiplier: bigint;
  precisionFactor: number;
  depegBaseVirtualPrice: bigint; // live (refreshed from stake pool)
  depegType: DammDepegType;
}
export type DammCurve = DammConstantProductCurve | DammStableCurve;

// ═══════════════════════════════════════════════════════════════
// Cached pool data
// ═══════════════════════════════════════════════════════════════

export interface CachedDammPool {
  poolAddress: PublicKey;
  // Static identifiers (decoded from pool)
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  aVault: PublicKey;
  bVault: PublicKey;
  aVaultLp: PublicKey;       // pool's SPL token account (vault LP balance)
  bVaultLp: PublicKey;
  protocolTokenAFee: PublicKey;
  protocolTokenBFee: PublicKey;
  // From the dynamic-vault accounts
  aTokenVault: PublicKey;    // vault.token_vault (actual SPL token account)
  bTokenVault: PublicKey;
  aVaultLpMint: PublicKey;
  bVaultLpMint: PublicKey;
  // Mint decimals
  decimalsA: number;
  decimalsB: number;
  // Trade fee (PoolFees)
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  feeBps: number;
  // Curve config
  curve: DammCurve;
  stakePool: PublicKey | null; // for SplStake depeg
  // Mutable on-chain state (refreshed via WS)
  aTotalAmount: bigint;
  bTotalAmount: bigint;
  aLastUpdatedLockedProfit: bigint;
  aLastReport: bigint;
  aLockedProfitDegradation: bigint;
  bLastUpdatedLockedProfit: bigint;
  bLastReport: bigint;
  bLockedProfitDegradation: bigint;
  aPoolShare: bigint;        // pool's vault-LP balance (SPL Token amount)
  bPoolShare: bigint;
  aLpSupply: bigint;         // vault LP mint supply
  bLpSupply: bigint;
  label: string;
}

const dammCache = new Map<string, CachedDammPool>();
// Reverse indices for WS account-change routing
const vaultToDamm        = new Map<string, { pool: string; side: 'a' | 'b' }>();
const vaultLpToDamm      = new Map<string, { pool: string; side: 'a' | 'b' }>();
const vaultLpMintToDamm  = new Map<string, { pool: string; side: 'a' | 'b' }>();
const stakePoolToDamm    = new Map<string, string>();

export function getCachedDammPool(addr: string): CachedDammPool | undefined {
  return dammCache.get(addr);
}
export function getDammPoolByVault(addr: string): { pool: string; side: 'a' | 'b' } | undefined {
  return vaultToDamm.get(addr);
}
export function getDammPoolByVaultLp(addr: string): { pool: string; side: 'a' | 'b' } | undefined {
  return vaultLpToDamm.get(addr);
}
export function getDammPoolByVaultLpMint(addr: string): { pool: string; side: 'a' | 'b' } | undefined {
  return vaultLpMintToDamm.get(addr);
}
export function getDammPoolByStakePool(addr: string): string | undefined {
  return stakePoolToDamm.get(addr);
}

export function getAllCachedDammVaults(): string[] {
  return Array.from(vaultToDamm.keys());
}
export function getAllCachedDammVaultLps(): string[] {
  return Array.from(vaultLpToDamm.keys());
}
export function getAllCachedDammVaultLpMints(): string[] {
  return Array.from(vaultLpMintToDamm.keys());
}
export function getAllCachedDammStakePools(): string[] {
  return Array.from(stakePoolToDamm.keys());
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}
function readU8 (buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU64(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }

function decodeCurveFromPool(poolBody: Buffer): DammCurve {
  const tag = readU8(poolBody, P.CURVE_TYPE);
  if (tag === 0) return { kind: 'ConstantProduct' };
  if (tag !== 1) throw new Error(`unknown DAMM curve tag ${tag}`);
  const o = P.CURVE_TYPE + 1;
  const amp                   = readU64(poolBody, o);
  const tokenAMultiplier      = readU64(poolBody, o + 8);
  const tokenBMultiplier      = readU64(poolBody, o + 16);
  const precisionFactor       = readU8 (poolBody, o + 24);
  const depegBaseVirtualPrice = readU64(poolBody, o + 25);
  // base_cache_updated u64 at o+33 (skipped)
  const depegTypeTag          = readU8 (poolBody, o + 41);
  const depegTypes: DammDepegType[] = ['None', 'Marinade', 'Lido', 'SplStake'];
  const depegType = depegTypes[depegTypeTag] ?? 'None';
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

// ═══════════════════════════════════════════════════════════════
// Math — verified at -0.27 bps in research/test-damm-swap.ts
// ═══════════════════════════════════════════════════════════════

/**
 * Vault locked-profit unlock model. The vault tracks a locked profit that
 * decays linearly (degradation per second) since `lastReport`. The unlocked
 * (withdrawable) amount is total_amount - currently_locked.
 */
function calcUnlockedAmount(
  totalAmount: bigint,
  lastUpdatedLockedProfit: bigint,
  lastReport: bigint,
  lockedProfitDegradation: bigint,
  nowSec: bigint,
): bigint {
  if (nowSec < lastReport) return totalAmount;
  const duration = nowSec - lastReport;
  const ratio = duration * lockedProfitDegradation;
  const clampedRatio = ratio > LOCKED_PROFIT_DEGRADATION_DENOMINATOR
    ? LOCKED_PROFIT_DEGRADATION_DENOMINATOR
    : ratio;
  const locked =
    (lastUpdatedLockedProfit * (LOCKED_PROFIT_DEGRADATION_DENOMINATOR - clampedRatio))
    / LOCKED_PROFIT_DEGRADATION_DENOMINATOR;
  return totalAmount > locked ? totalAmount - locked : 0n;
}

/**
 * Effective reserves seen by the swap. Each side is:
 *   reserve = floor(pool_share * unlocked / lp_supply)
 */
export function effectiveDammReserves(
  pool: CachedDammPool,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): { reserveA: bigint; reserveB: bigint } {
  const aUnlocked = calcUnlockedAmount(
    pool.aTotalAmount,
    pool.aLastUpdatedLockedProfit,
    pool.aLastReport,
    pool.aLockedProfitDegradation,
    nowSec,
  );
  const bUnlocked = calcUnlockedAmount(
    pool.bTotalAmount,
    pool.bLastUpdatedLockedProfit,
    pool.bLastReport,
    pool.bLockedProfitDegradation,
    nowSec,
  );
  const reserveA = pool.aLpSupply === 0n ? 0n : (pool.aPoolShare * aUnlocked) / pool.aLpSupply;
  const reserveB = pool.bLpSupply === 0n ? 0n : (pool.bPoolShare * bUnlocked) / pool.bLpSupply;
  return { reserveA, reserveB };
}

/** Constant-product (Uniswap V2) swap with PoolFees trade fee. */
function cpSwap(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNum: bigint,
  feeDen: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const amountInAfterFee = (amountIn * (feeDen - feeNum)) / feeDen;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

// === Saber-style stable swap math (n=2) ===
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

/**
 * Upscale a token amount per Meteora StableSwap rules:
 *   side=A: amount * token_a_multiplier * (PRECISION if depeg)
 *   side=B: amount * token_b_multiplier * (base_virtual_price if depeg)
 */
function upscale(curve: DammStableCurve, side: 'A' | 'B', amt: bigint): bigint {
  const mul = side === 'A' ? curve.tokenAMultiplier : curve.tokenBMultiplier;
  const scale = side === 'A' ? PRECISION : curve.depegBaseVirtualPrice;
  if (curve.depegType === 'None') return amt * mul;
  return amt * mul * scale;
}
function downscale(curve: DammStableCurve, side: 'A' | 'B', amt: bigint): bigint {
  const mul = side === 'A' ? curve.tokenAMultiplier : curve.tokenBMultiplier;
  const scale = side === 'A' ? PRECISION : curve.depegBaseVirtualPrice;
  if (curve.depegType === 'None') return amt / mul;
  return amt / mul / scale;
}

function stableSwap(
  curve: DammStableCurve,
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

/**
 * Top-level: amount-out for a DAMM pool given an input mint and amount.
 * Returns 0 on any state inconsistency rather than throwing — keeps the
 * hot path quote loop simple.
 */
export function calculateDammAmountOut(
  pool: CachedDammPool,
  amountIn: bigint,
  inputMint: PublicKey,
): bigint {
  if (amountIn === 0n) return 0n;
  const aIsIn = pool.tokenAMint.equals(inputMint);
  const bIsIn = pool.tokenBMint.equals(inputMint);
  if (!aIsIn && !bIsIn) return 0n;

  const { reserveA, reserveB } = effectiveDammReserves(pool);
  const reserveIn  = aIsIn ? reserveA : reserveB;
  const reserveOut = aIsIn ? reserveB : reserveA;
  if (reserveIn === 0n || reserveOut === 0n) return 0n;

  if (pool.curve.kind === 'ConstantProduct') {
    return cpSwap(
      amountIn,
      reserveIn,
      reserveOut,
      pool.tradeFeeNumerator,
      pool.tradeFeeDenominator,
    );
  }

  // Stable
  const tradeFee = (amountIn * pool.tradeFeeNumerator) / pool.tradeFeeDenominator;
  const amountInAfterFee = amountIn - tradeFee;
  const inSide:  'A' | 'B' = aIsIn ? 'A' : 'B';
  const outSide: 'A' | 'B' = aIsIn ? 'B' : 'A';
  return stableSwap(pool.curve, amountInAfterFee, reserveIn, reserveOut, inSide, outSide);
}

// ═══════════════════════════════════════════════════════════════
// Cache pool data
// ═══════════════════════════════════════════════════════════════

export async function cacheDammPoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
): Promise<CachedDammPool | null> {
  try {
    const poolPk = new PublicKey(poolAddress);
    const acct = await connection.getAccountInfo(poolPk);
    if (!acct?.data) {
      executionLog.warn({ pool: poolAddress }, 'DAMM pool fetch returned empty');
      return null;
    }
    if (!acct.owner.equals(METEORA_DAMM_PROGRAM)) {
      executionLog.warn(
        { pool: poolAddress, owner: acct.owner.toString() },
        'Pool not owned by Meteora DAMM program',
      );
      return null;
    }
    if (acct.data.length < P.MIN_LEN_DISC) {
      executionLog.warn(
        { pool: poolAddress, len: acct.data.length, need: P.MIN_LEN_DISC },
        'DAMM pool account too small',
      );
      return null;
    }

    const body = acct.data.subarray(8);
    const tokenAMint = readPubkey(body, P.TOKEN_A_MINT);
    const tokenBMint = readPubkey(body, P.TOKEN_B_MINT);
    const aVault = readPubkey(body, P.A_VAULT);
    const bVault = readPubkey(body, P.B_VAULT);
    const aVaultLp = readPubkey(body, P.A_VAULT_LP);
    const bVaultLp = readPubkey(body, P.B_VAULT_LP);
    const protocolTokenAFee = readPubkey(body, P.PROTOCOL_FEE_A);
    const protocolTokenBFee = readPubkey(body, P.PROTOCOL_FEE_B);
    const tradeFeeNumerator = readU64(body, P.TRADE_FEE_NUM);
    const tradeFeeDenominator = readU64(body, P.TRADE_FEE_DEN);
    const feeBps = tradeFeeDenominator === 0n
      ? 0
      : Number((tradeFeeNumerator * 10_000n) / tradeFeeDenominator);
    const curve = decodeCurveFromPool(body);

    let stakePool: PublicKey | null = null;
    if (curve.kind === 'Stable' && curve.depegType === 'SplStake') {
      stakePool = readPubkey(body, P.STAKE_POOL_PK);
    }

    // Fetch both vault state accounts
    const [aVaultAcct, bVaultAcct] = await Promise.all([
      connection.getAccountInfo(aVault),
      connection.getAccountInfo(bVault),
    ]);
    if (!aVaultAcct?.data || !bVaultAcct?.data) {
      executionLog.warn({ pool: poolAddress }, 'DAMM vault fetch empty');
      return null;
    }
    if (!aVaultAcct.owner.equals(METEORA_DYNAMIC_VAULT_PROGRAM) ||
        !bVaultAcct.owner.equals(METEORA_DYNAMIC_VAULT_PROGRAM)) {
      executionLog.warn({ pool: poolAddress }, 'DAMM vault owner mismatch');
      return null;
    }
    if (aVaultAcct.data.length < V.MIN_LEN_DISC || bVaultAcct.data.length < V.MIN_LEN_DISC) {
      executionLog.warn(
        { pool: poolAddress, aLen: aVaultAcct.data.length, bLen: bVaultAcct.data.length },
        'DAMM vault too small',
      );
      return null;
    }
    const aVbody = aVaultAcct.data.subarray(8);
    const bVbody = bVaultAcct.data.subarray(8);
    const aTotalAmount = readU64(aVbody, V.TOTAL_AMOUNT);
    const bTotalAmount = readU64(bVbody, V.TOTAL_AMOUNT);
    const aTokenVault = readPubkey(aVbody, V.TOKEN_VAULT);
    const bTokenVault = readPubkey(bVbody, V.TOKEN_VAULT);
    const aVaultLpMint = readPubkey(aVbody, V.LP_MINT);
    const bVaultLpMint = readPubkey(bVbody, V.LP_MINT);
    const aLastUpdatedLockedProfit = readU64(aVbody, V.LAST_UPDATED);
    const bLastUpdatedLockedProfit = readU64(bVbody, V.LAST_UPDATED);
    const aLastReport = readU64(aVbody, V.LAST_REPORT);
    const bLastReport = readU64(bVbody, V.LAST_REPORT);
    const aLockedProfitDegradation = readU64(aVbody, V.DEGRADATION);
    const bLockedProfitDegradation = readU64(bVbody, V.DEGRADATION);

    // Fetch pool's vault-LP SPL token accounts (= pool share) + LP mint supplies + token mint decimals
    const [aShareAcct, bShareAcct, aMintAcct, bMintAcct, tokenAMintAcct, tokenBMintAcct] =
      await Promise.all([
        connection.getAccountInfo(aVaultLp),
        connection.getAccountInfo(bVaultLp),
        connection.getAccountInfo(aVaultLpMint),
        connection.getAccountInfo(bVaultLpMint),
        connection.getAccountInfo(tokenAMint),
        connection.getAccountInfo(tokenBMint),
      ]);
    if (!aShareAcct?.data || !bShareAcct?.data || !aMintAcct?.data || !bMintAcct?.data ||
        !tokenAMintAcct?.data || !tokenBMintAcct?.data) {
      executionLog.warn({ pool: poolAddress }, 'DAMM share/mint fetch empty');
      return null;
    }
    const aPoolShare = aShareAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    const bPoolShare = bShareAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    const aLpSupply = aMintAcct.data.readBigUInt64LE(SPL_MINT_SUPPLY_OFFSET);
    const bLpSupply = bMintAcct.data.readBigUInt64LE(SPL_MINT_SUPPLY_OFFSET);
    const decimalsA = tokenAMintAcct.data.readUInt8(44);
    const decimalsB = tokenBMintAcct.data.readUInt8(44);

    // For SplStake depeg: refresh base_virtual_price from the live stake pool
    let liveCurve: DammCurve = curve;
    if (curve.kind === 'Stable' && curve.depegType === 'SplStake' && stakePool) {
      const sp = await connection.getAccountInfo(stakePool);
      if (sp?.data && sp.data.length >= STAKE_POOL_MIN_LEN) {
        const totalLamports = sp.data.readBigUInt64LE(STAKE_POOL_TOTAL_LAMPORTS_OFFSET);
        const tokenSupply   = sp.data.readBigUInt64LE(STAKE_POOL_TOKEN_SUPPLY_OFFSET);
        if (tokenSupply > 0n) {
          const livePrice = (totalLamports * PRECISION) / tokenSupply;
          liveCurve = { ...curve, depegBaseVirtualPrice: livePrice };
        }
      } else {
        executionLog.warn(
          { pool: poolAddress, stakePool: stakePool.toString() },
          'DAMM stake pool fetch returned too small; using cached virtual price',
        );
      }
    }

    const cached: CachedDammPool = {
      poolAddress: poolPk,
      tokenAMint,
      tokenBMint,
      aVault,
      bVault,
      aVaultLp,
      bVaultLp,
      protocolTokenAFee,
      protocolTokenBFee,
      aTokenVault,
      bTokenVault,
      aVaultLpMint,
      bVaultLpMint,
      decimalsA,
      decimalsB,
      tradeFeeNumerator,
      tradeFeeDenominator,
      feeBps,
      curve: liveCurve,
      stakePool,
      aTotalAmount,
      bTotalAmount,
      aLastUpdatedLockedProfit,
      aLastReport,
      aLockedProfitDegradation,
      bLastUpdatedLockedProfit,
      bLastReport,
      bLockedProfitDegradation,
      aPoolShare,
      bPoolShare,
      aLpSupply,
      bLpSupply,
      label,
    };
    dammCache.set(poolAddress, cached);
    vaultToDamm.set(aVault.toString(), { pool: poolAddress, side: 'a' });
    vaultToDamm.set(bVault.toString(), { pool: poolAddress, side: 'b' });
    vaultLpToDamm.set(aVaultLp.toString(), { pool: poolAddress, side: 'a' });
    vaultLpToDamm.set(bVaultLp.toString(), { pool: poolAddress, side: 'b' });
    vaultLpMintToDamm.set(aVaultLpMint.toString(), { pool: poolAddress, side: 'a' });
    vaultLpMintToDamm.set(bVaultLpMint.toString(), { pool: poolAddress, side: 'b' });
    if (stakePool) stakePoolToDamm.set(stakePool.toString(), poolAddress);

    executionLog.info(
      {
        pool: label,
        curve: liveCurve.kind,
        depeg: liveCurve.kind === 'Stable' ? liveCurve.depegType : undefined,
        feeBps,
        aTotal: aTotalAmount.toString(),
        bTotal: bTotalAmount.toString(),
      },
      'DAMM pool cached',
    );
    return cached;
  } catch (err: any) {
    executionLog.error(
      { err: err?.message, pool: poolAddress },
      'Failed to cache DAMM pool',
    );
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// WS refresh hooks (mutable state only)
// ═══════════════════════════════════════════════════════════════

/**
 * Refresh mutable Pool fields from a fresh account buffer (WS push).
 * Re-decodes the curve so SplStake depeg.base_virtual_price stays current
 * if the pool's cached price was bumped by an admin tx (rare).
 */
export function updateCachedDammFromPool(poolAddress: string, data: Buffer): void {
  try {
    const cached = dammCache.get(poolAddress);
    if (!cached) return;
    if (data.length < P.MIN_LEN_DISC) return;
    const body = data.subarray(8);
    cached.tradeFeeNumerator = readU64(body, P.TRADE_FEE_NUM);
    cached.tradeFeeDenominator = readU64(body, P.TRADE_FEE_DEN);
    cached.feeBps = cached.tradeFeeDenominator === 0n
      ? 0
      : Number((cached.tradeFeeNumerator * 10_000n) / cached.tradeFeeDenominator);
    // Preserve any live virtual price already merged from the stake pool.
    const newCurve = decodeCurveFromPool(body);
    if (cached.curve.kind === 'Stable' && newCurve.kind === 'Stable' &&
        cached.curve.depegType === 'SplStake') {
      cached.curve = { ...newCurve, depegBaseVirtualPrice: cached.curve.depegBaseVirtualPrice };
    } else {
      cached.curve = newCurve;
    }
  } catch (err: any) {
    executionLog.warn({ err: err?.message, pool: poolAddress }, 'DAMM pool refresh failed');
  }
}

/**
 * Refresh dynamic-vault state from a fresh account buffer (WS push).
 * Updates total_amount + locked_profit_tracker fields on the matching side.
 */
export function updateCachedDammVault(vaultAddress: string, data: Buffer): void {
  try {
    const ref = vaultToDamm.get(vaultAddress);
    if (!ref) return;
    const cached = dammCache.get(ref.pool);
    if (!cached) return;
    if (data.length < V.MIN_LEN_DISC) return;
    const body = data.subarray(8);
    const total = readU64(body, V.TOTAL_AMOUNT);
    const lastUpdated = readU64(body, V.LAST_UPDATED);
    const lastReport = readU64(body, V.LAST_REPORT);
    const degradation = readU64(body, V.DEGRADATION);
    if (ref.side === 'a') {
      cached.aTotalAmount = total;
      cached.aLastUpdatedLockedProfit = lastUpdated;
      cached.aLastReport = lastReport;
      cached.aLockedProfitDegradation = degradation;
    } else {
      cached.bTotalAmount = total;
      cached.bLastUpdatedLockedProfit = lastUpdated;
      cached.bLastReport = lastReport;
      cached.bLockedProfitDegradation = degradation;
    }
  } catch (err: any) {
    executionLog.warn({ err: err?.message, vault: vaultAddress }, 'DAMM vault refresh failed');
  }
}

/**
 * Refresh the pool's vault-LP SPL token account amount (= pool share).
 */
export function updateCachedDammVaultLp(vaultLpAddress: string, data: Buffer): void {
  try {
    const ref = vaultLpToDamm.get(vaultLpAddress);
    if (!ref) return;
    const cached = dammCache.get(ref.pool);
    if (!cached) return;
    if (data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return;
    const amount = data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    if (ref.side === 'a') cached.aPoolShare = amount;
    else cached.bPoolShare = amount;
  } catch (err: any) {
    executionLog.warn({ err: err?.message, vaultLp: vaultLpAddress }, 'DAMM vaultLp refresh failed');
  }
}

/**
 * Refresh the vault LP mint supply.
 */
export function updateCachedDammVaultLpMint(mintAddress: string, data: Buffer): void {
  try {
    const ref = vaultLpMintToDamm.get(mintAddress);
    if (!ref) return;
    const cached = dammCache.get(ref.pool);
    if (!cached) return;
    if (data.length < SPL_MINT_SUPPLY_OFFSET + 8) return;
    const supply = data.readBigUInt64LE(SPL_MINT_SUPPLY_OFFSET);
    if (ref.side === 'a') cached.aLpSupply = supply;
    else cached.bLpSupply = supply;
  } catch (err: any) {
    executionLog.warn(
      { err: err?.message, mint: mintAddress },
      'DAMM vaultLpMint refresh failed',
    );
  }
}

/**
 * Refresh the live SPL stake-pool virtual price for a Stable+SplStake depeg
 * pool. Computes virtual_price = total_lamports * 1e6 / pool_token_supply
 * and stores it in the cached curve.
 */
export function updateCachedDammStakePool(stakePoolAddress: string, data: Buffer): void {
  try {
    const poolAddr = stakePoolToDamm.get(stakePoolAddress);
    if (!poolAddr) return;
    const cached = dammCache.get(poolAddr);
    if (!cached || cached.curve.kind !== 'Stable') return;
    if (data.length < STAKE_POOL_MIN_LEN) return;
    const totalLamports = data.readBigUInt64LE(STAKE_POOL_TOTAL_LAMPORTS_OFFSET);
    const tokenSupply   = data.readBigUInt64LE(STAKE_POOL_TOKEN_SUPPLY_OFFSET);
    if (tokenSupply === 0n) return;
    const livePrice = (totalLamports * PRECISION) / tokenSupply;
    cached.curve = { ...cached.curve, depegBaseVirtualPrice: livePrice };
  } catch (err: any) {
    executionLog.warn(
      { err: err?.message, stakePool: stakePoolAddress },
      'DAMM stake pool refresh failed',
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Build swap instruction
// ═══════════════════════════════════════════════════════════════
//
// DAMM v1 `swap` instruction (from damm-v1-sdk):
//   discriminator = sha256("global:swap")[:8]
//   args = (in_amount: u64, minimum_out_amount: u64)
//   accounts (15 fixed; SplStake depeg adds 1 remaining):
//     0  pool                       (W)
//     1  user_source_token          (W)
//     2  user_destination_token     (W)
//     3  a_vault                    (W)
//     4  b_vault                    (W)
//     5  a_token_vault              (W)   vault.token_vault
//     6  b_token_vault              (W)
//     7  a_vault_lp_mint            (W)
//     8  b_vault_lp_mint            (W)
//     9  a_vault_lp                 (W)
//    10  b_vault_lp                 (W)
//    11  protocol_token_fee         (W)   the *input-side* protocol fee acct
//    12  user                       (signer)
//    13  vault_program              (R)
//    14  token_program              (R)
//    + remaining: stake_pool        (R)   only when curve = Stable + SplStake

export interface BuildDammSwapParams {
  pool: CachedDammPool;
  payer: PublicKey;
  userInputTokenAccount: PublicKey;
  userOutputTokenAccount: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function buildDammSwapInstruction(p: BuildDammSwapParams): TransactionInstruction {
  const aIsIn = p.pool.tokenAMint.equals(p.inputMint);
  const bIsIn = p.pool.tokenBMint.equals(p.inputMint);
  if (!aIsIn && !bIsIn) {
    throw new Error(
      `inputMint ${p.inputMint.toString()} not in DAMM pool ${p.pool.poolAddress.toString()}`,
    );
  }

  // Protocol-fee account is on the *input* side.
  const protocolTokenFee = aIsIn ? p.pool.protocolTokenAFee : p.pool.protocolTokenBFee;

  const data = Buffer.alloc(8 + 8 + 8);
  SWAP_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minimumAmountOut, 16);

  const keys = [
    { pubkey: p.pool.poolAddress,         isSigner: false, isWritable: true  },
    { pubkey: p.userInputTokenAccount,    isSigner: false, isWritable: true  },
    { pubkey: p.userOutputTokenAccount,   isSigner: false, isWritable: true  },
    { pubkey: p.pool.aVault,              isSigner: false, isWritable: true  },
    { pubkey: p.pool.bVault,              isSigner: false, isWritable: true  },
    { pubkey: p.pool.aTokenVault,         isSigner: false, isWritable: true  },
    { pubkey: p.pool.bTokenVault,         isSigner: false, isWritable: true  },
    { pubkey: p.pool.aVaultLpMint,        isSigner: false, isWritable: true  },
    { pubkey: p.pool.bVaultLpMint,        isSigner: false, isWritable: true  },
    { pubkey: p.pool.aVaultLp,            isSigner: false, isWritable: true  },
    { pubkey: p.pool.bVaultLp,            isSigner: false, isWritable: true  },
    { pubkey: protocolTokenFee,           isSigner: false, isWritable: true  },
    { pubkey: p.payer,                    isSigner: true,  isWritable: false },
    { pubkey: METEORA_DYNAMIC_VAULT_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM,              isSigner: false, isWritable: false },
  ];

  // Stable+SplStake depeg requires the live stake pool as a remaining account
  // so the program can recompute virtual_price during the swap.
  if (
    p.pool.curve.kind === 'Stable' &&
    p.pool.curve.depegType === 'SplStake' &&
    p.pool.stakePool
  ) {
    keys.push({ pubkey: p.pool.stakePool, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: METEORA_DAMM_PROGRAM,
    keys,
    data,
  });
}

export function getRequiredDammAlts(_pool: CachedDammPool): PublicKey[] {
  return [];
}

// ═══════════════════════════════════════════════════════════════
// Price book
// ═══════════════════════════════════════════════════════════════

/**
 * SOL-per-token from cached DAMM (for the price book). Uses effective
 * reserves (vault unlock-aware) and inverts based on which side SOL sits on.
 */
export function dammSolPerToken(pool: CachedDammPool): number {
  const aIsSol = pool.tokenAMint.toString() === SOL_MINT_STR;
  const bIsSol = pool.tokenBMint.toString() === SOL_MINT_STR;
  if (!aIsSol && !bIsSol) return 0;
  const { reserveA, reserveB } = effectiveDammReserves(pool);
  if (reserveA === 0n || reserveB === 0n) return 0;
  const aHuman = Number(reserveA) / 10 ** pool.decimalsA;
  const bHuman = Number(reserveB) / 10 ** pool.decimalsB;
  if (aIsSol) {
    return bHuman === 0 ? 0 : aHuman / bHuman;
  }
  return aHuman === 0 ? 0 : bHuman / aHuman;
}
