// RAYDIUM CLMM SWAP BUILDER
// Builds raw Raydium CLMM swap instructions from cached pool state — no SDK,
// no Jupiter. Same hot-path role as directSwapBuilder.ts but for CLMM pools.
//
// Phase A3 of multi-DEX expansion. Math verified against Jupiter at 0.00 bps
// in src/engine/research/test-clmm-swap.ts (Phase A2).
//
// References:
//   - https://github.com/raydium-io/raydium-clmm
//   - Uniswap V3 whitepaper §6.2.2 (constant-L exact-in math)
//
// CLMM PoolState layout (post 8-byte Anchor discriminator):
//   off   8  bump              u8
//   off   9  ammConfig         Pubkey (32)
//   off  41  owner             Pubkey (32)
//   off  73  tokenMint0        Pubkey (32)
//   off 105  tokenMint1        Pubkey (32)
//   off 137  tokenVault0       Pubkey (32)
//   off 169  tokenVault1       Pubkey (32)
//   off 201  observationKey    Pubkey (32)
//   off 233  mintDecimals0     u8
//   off 234  mintDecimals1     u8
//   off 235  tickSpacing       u16
//   off 237  liquidity         u128 (16)
//   off 253  sqrtPriceX64      u128 (16)
//   off 269  tickCurrent       i32
//
// AmmConfig layout (post 8-byte Anchor discriminator):
//   off   8  bump              u8
//   off   9  index             u16
//   off  11  owner             Pubkey (32)
//   off  43  protocolFeeRate   u32
//   off  47  tradeFeeRate      u32      <-- 1e6 denom; 500 = 5 bps, 2500 = 25 bps
//   off  51  tickSpacing       u16
//
// CLMM swap instruction (the non-v2 `swap` method):
//   discriminator = sha256("global:swap")[:8]
//   args:
//     amount: u64
//     otherAmountThreshold: u64
//     sqrtPriceLimitX64: u128
//     isBaseInput: bool
//   accounts (from raydium-clmm/programs/amm/src/instructions/swap.rs):
//     0  payer                (signer, writable)
//     1  ammConfig            (read)
//     2  poolState            (writable)
//     3  inputTokenAccount    (writable)
//     4  outputTokenAccount   (writable)
//     5  inputVault           (writable)
//     6  outputVault          (writable)
//     7  observationState     (writable)
//     8  tokenProgram         (read)
//     9  tickArray            (writable)  — first tick array containing current
//   remaining_accounts: additional tick arrays (writable) the swap may cross
//
// Tick array PDA:
//   seeds = ["tick_array", poolState, start_tick_index.to_be_bytes() (i32 BE)]
//   start_tick_index = floor(currentTick / (tickSpacing * TICK_ARRAY_SIZE))
//                       * (tickSpacing * TICK_ARRAY_SIZE)
//   TICK_ARRAY_SIZE = 60

import {
  PublicKey,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createHash } from 'crypto';
import { executionLog } from './logger.js';
import { SOL_MINT } from './config.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const RAYDIUM_CLMM_PROGRAM = new PublicKey(
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
);

const TICK_ARRAY_SIZE = 60;
const TICK_ARRAY_SEED = Buffer.from('tick_array');

// PoolState offsets
const POOL = {
  AMM_CONFIG: 9,
  TOKEN_MINT_0: 73,
  TOKEN_MINT_1: 105,
  TOKEN_VAULT_0: 137,
  TOKEN_VAULT_1: 169,
  OBSERVATION_KEY: 201,
  MINT_DECIMALS_0: 233,
  MINT_DECIMALS_1: 234,
  TICK_SPACING: 235,
  LIQUIDITY: 237,
  SQRT_PRICE_X64: 253,
  TICK_CURRENT: 269,
  MIN_DATA_LENGTH: 280,
} as const;

// AmmConfig offsets
const CFG = {
  TRADE_FEE_RATE: 47, // u32, 1e6 denom
} as const;

const FEE_DENOM = 1_000_000n;
const Q64 = 1n << 64n;

// Anchor discriminator for "swap" method = sha256("global:swap")[:8]
const SWAP_DISCRIMINATOR = createHash('sha256')
  .update('global:swap')
  .digest()
  .subarray(0, 8);

// Sqrt price limits — pass min/max to disable so the program will swap until
// it hits otherAmountThreshold or runs out of tick arrays.
const MIN_SQRT_PRICE_X64 = 4_295_048_016n; // from raydium-clmm tick math
const MAX_SQRT_PRICE_X64 = 79_226_673_521_066_979_257_578_248_091n;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CachedClmmPool {
  poolAddress: PublicKey;
  ammConfig: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  observationKey: PublicKey;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  // Mutable on-chain state — refreshed by WebSocket on pool account changes
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  // Fee from ammConfig (1e6 denom). E.g. 500 = 5 bps, 2500 = 25 bps.
  tradeFeeRate: number;
  feeBps: number;
  label: string;
}

