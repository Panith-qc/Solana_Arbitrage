// ORCA WHIRLPOOL SWAP BUILDER
// Builds raw Orca Whirlpool swap instructions from cached pool state — no SDK,
// no Jupiter. Same hot-path role as clmmSwapBuilder.ts but for Whirlpool pools.
//
// Phase B3 of multi-DEX expansion. Math identical to Raydium CLMM (Uniswap V3
// constant-L); verified vs Jupiter in src/engine/research/test-whirlpool-swap.ts.
//
// References:
//   - https://github.com/orca-so/whirlpools
//   - Uniswap V3 whitepaper §6.2.1/6.2.2
//
// Whirlpool account layout (post 8-byte Anchor discriminator):
//   off   8  whirlpoolsConfig         Pubkey (32)
//   off  40  whirlpoolBump            u8     (1)
//   off  41  tickSpacing              u16    (2)
//   off  43  tickSpacingSeed          [u8;2] (2)
//   off  45  feeRate                  u16    (2)   // 1/100 bps. 3000 = 30 bps = 0.30%
//   off  47  protocolFeeRate          u16    (2)
//   off  49  liquidity                u128   (16)
//   off  65  sqrtPrice                u128   (16)  // Q64.64
//   off  81  tickCurrentIndex         i32    (4)
//   off  85  protocolFeeOwedA         u64    (8)
//   off  93  protocolFeeOwedB         u64    (8)
//   off 101  tokenMintA               Pubkey (32)
//   off 133  tokenVaultA              Pubkey (32)
//   off 165  feeGrowthGlobalA         u128   (16)
//   off 181  tokenMintB               Pubkey (32)
//   off 213  tokenVaultB              Pubkey (32)
//   off 245  feeGrowthGlobalB         u128   (16)
//
// Whirlpool `swap` instruction (NOT swapV2):
//   discriminator = sha256("global:swap")[:8]
//   args:
//     amount: u64
//     otherAmountThreshold: u64
//     sqrtPriceLimit: u128
//     amountSpecifiedIsInput: bool
//     aToB: bool
//   accounts (11):
//     0  tokenProgram         (read)
//     1  tokenAuthority       (signer)
//     2  whirlpool            (writable)
//     3  tokenOwnerAccountA   (writable)
//     4  tokenVaultA          (writable)
//     5  tokenOwnerAccountB   (writable)
//     6  tokenVaultB          (writable)
//     7  tickArray0           (writable)
//     8  tickArray1           (writable)
//     9  tickArray2           (writable)
//    10  oracle               (writable)
//
// Tick array PDA (CRITICAL — different from Raydium CLMM):
//   seeds = ["tick_array", whirlpool, ASCII decimal string of start_tick_index]
//   start_tick_index = floor(currentTick / (tickSpacing * TICK_ARRAY_SIZE))
//                       * (tickSpacing * TICK_ARRAY_SIZE)
//   TICK_ARRAY_SIZE = 88
//
// Oracle PDA:
//   seeds = ["oracle", whirlpool]

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

export const ORCA_WHIRLPOOL_PROGRAM = new PublicKey(
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
);

const TICK_ARRAY_SIZE = 88;
const TICK_ARRAY_SEED = Buffer.from('tick_array');
const ORACLE_SEED = Buffer.from('oracle');

// Whirlpool account offsets
const POOL = {
  WHIRLPOOLS_CONFIG: 8,
  TICK_SPACING: 41,
  FEE_RATE: 45,           // u16, 1e6 denom
  LIQUIDITY: 49,          // u128
  SQRT_PRICE: 65,         // u128 Q64.64
  TICK_CURRENT_INDEX: 81, // i32
  TOKEN_MINT_A: 101,
  TOKEN_VAULT_A: 133,
  TOKEN_MINT_B: 181,
  TOKEN_VAULT_B: 213,
  MIN_DATA_LENGTH: 261,
} as const;

const FEE_DENOM = 1_000_000n;
const Q64 = 1n << 64n;

// Anchor discriminator for "swap" method = sha256("global:swap")[:8]
const SWAP_DISCRIMINATOR = createHash('sha256')
  .update('global:swap')
  .digest()
  .subarray(0, 8);

// Sqrt price limits (from whirlpools tick_math)
const MIN_SQRT_PRICE_X64 = 4_295_048_016n;
const MAX_SQRT_PRICE_X64 = 79_226_673_521_066_979_257_578_248_091n;

