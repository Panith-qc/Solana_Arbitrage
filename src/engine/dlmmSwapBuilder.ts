// METEORA DLMM (LB CLMM) SWAP BUILDER
// Builds raw Meteora DLMM swap instructions from cached LbPair state — no
// SDK, no Jupiter. Phase D3 of multi-DEX expansion. Math = single-active-bin
// approximation verified vs Jupiter in src/engine/research/test-dlmm-swap.ts
// (D2: -5.43 bps drift). Multi-bin traversal for large amounts is documented
// inline as a known limitation; for the small (≤2 SOL) sizes the bot trades,
// the active bin almost always holds enough liquidity.
//
// References:
//   - https://github.com/MeteoraAg/dlmm-sdk
//   - programs/lb_clmm/src/state/lb_pair.rs
//   - ts-client/src/dlmm/idl/idl.json
//
// Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
// Account: LbPair (1208 bytes; first 8 bytes Anchor discriminator).
// Layout offsets (post-disc) — see dlmm-layout.ts for full doc.
//
// Swap instruction (from IDL `swap`):
//   discriminator = [248,198,158,145,225,117,135,200]   (NOT a global:* hash)
//   args = (amount_in: u64, min_amount_out: u64)
//   accounts (15 fixed + bin-array remaining accounts):
//     0  lb_pair                    (W)
//     1  bin_array_bitmap_extension (R, optional — pass program id if null)
//     2  reserve_x                  (W)
//     3  reserve_y                  (W)
//     4  user_token_in              (W)
//     5  user_token_out             (W)
//     6  token_x_mint               (R)
//     7  token_y_mint               (R)
//     8  oracle                     (W)
//     9  host_fee_in                (W, optional — pass program id if null)
//    10  user                       (signer, W)
//    11  token_x_program            (R)
//    12  token_y_program            (R)
//    13  event_authority            (R) — PDA seeds=["__event_authority"]
//    14  program                    (R) — the DLMM program itself
//   + remaining accounts: bin_array_lower, bin_array_active, bin_array_upper
//     (W) — derived from active_id via floor(active_id/70).
//
// BinArray PDA:
//   seeds = ["bin_array", lb_pair, i64_le(bin_array_index)]
//   bin_array_index = Math.floor(active_id / 70)  (signed; 70 = MAX_BIN_PER_ARRAY)

import {
  PublicKey,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import { executionLog } from './logger.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

export const METEORA_DLMM_PROGRAM = new PublicKey(
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
);

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const MAX_BIN_PER_ARRAY = 70;
const BIN_ARRAY_SEED = Buffer.from('bin_array');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

// LbPair body offsets (post 8-byte Anchor discriminator)
const LB = {
  BASE_FACTOR:           0,    // u16 (StaticParameters.base_factor)
  VARIABLE_FEE_CONTROL:  8,    // u32
  VOL_ACCUMULATOR:       32,   // u32 (VariableParameters.volatility_accumulator)
  ACTIVE_ID:             68,   // i32
  BIN_STEP:              72,   // u16
  STATUS:                74,   // u8
  TOKEN_X_MINT:          80,   // Pubkey
  TOKEN_Y_MINT:          112,  // Pubkey
  RESERVE_X:             144,  // Pubkey (vault)
  RESERVE_Y:             176,  // Pubkey (vault)
  PROTOCOL_FEE_X:        208,  // u64
  PROTOCOL_FEE_Y:        216,  // u64
  ORACLE:                544,  // Pubkey
  TOKEN_X_PROGRAM_FLAG:  872,  // u8
  TOKEN_Y_PROGRAM_FLAG:  873,  // u8
} as const;

const LBPAIR_DISC_LEN = 8;
const LBPAIR_MIN_LEN = LBPAIR_DISC_LEN + 880; // first 880 bytes cover all fields we read

// SPL Token account amount field
const SPL_TOKEN_AMOUNT_OFFSET = 64;

// Token program IDs (DLMM IDL hardcodes SPL Token; Token-2022 isn't supported by `swap`)
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// `swap` instruction discriminator from IDL — NOT sha256("global:swap").
const SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CachedDlmmPool {
  poolAddress: PublicKey;
  // Static identifiers
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
  decimalsX: number;
  decimalsY: number;
  // Mutable swap state (refreshed via WS)
  activeId: number;        // i32
  binStep: number;         // u16, basis points
  baseFactor: number;      // u16
  variableFeeControl: number; // u32
  volatilityAccumulator: number; // u32
  status: number;
  vaultXAmount: bigint;
  vaultYAmount: bigint;
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  // Derived/cached
  eventAuthority: PublicKey;
  label: string;
}

const dlmmCache = new Map<string, CachedDlmmPool>();
// Reverse vault index for WS routing
const vaultToDlmmPool = new Map<string, { pool: string; side: 'x' | 'y' }>();

export function getCachedDlmmPool(addr: string): CachedDlmmPool | undefined {
  return dlmmCache.get(addr);
}

export function getDlmmPoolByVault(vault: string): { pool: string; side: 'x' | 'y' } | undefined {
  return vaultToDlmmPool.get(vault);
}

export function getAllCachedDlmmVaults(): string[] {
  return Array.from(vaultToDlmmPool.keys());
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}

function deriveEventAuthority(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], METEORA_DLMM_PROGRAM);
  return pda;
}