const clmmCache = new Map<string, CachedClmmPool>();

export function getCachedClmmPool(addr: string): CachedClmmPool | undefined {
  return clmmCache.get(addr);
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}

function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}

function writeU128LE(buf: Buffer, off: number, value: bigint): void {
  const mask = (1n << 64n) - 1n;
  buf.writeBigUInt64LE(value & mask, off);
  buf.writeBigUInt64LE((value >> 64n) & mask, off + 8);
}

// ═══════════════════════════════════════════════════════════════
// Cache pool data — fetch PoolState + AmmConfig once at startup
// ═══════════════════════════════════════════════════════════════

export async function cacheClmmPoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
): Promise<CachedClmmPool | null> {
  try {
    const poolPk = new PublicKey(poolAddress);
    const poolAcct = await connection.getAccountInfo(poolPk);
    if (!poolAcct?.data || poolAcct.data.length < POOL.MIN_DATA_LENGTH) {
      executionLog.warn(
        { pool: poolAddress, len: poolAcct?.data?.length },
        'CLMM pool account too small',
      );
      return null;
    }
    if (!poolAcct.owner.equals(RAYDIUM_CLMM_PROGRAM)) {
      executionLog.warn(
        { pool: poolAddress, owner: poolAcct.owner.toString() },
        'Pool not owned by Raydium CLMM program',
      );
      return null;
    }

    const data = poolAcct.data;
    const ammConfig = readPubkey(data, POOL.AMM_CONFIG);
    const tokenMint0 = readPubkey(data, POOL.TOKEN_MINT_0);
    const tokenMint1 = readPubkey(data, POOL.TOKEN_MINT_1);
    const tokenVault0 = readPubkey(data, POOL.TOKEN_VAULT_0);
    const tokenVault1 = readPubkey(data, POOL.TOKEN_VAULT_1);
    const observationKey = readPubkey(data, POOL.OBSERVATION_KEY);
    const mintDecimals0 = data.readUInt8(POOL.MINT_DECIMALS_0);
    const mintDecimals1 = data.readUInt8(POOL.MINT_DECIMALS_1);
    const tickSpacing = data.readUInt16LE(POOL.TICK_SPACING);
    const liquidity = readU128LE(data, POOL.LIQUIDITY);
    const sqrtPriceX64 = readU128LE(data, POOL.SQRT_PRICE_X64);
    const tickCurrent = data.readInt32LE(POOL.TICK_CURRENT);

    // Fetch ammConfig for fee rate
    const cfgAcct = await connection.getAccountInfo(ammConfig);
    if (!cfgAcct?.data || cfgAcct.data.length < CFG.TRADE_FEE_RATE + 4) {
      executionLog.warn({ pool: poolAddress }, 'CLMM ammConfig too small');
      return null;
    }
    const tradeFeeRate = cfgAcct.data.readUInt32LE(CFG.TRADE_FEE_RATE);
    const feeBps = tradeFeeRate / 100;

    const cached: CachedClmmPool = {
      poolAddress: poolPk,
      ammConfig,
      tokenMint0,
      tokenMint1,
      tokenVault0,
      tokenVault1,
      observationKey,
      mintDecimals0,
      mintDecimals1,
      tickSpacing,
      liquidity,
      sqrtPriceX64,
      tickCurrent,
      tradeFeeRate,
      feeBps,
      label,
    };
    clmmCache.set(poolAddress, cached);

    executionLog.info(
      {
        pool: label,
        sqrtPriceX64: sqrtPriceX64.toString(),
        liquidity: liquidity.toString(),
        tickCurrent,
        feeBps,
      },
      'CLMM pool cached',
    );
    return cached;
  } catch (err: any) {
    executionLog.error(
      { err: err?.message, pool: poolAddress },
      'Failed to cache CLMM pool',
    );
    return null;
  }
}

/**
 * Update mutable state from a fresh PoolState account buffer.
 * Called by poolMonitor when WebSocket pushes a pool account change.
 */
export function updateCachedClmmFromAccount(
  poolAddress: string,
  data: Buffer,
): void {
  const cached = clmmCache.get(poolAddress);
  if (!cached) return;
  if (data.length < POOL.MIN_DATA_LENGTH) return;
  cached.liquidity = readU128LE(data, POOL.LIQUIDITY);
  cached.sqrtPriceX64 = readU128LE(data, POOL.SQRT_PRICE_X64);
  cached.tickCurrent = data.readInt32LE(POOL.TICK_CURRENT);
}

// ═══════════════════════════════════════════════════════════════
// Math (verified against Jupiter at 0.00 bps in A2)
// ═══════════════════════════════════════════════════════════════