// SPL Mint account: decimals at byte 44
const MINT_DECIMALS_OFFSET = 44;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CachedWhirlpoolPool {
  poolAddress: PublicKey;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  // Decimals are NOT stored in the pool — fetched from SPL Mint at startup
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
  // Mutable on-chain state — refreshed by WebSocket on pool account changes
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  // Fee from pool itself (1e6 denom). 3000 = 30 bps.
  feeRate: number;
  feeBps: number;
  // Pre-derived oracle PDA (immutable for life of pool)
  oracle: PublicKey;
  label: string;
}

const whirlpoolCache = new Map<string, CachedWhirlpoolPool>();

export function getCachedWhirlpoolPool(addr: string): CachedWhirlpoolPool | undefined {
  return whirlpoolCache.get(addr);
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

function deriveOraclePda(whirlpool: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [ORACLE_SEED, whirlpool.toBuffer()],
    ORCA_WHIRLPOOL_PROGRAM,
  );
  return pda;
}

// ═══════════════════════════════════════════════════════════════
// Cache pool data — fetch Whirlpool + both Mints once at startup
// ═══════════════════════════════════════════════════════════════

export async function cacheWhirlpoolPoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
): Promise<CachedWhirlpoolPool | null> {
  try {
    const poolPk = new PublicKey(poolAddress);
    const poolAcct = await connection.getAccountInfo(poolPk);
    if (!poolAcct?.data || poolAcct.data.length < POOL.MIN_DATA_LENGTH) {
      executionLog.warn(
        { pool: poolAddress, len: poolAcct?.data?.length },
        'Whirlpool account too small',
      );
      return null;
    }
    if (!poolAcct.owner.equals(ORCA_WHIRLPOOL_PROGRAM)) {
      executionLog.warn(
        { pool: poolAddress, owner: poolAcct.owner.toString() },
        'Pool not owned by Orca Whirlpool program',
      );
      return null;
    }

    const data = poolAcct.data;
    const tickSpacing = data.readUInt16LE(POOL.TICK_SPACING);
    const feeRate = data.readUInt16LE(POOL.FEE_RATE);
    const liquidity = readU128LE(data, POOL.LIQUIDITY);
    const sqrtPrice = readU128LE(data, POOL.SQRT_PRICE);
    const tickCurrentIndex = data.readInt32LE(POOL.TICK_CURRENT_INDEX);
    const tokenMintA = readPubkey(data, POOL.TOKEN_MINT_A);
    const tokenVaultA = readPubkey(data, POOL.TOKEN_VAULT_A);
    const tokenMintB = readPubkey(data, POOL.TOKEN_MINT_B);
    const tokenVaultB = readPubkey(data, POOL.TOKEN_VAULT_B);

    // Whirlpool does NOT store mint decimals — fetch SPL Mint accounts
    let decimalsA: number;
    let decimalsB: number;
    try {
      const [mintA, mintB] = await Promise.all([
        connection.getAccountInfo(tokenMintA),
        connection.getAccountInfo(tokenMintB),
      ]);
      if (!mintA?.data || !mintB?.data) {
        executionLog.warn({ pool: poolAddress }, 'Failed to fetch Whirlpool mint accounts');
        return null;
      }
      decimalsA = mintA.data.readUInt8(MINT_DECIMALS_OFFSET);
      decimalsB = mintB.data.readUInt8(MINT_DECIMALS_OFFSET);
    } catch (err: any) {
      executionLog.error({ err: err?.message, pool: poolAddress }, 'Whirlpool mint fetch failed');
      return null;
    }

    const feeBps = feeRate / 100;
    const oracle = deriveOraclePda(poolPk);

    const cached: CachedWhirlpoolPool = {
      poolAddress: poolPk,
      tokenMintA,
      tokenMintB,
      tokenVaultA,
      tokenVaultB,
      decimalsA,
      decimalsB,
      tickSpacing,
      liquidity,
      sqrtPrice,
      tickCurrentIndex,
      feeRate,
      feeBps,
      oracle,
      label,
    };
    whirlpoolCache.set(poolAddress, cached);

    executionLog.info(
      {
        pool: label,
        sqrtPrice: sqrtPrice.toString(),
        liquidity: liquidity.toString(),
        tickCurrentIndex,
        feeBps,
        tickSpacing,
      },
      'Whirlpool cached',
    );
    return cached;
  } catch (err: any) {
    executionLog.error(
      { err: err?.message, pool: poolAddress },
      'Failed to cache Whirlpool',
    );
    return null;
  }
}

/**
 * Update mutable state from a fresh Whirlpool account buffer.
 * Called by poolMonitor when WebSocket pushes a pool account change.
 */