const DLMM_EVENT_AUTHORITY = deriveEventAuthority();

/**
 * Bin-array index for a given bin id. Floor division (handles negatives).
 *   idx = floor(bin_id / MAX_BIN_PER_ARRAY)
 */
export function binArrayIndex(binId: number): number {
  return Math.floor(binId / MAX_BIN_PER_ARRAY);
}

/**
 * Derive a BinArray PDA. The bin_array_index is encoded as i64 LE.
 */
export function deriveBinArrayPda(lbPair: PublicKey, index: number): PublicKey {
  const buf = Buffer.alloc(8);
  // i64 LE: BigInt handles signed via two's complement when written as u64
  buf.writeBigInt64LE(BigInt(index), 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [BIN_ARRAY_SEED, lbPair.toBuffer(), buf],
    METEORA_DLMM_PROGRAM,
  );
  return pda;
}

// ═══════════════════════════════════════════════════════════════
// Cache pool data
// ═══════════════════════════════════════════════════════════════

export async function cacheDlmmPoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
): Promise<CachedDlmmPool | null> {
  try {
    const poolPk = new PublicKey(poolAddress);
    const acct = await connection.getAccountInfo(poolPk);
    if (!acct?.data || acct.data.length < LBPAIR_MIN_LEN) {
      executionLog.warn(
        { pool: poolAddress, len: acct?.data?.length },
        'DLMM LbPair account too small',
      );
      return null;
    }
    if (!acct.owner.equals(METEORA_DLMM_PROGRAM)) {
      executionLog.warn(
        { pool: poolAddress, owner: acct.owner.toString() },
        'Pool not owned by Meteora DLMM program',
      );
      return null;
    }

    const body = acct.data.subarray(LBPAIR_DISC_LEN);
    const tokenXMint = readPubkey(body, LB.TOKEN_X_MINT);
    const tokenYMint = readPubkey(body, LB.TOKEN_Y_MINT);
    const reserveX = readPubkey(body, LB.RESERVE_X);
    const reserveY = readPubkey(body, LB.RESERVE_Y);
    const oracle = readPubkey(body, LB.ORACLE);

    // Token-2022 not supported by the standard `swap` instruction.
    const xFlag = body.readUInt8(LB.TOKEN_X_PROGRAM_FLAG);
    const yFlag = body.readUInt8(LB.TOKEN_Y_PROGRAM_FLAG);
    if (xFlag !== 0 || yFlag !== 0) {
      executionLog.warn(
        { pool: poolAddress, xFlag, yFlag },
        'DLMM pool uses Token-2022 — not supported by current swap builder',
      );
      return null;
    }

    // Fetch mint decimals from SPL Mint accounts (offset 44)
    const [mintXAcct, mintYAcct] = await Promise.all([
      connection.getAccountInfo(tokenXMint),
      connection.getAccountInfo(tokenYMint),
    ]);
    if (!mintXAcct?.data || !mintYAcct?.data) {
      executionLog.warn({ pool: poolAddress }, 'DLMM mint fetch returned empty');
      return null;
    }
    const decimalsX = mintXAcct.data.readUInt8(44);
    const decimalsY = mintYAcct.data.readUInt8(44);

    // Fetch vault balances
    const [vx, vy] = await Promise.all([
      connection.getAccountInfo(reserveX),
      connection.getAccountInfo(reserveY),
    ]);
    if (!vx?.data || !vy?.data) {
      executionLog.warn({ pool: poolAddress }, 'DLMM vault fetch returned empty');
      return null;
    }
    const vaultXAmount = vx.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    const vaultYAmount = vy.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);

    const cached: CachedDlmmPool = {
      poolAddress: poolPk,
      tokenXMint,
      tokenYMint,
      reserveX,
      reserveY,
      oracle,
      decimalsX,
      decimalsY,
      activeId: body.readInt32LE(LB.ACTIVE_ID),
      binStep: body.readUInt16LE(LB.BIN_STEP),
      baseFactor: body.readUInt16LE(LB.BASE_FACTOR),
      variableFeeControl: body.readUInt32LE(LB.VARIABLE_FEE_CONTROL),
      volatilityAccumulator: body.readUInt32LE(LB.VOL_ACCUMULATOR),
      status: body.readUInt8(LB.STATUS),
      vaultXAmount,
      vaultYAmount,
      protocolFeeX: body.readBigUInt64LE(LB.PROTOCOL_FEE_X),
      protocolFeeY: body.readBigUInt64LE(LB.PROTOCOL_FEE_Y),
      eventAuthority: DLMM_EVENT_AUTHORITY,
      label,
    };
    dlmmCache.set(poolAddress, cached);
    vaultToDlmmPool.set(reserveX.toString(), { pool: poolAddress, side: 'x' });
    vaultToDlmmPool.set(reserveY.toString(), { pool: poolAddress, side: 'y' });

    executionLog.info(
      {
        pool: label,
        activeId: cached.activeId,
        binStep: cached.binStep,
        vaultX: vaultXAmount.toString(),
        vaultY: vaultYAmount.toString(),
      },
      'DLMM pool cached',
    );
    return cached;
  } catch (err: any) {
    executionLog.error(
      { err: err?.message, pool: poolAddress },
      'Failed to cache DLMM pool',
    );
    return null;
  }
}