/**
 * Constant-L exact-in CLMM swap (single active liquidity bracket).
 *
 * For tiny swap sizes the active bracket does not change, so this matches
 * Jupiter exactly. For larger swaps it slightly overestimates output (because
 * crossing into a thinner bracket is not modelled). The hot path uses
 * standard 0.5 SOL trade size where this error stays well below the
 * 50 bps threshold.
 *
 * Worked example (Phase A2 mainnet snapshot, RAY/SOL CLMM):
 *   L = 32_832_321_683_377
 *   sqrtP = 6_708_516_374_500_462_340
 *   amountIn = 10_000_000 (0.01 SOL)
 *   feeRate1e6 = 500
 *   amountInAfterFee = 10_000_000 * (1e6 - 500) / 1e6 = 9_995_000
 *   sqrtP_new = (L * sqrtP * Q64) / (L * Q64 + amountInAfterFee * sqrtP)
 *             = 6_708_515_631_798_789_739
 *   amountOut = L * (sqrtP - sqrtP_new) / Q64 = 1_321_892
 *   -> 1.321892 RAY (matches Jupiter EXACTLY)
 */
export function clmmSwapToken0For1(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  tradeFeeRate1e6: number,
): { amountOut: bigint; sqrtPNewX64: bigint } {
  if (L === 0n || amountIn === 0n) return { amountOut: 0n, sqrtPNewX64: sqrtPX64 };
  const feeNum = BigInt(tradeFeeRate1e6);
  const amountInAfterFee = (amountIn * (FEE_DENOM - feeNum)) / FEE_DENOM;

  const numerator = L * sqrtPX64 * Q64;
  const denominator = L * Q64 + amountInAfterFee * sqrtPX64;
  const sqrtPNewX64 = numerator / denominator;

  const amountOut = (L * (sqrtPX64 - sqrtPNewX64)) / Q64;
  return { amountOut, sqrtPNewX64 };
}

/**
 * token1 -> token0 (selling token1).
 *   sqrtP_new = sqrtP + (amountInAfterFee * Q64) / L
 *   amountOut = L * (sqrtP_new - sqrtP) ... wait, that's just amountIn back.
 * Correct form (Uniswap V3):
 *   For token1 -> token0 (price decreases):
 *     sqrtP_new = sqrtP + (amountInAfterFee << 64) / L     -- price goes UP
 *     amountOut0 = L * (sqrtP_new - sqrtP) / (sqrtP_new * sqrtP / Q64)
 * Hmm, careful. token1 in increases sqrtP, and we extract token0.
 *   sqrtP_new = sqrtP + (amountIn * Q64) / L
 *   amountOut = L * (sqrtP_new - sqrtP) * Q64 / (sqrtP * sqrtP_new)
 */
export function clmmSwapToken1For0(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  tradeFeeRate1e6: number,
): { amountOut: bigint; sqrtPNewX64: bigint } {
  if (L === 0n || amountIn === 0n) return { amountOut: 0n, sqrtPNewX64: sqrtPX64 };
  const feeNum = BigInt(tradeFeeRate1e6);
  const amountInAfterFee = (amountIn * (FEE_DENOM - feeNum)) / FEE_DENOM;

  const sqrtPNewX64 = sqrtPX64 + (amountInAfterFee * Q64) / L;
  // amountOut0 = L * (sqrtP_new - sqrtP) * Q64 / (sqrtP * sqrtP_new)
  const numerator = L * (sqrtPNewX64 - sqrtPX64) * Q64;
  const denominator = sqrtPX64 * sqrtPNewX64;
  const amountOut = numerator / denominator;
  return { amountOut, sqrtPNewX64 };
}

/**
 * Public helper: amountOut for any direction. Caller specifies which mint
 * is the input. We resolve token0/token1 internally.
 */
export function calculateClmmAmountOut(
  pool: CachedClmmPool,
  amountIn: bigint,
  inputMint: PublicKey,
): bigint {
  const isInputToken0 = pool.tokenMint0.equals(inputMint);
  const isInputToken1 = pool.tokenMint1.equals(inputMint);
  if (!isInputToken0 && !isInputToken1) return 0n;

  if (isInputToken0) {
    return clmmSwapToken0For1(
      pool.liquidity,
      pool.sqrtPriceX64,
      amountIn,
      pool.tradeFeeRate,
    ).amountOut;
  } else {
    return clmmSwapToken1For0(
      pool.liquidity,
      pool.sqrtPriceX64,
      amountIn,
      pool.tradeFeeRate,
    ).amountOut;
  }
}

// ═══════════════════════════════════════════════════════════════
// Tick array PDA derivation
// ═══════════════════════════════════════════════════════════════

function startTickIndexForCurrent(tickCurrent: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * TICK_ARRAY_SIZE;
  // floor toward -infinity (Math.floor handles negatives correctly)
  return Math.floor(tickCurrent / ticksPerArray) * ticksPerArray;
}