export function updateCachedWhirlpoolFromAccount(
  poolAddress: string,
  data: Buffer,
): void {
  try {
    const cached = whirlpoolCache.get(poolAddress);
    if (!cached) return;
    if (data.length < POOL.MIN_DATA_LENGTH) return;
    cached.liquidity = readU128LE(data, POOL.LIQUIDITY);
    cached.sqrtPrice = readU128LE(data, POOL.SQRT_PRICE);
    cached.tickCurrentIndex = data.readInt32LE(POOL.TICK_CURRENT_INDEX);
  } catch (err: any) {
    executionLog.warn({ err: err?.message, pool: poolAddress }, 'Whirlpool refresh failed');
  }
}

// ═══════════════════════════════════════════════════════════════
// Math (verified vs Jupiter in B2)
// ═══════════════════════════════════════════════════════════════

/**
 * Whirlpool exact-in, tokenA -> tokenB. Price (B per A) decreases.
 *
 *   amountInAfterFee = amountIn * (1e6 - feeRate) / 1e6
 *   sqrtP_new = (L * sqrtP * Q64) / (L * Q64 + amountInAfterFee * sqrtP)
 *   amountOut = L * (sqrtP - sqrtP_new) / Q64
 */
export function whirlpoolSwapAToB(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  feeRate1e6: number,
): { amountOut: bigint; sqrtPNewX64: bigint } {
  if (L === 0n || amountIn === 0n) return { amountOut: 0n, sqrtPNewX64: sqrtPX64 };
  const amountInAfterFee = (amountIn * (FEE_DENOM - BigInt(feeRate1e6))) / FEE_DENOM;
  const numerator = L * sqrtPX64 * Q64;
  const denominator = L * Q64 + amountInAfterFee * sqrtPX64;
  const sqrtPNewX64 = numerator / denominator;
  const amountOut = (L * (sqrtPX64 - sqrtPNewX64)) / Q64;
  return { amountOut, sqrtPNewX64 };
}

/**
 * Whirlpool exact-in, tokenB -> tokenA. Price increases.
 *
 *   sqrtP_new = sqrtP + (amountInAfterFee * Q64) / L
 *   amountOut = L * (sqrtP_new - sqrtP) * Q64 / (sqrtP_new * sqrtP)
 */
export function whirlpoolSwapBToA(
  L: bigint,
  sqrtPX64: bigint,
  amountIn: bigint,
  feeRate1e6: number,
): { amountOut: bigint; sqrtPNewX64: bigint } {
  if (L === 0n || amountIn === 0n) return { amountOut: 0n, sqrtPNewX64: sqrtPX64 };
  const amountInAfterFee = (amountIn * (FEE_DENOM - BigInt(feeRate1e6))) / FEE_DENOM;
  const sqrtPNewX64 = sqrtPX64 + (amountInAfterFee * Q64) / L;
  const numerator = L * (sqrtPNewX64 - sqrtPX64) * Q64;
  const denominator = sqrtPNewX64 * sqrtPX64;
  const amountOut = numerator / denominator;
  return { amountOut, sqrtPNewX64 };
}

/**
 * Public helper: amountOut for any direction. Caller specifies inputMint.
 */
export function calculateWhirlpoolAmountOut(
  pool: CachedWhirlpoolPool,
  amountIn: bigint,
  inputMint: PublicKey,
): bigint {
  const isInputA = pool.tokenMintA.equals(inputMint);
  const isInputB = pool.tokenMintB.equals(inputMint);
  if (!isInputA && !isInputB) return 0n;

  if (isInputA) {
    return whirlpoolSwapAToB(pool.liquidity, pool.sqrtPrice, amountIn, pool.feeRate).amountOut;
  } else {
    return whirlpoolSwapBToA(pool.liquidity, pool.sqrtPrice, amountIn, pool.feeRate).amountOut;
  }
}

// ═══════════════════════════════════════════════════════════════
// Tick array PDA derivation (Whirlpool uses ASCII decimal string seeds)
// ═══════════════════════════════════════════════════════════════

function startTickIndexForCurrent(tickCurrent: number, tickSpacing: number): number {
  const ticksPerArray = tickSpacing * TICK_ARRAY_SIZE;
  return Math.floor(tickCurrent / ticksPerArray) * ticksPerArray;
}

function deriveTickArrayPda(pool: PublicKey, startTickIndex: number): PublicKey {
  // Whirlpool seed is the ASCII decimal string of the int, NOT BE bytes.
  // Reference: orca-so/whirlpools-sdk PDAUtil.getTickArray
  const seedStr = Buffer.from(startTickIndex.toString());
  const [pda] = PublicKey.findProgramAddressSync(
    [TICK_ARRAY_SEED, pool.toBuffer(), seedStr],
    ORCA_WHIRLPOOL_PROGRAM,
  );
  return pda;
}

/**
 * Get the 3 tick arrays the swap is most likely to touch:
 * one centred on currentTick, two further in the swap direction.
 * aToB (price decreasing) consumes arrays at lower start indices.
 */