/**
 * Refresh mutable LbPair fields from a fresh account buffer (WS push).
 * Updates active_id, bin_step (rare but allowed), volatility_accumulator,
 * protocol fees, status. Vault balances are refreshed separately via
 * updateCachedDlmmVault().
 */
export function updateCachedDlmmFromAccount(poolAddress: string, data: Buffer): void {
  try {
    const cached = dlmmCache.get(poolAddress);
    if (!cached) return;
    if (data.length < LBPAIR_MIN_LEN) return;
    const body = data.subarray(LBPAIR_DISC_LEN);
    cached.activeId = body.readInt32LE(LB.ACTIVE_ID);
    cached.binStep = body.readUInt16LE(LB.BIN_STEP);
    cached.baseFactor = body.readUInt16LE(LB.BASE_FACTOR);
    cached.variableFeeControl = body.readUInt32LE(LB.VARIABLE_FEE_CONTROL);
    cached.volatilityAccumulator = body.readUInt32LE(LB.VOL_ACCUMULATOR);
    cached.status = body.readUInt8(LB.STATUS);
    cached.protocolFeeX = body.readBigUInt64LE(LB.PROTOCOL_FEE_X);
    cached.protocolFeeY = body.readBigUInt64LE(LB.PROTOCOL_FEE_Y);
  } catch (err: any) {
    executionLog.warn({ err: err?.message, pool: poolAddress }, 'DLMM pool refresh failed');
  }
}

/**
 * Refresh a vault SPL balance from a fresh token account buffer.
 */