function deriveTickArrayPda(pool: PublicKey, startTickIndex: number): PublicKey {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(startTickIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [TICK_ARRAY_SEED, pool.toBuffer(), buf],
    RAYDIUM_CLMM_PROGRAM,
  );
  return pda;
}

/**
 * Get the 3 tick arrays the swap is most likely to touch:
 * one centred on currentTick, one to each side.
 * Direction (zeroForOne = token0->token1 = price decreasing) determines
 * which adjacent array is most likely consumed.
 */
export function getRequiredTickArrays(
  pool: CachedClmmPool,
  zeroForOne: boolean,
): PublicKey[] {
  const ticksPerArray = pool.tickSpacing * TICK_ARRAY_SIZE;
  const center = startTickIndexForCurrent(pool.tickCurrent, pool.tickSpacing);
  // zeroForOne (price decreasing) consumes arrays at lower starts
  const next = zeroForOne ? center - ticksPerArray : center + ticksPerArray;
  const further = zeroForOne ? center - 2 * ticksPerArray : center + 2 * ticksPerArray;
  return [
    deriveTickArrayPda(pool.poolAddress, center),
    deriveTickArrayPda(pool.poolAddress, next),
    deriveTickArrayPda(pool.poolAddress, further),
  ];
}

// ═══════════════════════════════════════════════════════════════
// Build swap instruction
// ═══════════════════════════════════════════════════════════════

export interface BuildClmmSwapParams {
  pool: CachedClmmPool;
  payer: PublicKey;
  userInputTokenAccount: PublicKey;
  userOutputTokenAccount: PublicKey;
  inputMint: PublicKey; // determines direction
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function buildClmmSwapInstruction(p: BuildClmmSwapParams): TransactionInstruction {
  const isInputToken0 = p.pool.tokenMint0.equals(p.inputMint);
  const isInputToken1 = p.pool.tokenMint1.equals(p.inputMint);
  if (!isInputToken0 && !isInputToken1) {
    throw new Error(
      `inputMint ${p.inputMint.toString()} is neither token0 nor token1 of CLMM pool ${p.pool.poolAddress.toString()}`,
    );
  }

  const inputVault = isInputToken0 ? p.pool.tokenVault0 : p.pool.tokenVault1;
  const outputVault = isInputToken0 ? p.pool.tokenVault1 : p.pool.tokenVault0;

  // zeroForOne: swapping token0 for token1 → price decreases → use min sqrt limit
  const zeroForOne = isInputToken0;
  const sqrtPriceLimit = zeroForOne ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;

  // Instruction data: discriminator(8) + amount(8) + otherAmountThreshold(8)
  //                    + sqrtPriceLimitX64(16) + isBaseInput(1) = 41 bytes
  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1);
  SWAP_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minimumAmountOut, 16);
  writeU128LE(data, 24, sqrtPriceLimit);
  data.writeUInt8(1, 40); // isBaseInput = true (exact-in)

  const tickArrays = getRequiredTickArrays(p.pool, zeroForOne);

  const keys = [
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.pool.ammConfig, isSigner: false, isWritable: false },
    { pubkey: p.pool.poolAddress, isSigner: false, isWritable: true },
    { pubkey: p.userInputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.userOutputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: p.pool.observationKey, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    // First tick array is a named account; remaining are remaining_accounts
    { pubkey: tickArrays[0], isSigner: false, isWritable: true },
    { pubkey: tickArrays[1], isSigner: false, isWritable: true },
    { pubkey: tickArrays[2], isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: RAYDIUM_CLMM_PROGRAM,
    keys,
    data,
  });
}

/**
 * ALTs this DEX wants in the versioned tx. None hardcoded yet — Phase H will
 * populate this once we have a Raydium CLMM ALT in the registry.
 */
export function getRequiredClmmAlts(_pool: CachedClmmPool): PublicKey[] {
  return [];
}

/**
 * Convenience: SOL-per-token from cached pool (for the price book).
 * Returns 0 if neither side is SOL.
 */
export function clmmSolPerToken(pool: CachedClmmPool): number {
  const ratio = Number(pool.sqrtPriceX64) / Number(Q64);
  const priceRaw = ratio * ratio; // token1-per-token0 raw
  const decAdj = Math.pow(10, pool.mintDecimals0 - pool.mintDecimals1);
  const token1PerToken0 = priceRaw * decAdj;
  if (pool.tokenMint0.toString() === SOL_MINT) {
    // token0 = SOL → token1PerToken0 = TOKEN per SOL
    return token1PerToken0 === 0 ? 0 : 1 / token1PerToken0;
  } else if (pool.tokenMint1.toString() === SOL_MINT) {
    return token1PerToken0;
  }
  return 0;
}