export function getRequiredWhirlpoolTickArrays(
  pool: CachedWhirlpoolPool,
  aToB: boolean,
): PublicKey[] {
  const ticksPerArray = pool.tickSpacing * TICK_ARRAY_SIZE;
  const center = startTickIndexForCurrent(pool.tickCurrentIndex, pool.tickSpacing);
  const next = aToB ? center - ticksPerArray : center + ticksPerArray;
  const further = aToB ? center - 2 * ticksPerArray : center + 2 * ticksPerArray;
  return [
    deriveTickArrayPda(pool.poolAddress, center),
    deriveTickArrayPda(pool.poolAddress, next),
    deriveTickArrayPda(pool.poolAddress, further),
  ];
}

// ═══════════════════════════════════════════════════════════════
// Build swap instruction
// ═══════════════════════════════════════════════════════════════

export interface BuildWhirlpoolSwapParams {
  pool: CachedWhirlpoolPool;
  payer: PublicKey;
  userTokenAccountA: PublicKey;
  userTokenAccountB: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function buildWhirlpoolSwapInstruction(p: BuildWhirlpoolSwapParams): TransactionInstruction {
  const isInputA = p.pool.tokenMintA.equals(p.inputMint);
  const isInputB = p.pool.tokenMintB.equals(p.inputMint);
  if (!isInputA && !isInputB) {
    throw new Error(
      `inputMint ${p.inputMint.toString()} is neither tokenA nor tokenB of Whirlpool ${p.pool.poolAddress.toString()}`,
    );
  }

  // aToB: swapping A for B → price decreases → use min sqrt limit
  const aToB = isInputA;
  const sqrtPriceLimit = aToB ? MIN_SQRT_PRICE_X64 + 1n : MAX_SQRT_PRICE_X64 - 1n;

  // Instruction data: discriminator(8) + amount(8) + otherAmountThreshold(8)
  //                    + sqrtPriceLimit(16) + amountSpecifiedIsInput(1) + aToB(1)
  //                  = 42 bytes
  const data = Buffer.alloc(8 + 8 + 8 + 16 + 1 + 1);
  SWAP_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minimumAmountOut, 16);
  writeU128LE(data, 24, sqrtPriceLimit);
  data.writeUInt8(1, 40); // amountSpecifiedIsInput = true (exact-in)
  data.writeUInt8(aToB ? 1 : 0, 41);

  const tickArrays = getRequiredWhirlpoolTickArrays(p.pool, aToB);

  // 11 accounts in fixed order. NOT remaining_accounts — all named.
  const keys = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: p.payer, isSigner: true, isWritable: false },
    { pubkey: p.pool.poolAddress, isSigner: false, isWritable: true },
    { pubkey: p.userTokenAccountA, isSigner: false, isWritable: true },
    { pubkey: p.pool.tokenVaultA, isSigner: false, isWritable: true },
    { pubkey: p.userTokenAccountB, isSigner: false, isWritable: true },
    { pubkey: p.pool.tokenVaultB, isSigner: false, isWritable: true },
    { pubkey: tickArrays[0], isSigner: false, isWritable: true },
    { pubkey: tickArrays[1], isSigner: false, isWritable: true },
    { pubkey: tickArrays[2], isSigner: false, isWritable: true },
    { pubkey: p.pool.oracle, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: ORCA_WHIRLPOOL_PROGRAM,
    keys,
    data,
  });
}

/**
 * ALTs this DEX wants in the versioned tx. None hardcoded yet — Phase H will
 * populate this once we have an Orca Whirlpool ALT in the registry.
 */
export function getRequiredWhirlpoolAlts(_pool: CachedWhirlpoolPool): PublicKey[] {
  return [];
}

/**
 * SOL-per-token from cached Whirlpool (for the price book).
 * Returns 0 if neither side is SOL.
 */
export function whirlpoolSolPerToken(pool: CachedWhirlpoolPool): number {
  const ratio = Number(pool.sqrtPrice) / Number(Q64);
  const priceRaw = ratio * ratio; // tokenB-per-tokenA, raw atomic
  const decAdj = Math.pow(10, pool.decimalsA - pool.decimalsB);
  const bPerA = priceRaw * decAdj; // human B per human A
  if (pool.tokenMintA.toString() === SOL_MINT) {
    // A = SOL → bPerA = TOKEN per SOL
    return bPerA === 0 ? 0 : 1 / bPerA;
  } else if (pool.tokenMintB.toString() === SOL_MINT) {
    // B = SOL → bPerA = SOL per TOKEN
    return bPerA;
  }
  return 0;
}