export function updateCachedDlmmVault(vaultAddress: string, data: Buffer): void {
  try {
    const ref = vaultToDlmmPool.get(vaultAddress);
    if (!ref) return;
    const cached = dlmmCache.get(ref.pool);
    if (!cached) return;
    if (data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return;
    const amount = data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    if (ref.side === 'x') cached.vaultXAmount = amount;
    else cached.vaultYAmount = amount;
  } catch (err: any) {
    executionLog.warn({ err: err?.message, vault: vaultAddress }, 'DLMM vault refresh failed');
  }
}

// ═══════════════════════════════════════════════════════════════
// Math (single active bin — verified vs Jupiter in D2 at -5.43 bps)
// ═══════════════════════════════════════════════════════════════

/**
 * Single-active-bin DLMM swap simulator.
 *
 * NOTE: ignores variable fee + bin traversal. Accurate for small amounts
 * that stay within the active bin (typical for ≤2 SOL arbitrage). For
 * larger amounts the actual on-chain swap will traverse adjacent bins;
 * the executor passes 3 bin arrays to the swap IX so the chain handles
 * traversal correctly even if our quote is slightly conservative.
 *
 * Returns the expected output amount in raw base units.
 */
export function dlmmSwapSingleBin(
  amountIn: bigint,
  swapXForY: boolean,
  activeId: number,
  binStep: number,
  baseFactor: number,
): bigint {
  if (amountIn === 0n) return 0n;
  const factor = 1 + binStep / 10_000;
  const priceYperX = Math.pow(factor, activeId);
  const baseFeeBps = (baseFactor * binStep) / 10_000;
  const feeMul = 1 - baseFeeBps / 10_000;
  const amountInF = Number(amountIn);
  const outF = swapXForY
    ? amountInF * feeMul * priceYperX
    : (amountInF * feeMul) / priceYperX;
  if (!isFinite(outF) || outF < 0) return 0n;
  return BigInt(Math.floor(outF));
}

export function calculateDlmmAmountOut(
  pool: CachedDlmmPool,
  amountIn: bigint,
  inputMint: PublicKey,
): bigint {
  const isX = pool.tokenXMint.equals(inputMint);
  const isY = pool.tokenYMint.equals(inputMint);
  if (!isX && !isY) return 0n;
  return dlmmSwapSingleBin(amountIn, isX, pool.activeId, pool.binStep, pool.baseFactor);
}

// ═══════════════════════════════════════════════════════════════
// Build swap instruction
// ═══════════════════════════════════════════════════════════════

export interface BuildDlmmSwapParams {
  pool: CachedDlmmPool;
  payer: PublicKey;
  userInputTokenAccount: PublicKey;
  userOutputTokenAccount: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function buildDlmmSwapInstruction(p: BuildDlmmSwapParams): TransactionInstruction {
  const isX = p.pool.tokenXMint.equals(p.inputMint);
  const isY = p.pool.tokenYMint.equals(p.inputMint);
  if (!isX && !isY) {
    throw new Error(
      `inputMint ${p.inputMint.toString()} not in DLMM pool ${p.pool.poolAddress.toString()}`,
    );
  }

  // Pass 3 bin arrays around the active bin so the on-chain swap can
  // traverse outward from active_id in either direction.
  const activeIdx = binArrayIndex(p.pool.activeId);
  const binArrayLower = deriveBinArrayPda(p.pool.poolAddress, activeIdx - 1);
  const binArrayActive = deriveBinArrayPda(p.pool.poolAddress, activeIdx);
  const binArrayUpper = deriveBinArrayPda(p.pool.poolAddress, activeIdx + 1);

  // Instruction data: 8-byte discriminator + amount_in (u64) + min_out (u64)
  const data = Buffer.alloc(8 + 8 + 8);
  SWAP_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minimumAmountOut, 16);

  // Optional accounts (bin_array_bitmap_extension, host_fee_in) are passed
  // as the program id when null per Anchor convention.
  const optionalNull = METEORA_DLMM_PROGRAM;

  const keys = [
    { pubkey: p.pool.poolAddress, isSigner: false, isWritable: true },
    { pubkey: optionalNull, isSigner: false, isWritable: false }, // bin_array_bitmap_extension
    { pubkey: p.pool.reserveX, isSigner: false, isWritable: true },
    { pubkey: p.pool.reserveY, isSigner: false, isWritable: true },
    { pubkey: p.userInputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.userOutputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.pool.tokenXMint, isSigner: false, isWritable: false },
    { pubkey: p.pool.tokenYMint, isSigner: false, isWritable: false },
    { pubkey: p.pool.oracle, isSigner: false, isWritable: true },
    { pubkey: optionalNull, isSigner: false, isWritable: false }, // host_fee_in
    { pubkey: p.payer, isSigner: true, isWritable: true },        // user
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: p.pool.eventAuthority, isSigner: false, isWritable: false },
    { pubkey: METEORA_DLMM_PROGRAM, isSigner: false, isWritable: false },
    // remaining: 3 bin arrays for traversal
    { pubkey: binArrayLower, isSigner: false, isWritable: true },
    { pubkey: binArrayActive, isSigner: false, isWritable: true },
    { pubkey: binArrayUpper, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: METEORA_DLMM_PROGRAM,
    keys,
    data,
  });
}

export function getRequiredDlmmAlts(_pool: CachedDlmmPool): PublicKey[] {
  return [];
}

// ═══════════════════════════════════════════════════════════════
// Price book
// ═══════════════════════════════════════════════════════════════

/**
 * SOL-per-token from cached DLMM (for the price book). Uses the active-bin
 * price and inverts based on which side SOL sits on.
 */
export function dlmmSolPerToken(pool: CachedDlmmPool): number {
  const xIsSol = pool.tokenXMint.toString() === SOL_MINT;
  const yIsSol = pool.tokenYMint.toString() === SOL_MINT;
  if (!xIsSol && !yIsSol) return 0;
  const factor = 1 + pool.binStep / 10_000;
  const priceYperX_raw = Math.pow(factor, pool.activeId);
  if (!isFinite(priceYperX_raw) || priceYperX_raw <= 0) return 0;
  // Convert raw Y/X to human SOL/token.
  // Human price (Y per X) = raw * 10^decX / 10^decY
  const humanYperX = priceYperX_raw * Math.pow(10, pool.decimalsX - pool.decimalsY);
  if (xIsSol) {
    // X = SOL, Y = token. SOL per token = 1 / (Y per X) = 1 / humanYperX
    return humanYperX === 0 ? 0 : 1 / humanYperX;
  }
  // Y = SOL, X = token. SOL per token = humanYperX
  return humanYperX;
}
