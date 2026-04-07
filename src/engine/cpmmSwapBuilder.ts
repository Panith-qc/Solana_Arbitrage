// RAYDIUM CPMM SWAP BUILDER
// Builds raw Raydium CPMM (Constant Product MM) swap instructions from cached
// pool state — no SDK, no Jupiter. Same hot-path role as clmmSwapBuilder.ts
// but for the new Anchor-based CPMM program.
//
// Phase C3 of multi-DEX expansion. Math = Uniswap V2 constant product;
// verified vs Jupiter in src/engine/research/test-cpmm-swap.ts.
//
// References:
//   - https://github.com/raydium-io/raydium-cp-swap
//
// CPMM PoolState layout (post 8-byte Anchor discriminator):
//   off   8  ammConfig                 Pubkey (32)
//   off  40  poolCreator               Pubkey (32)
//   off  72  token0Vault               Pubkey (32)
//   off 104  token1Vault               Pubkey (32)
//   off 136  lpMint                    Pubkey (32)
//   off 168  token0Mint                Pubkey (32)
//   off 200  token1Mint                Pubkey (32)
//   off 232  token0Program             Pubkey (32)
//   off 264  token1Program             Pubkey (32)
//   off 296  observationKey            Pubkey (32)
//   off 328  authBump                  u8
//   off 329  status                    u8
//   off 330  lpMintDecimals            u8
//   off 331  mint0Decimals             u8
//   off 332  mint1Decimals             u8
//   off 333  lpSupply                  u64
//   off 341  protocolFeesToken0        u64
//   off 349  protocolFeesToken1        u64
//   off 357  fundFeesToken0            u64
//   off 365  fundFeesToken1            u64
//   off 373  openTime                  u64
//
// AmmConfig layout (post 8-byte Anchor discriminator):
//   off  12  tradeFeeRate              u64    1e6 denom (2500 = 25 bps)
//
// CPMM swap_base_input instruction:
//   discriminator = sha256("global:swap_base_input")[:8]
//   args:
//     amount_in: u64
//     minimum_amount_out: u64
//   accounts (13):
//     0  payer                  (signer, writable)
//     1  authority              (read)   PDA: ["vault_and_lp_mint_auth_seed"]
//     2  ammConfig              (read)
//     3  poolState              (writable)
//     4  inputTokenAccount      (writable)
//     5  outputTokenAccount     (writable)
//     6  inputVault             (writable)
//     7  outputVault            (writable)
//     8  inputTokenProgram      (read)
//     9  outputTokenProgram     (read)
//    10  inputTokenMint         (read)
//    11  outputTokenMint        (read)
//    12  observationState       (writable)
//
// Reserves: vault SPL Token amount minus accumulated protocol+fund fees.
// We cache vault balances at startup and refresh on vault account WS pushes.

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

export const RAYDIUM_CPMM_PROGRAM = new PublicKey(
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
);

const AUTH_SEED = Buffer.from('vault_and_lp_mint_auth_seed');

const POOL = {
  AMM_CONFIG: 8,
  TOKEN_0_VAULT: 72,
  TOKEN_1_VAULT: 104,
  TOKEN_0_MINT: 168,
  TOKEN_1_MINT: 200,
  TOKEN_0_PROGRAM: 232,
  TOKEN_1_PROGRAM: 264,
  OBSERVATION_KEY: 296,
  MINT_0_DECIMALS: 331,
  MINT_1_DECIMALS: 332,
  PROTOCOL_FEES_TOKEN_0: 341,
  PROTOCOL_FEES_TOKEN_1: 349,
  FUND_FEES_TOKEN_0: 357,
  FUND_FEES_TOKEN_1: 365,
  MIN_DATA_LENGTH: 381,
} as const;

const CFG = {
  TRADE_FEE_RATE: 12, // u64, 1e6 denom
} as const;

const FEE_DENOM = 1_000_000n;

// SPL Token account: amount field at offset 64
const SPL_TOKEN_AMOUNT_OFFSET = 64;

// Anchor discriminator for "swap_base_input"
const SWAP_BASE_INPUT_DISCRIMINATOR = createHash('sha256')
  .update('global:swap_base_input')
  .digest()
  .subarray(0, 8);

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CachedCpmmPool {
  poolAddress: PublicKey;
  ammConfig: PublicKey;
  authority: PublicKey;       // PDA, derived once
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  observationKey: PublicKey;
  mint0Decimals: number;
  mint1Decimals: number;
  // Mutable on-chain state
  vault0Amount: bigint;       // raw vault SPL balance
  vault1Amount: bigint;
  protocolFees0: bigint;
  protocolFees1: bigint;
  fundFees0: bigint;
  fundFees1: bigint;
  // Fee from ammConfig (u64, 1e6 denom)
  tradeFeeRate: bigint;
  feeBps: number;
  label: string;
}

const cpmmCache = new Map<string, CachedCpmmPool>();
// Reverse index: vault address -> pool address (for vault WS routing)
const vaultToCpmmPool = new Map<string, { pool: string; side: 0 | 1 }>();

export function getCachedCpmmPool(addr: string): CachedCpmmPool | undefined {
  return cpmmCache.get(addr);
}

export function getCpmmPoolByVault(vault: string): { pool: string; side: 0 | 1 } | undefined {
  return vaultToCpmmPool.get(vault);
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}

function deriveCpmmAuthority(): PublicKey {
  // CPMM authority is a global PDA shared by all pools (derived from a
  // single seed, no pool argument). Derived once at module load.
  const [pda] = PublicKey.findProgramAddressSync([AUTH_SEED], RAYDIUM_CPMM_PROGRAM);
  return pda;
}

const CPMM_AUTHORITY = deriveCpmmAuthority();

// ═══════════════════════════════════════════════════════════════
// Cache pool data
// ═══════════════════════════════════════════════════════════════

export async function cacheCpmmPoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
): Promise<CachedCpmmPool | null> {
  try {
    const poolPk = new PublicKey(poolAddress);
    const poolAcct = await connection.getAccountInfo(poolPk);
    if (!poolAcct?.data || poolAcct.data.length < POOL.MIN_DATA_LENGTH) {
      executionLog.warn(
        { pool: poolAddress, len: poolAcct?.data?.length },
        'CPMM pool account too small',
      );
      return null;
    }
    if (!poolAcct.owner.equals(RAYDIUM_CPMM_PROGRAM)) {
      executionLog.warn(
        { pool: poolAddress, owner: poolAcct.owner.toString() },
        'Pool not owned by Raydium CPMM program',
      );
      return null;
    }

    const data = poolAcct.data;
    const ammConfig = readPubkey(data, POOL.AMM_CONFIG);
    const token0Vault = readPubkey(data, POOL.TOKEN_0_VAULT);
    const token1Vault = readPubkey(data, POOL.TOKEN_1_VAULT);
    const token0Mint = readPubkey(data, POOL.TOKEN_0_MINT);
    const token1Mint = readPubkey(data, POOL.TOKEN_1_MINT);
    const token0Program = readPubkey(data, POOL.TOKEN_0_PROGRAM);
    const token1Program = readPubkey(data, POOL.TOKEN_1_PROGRAM);
    const observationKey = readPubkey(data, POOL.OBSERVATION_KEY);
    const mint0Decimals = data.readUInt8(POOL.MINT_0_DECIMALS);
    const mint1Decimals = data.readUInt8(POOL.MINT_1_DECIMALS);
    const protocolFees0 = data.readBigUInt64LE(POOL.PROTOCOL_FEES_TOKEN_0);
    const protocolFees1 = data.readBigUInt64LE(POOL.PROTOCOL_FEES_TOKEN_1);
    const fundFees0 = data.readBigUInt64LE(POOL.FUND_FEES_TOKEN_0);
    const fundFees1 = data.readBigUInt64LE(POOL.FUND_FEES_TOKEN_1);

    // Fetch ammConfig for tradeFeeRate
    const cfgAcct = await connection.getAccountInfo(ammConfig);
    if (!cfgAcct?.data || cfgAcct.data.length < CFG.TRADE_FEE_RATE + 8) {
      executionLog.warn({ pool: poolAddress }, 'CPMM ammConfig too small');
      return null;
    }
    const tradeFeeRate = cfgAcct.data.readBigUInt64LE(CFG.TRADE_FEE_RATE);
    const feeBps = Number(tradeFeeRate) / 100;

    // Fetch vault balances
    let vault0Amount: bigint;
    let vault1Amount: bigint;
    try {
      const [v0, v1] = await Promise.all([
        connection.getAccountInfo(token0Vault),
        connection.getAccountInfo(token1Vault),
      ]);
      if (!v0?.data || !v1?.data) {
        executionLog.warn({ pool: poolAddress }, 'CPMM vault fetch returned empty');
        return null;
      }
      vault0Amount = v0.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
      vault1Amount = v1.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    } catch (err: any) {
      executionLog.error({ err: err?.message, pool: poolAddress }, 'CPMM vault fetch threw');
      return null;
    }

    const cached: CachedCpmmPool = {
      poolAddress: poolPk,
      ammConfig,
      authority: CPMM_AUTHORITY,
      token0Vault,
      token1Vault,
      token0Mint,
      token1Mint,
      token0Program,
      token1Program,
      observationKey,
      mint0Decimals,
      mint1Decimals,
      vault0Amount,
      vault1Amount,
      protocolFees0,
      protocolFees1,
      fundFees0,
      fundFees1,
      tradeFeeRate,
      feeBps,
      label,
    };
    cpmmCache.set(poolAddress, cached);
    vaultToCpmmPool.set(token0Vault.toString(), { pool: poolAddress, side: 0 });
    vaultToCpmmPool.set(token1Vault.toString(), { pool: poolAddress, side: 1 });

    executionLog.info(
      {
        pool: label,
        vault0: vault0Amount.toString(),
        vault1: vault1Amount.toString(),
        feeBps,
      },
      'CPMM pool cached',
    );
    return cached;
  } catch (err: any) {
    executionLog.error(
      { err: err?.message, pool: poolAddress },
      'Failed to cache CPMM pool',
    );
    return null;
  }
}

/**
 * Refresh fee accumulators from a fresh PoolState account buffer.
 * Vault balances are refreshed separately via updateCachedCpmmVault().
 */
export function updateCachedCpmmFromAccount(
  poolAddress: string,
  data: Buffer,
): void {
  try {
    const cached = cpmmCache.get(poolAddress);
    if (!cached) return;
    if (data.length < POOL.MIN_DATA_LENGTH) return;
    cached.protocolFees0 = data.readBigUInt64LE(POOL.PROTOCOL_FEES_TOKEN_0);
    cached.protocolFees1 = data.readBigUInt64LE(POOL.PROTOCOL_FEES_TOKEN_1);
    cached.fundFees0 = data.readBigUInt64LE(POOL.FUND_FEES_TOKEN_0);
    cached.fundFees1 = data.readBigUInt64LE(POOL.FUND_FEES_TOKEN_1);
  } catch (err: any) {
    executionLog.warn({ err: err?.message, pool: poolAddress }, 'CPMM pool refresh failed');
  }
}

/**
 * Refresh a vault balance from a fresh SPL Token account buffer. Called by
 * the bot engine's WS router whenever a CPMM vault account changes.
 */
export function updateCachedCpmmVault(vaultAddress: string, data: Buffer): void {
  try {
    const ref = vaultToCpmmPool.get(vaultAddress);
    if (!ref) return;
    const cached = cpmmCache.get(ref.pool);
    if (!cached) return;
    if (data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return;
    const amount = data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    if (ref.side === 0) cached.vault0Amount = amount;
    else cached.vault1Amount = amount;
  } catch (err: any) {
    executionLog.warn({ err: err?.message, vault: vaultAddress }, 'CPMM vault refresh failed');
  }
}

/**
 * Return the list of vault addresses for a cached pool — used by the
 * bot engine to subscribe to vault account changes.
 */
export function getAllCachedCpmmVaults(): string[] {
  return Array.from(vaultToCpmmPool.keys());
}

// ═══════════════════════════════════════════════════════════════
// Math (verified vs Jupiter in C2)
// ═══════════════════════════════════════════════════════════════

/**
 * CPMM exact-in (Uniswap V2 constant product).
 *
 *   amountInAfterFee = amountIn * (1e6 - tradeFeeRate) / 1e6
 *   amountOut        = (amountInAfterFee * reserveOut)
 *                       / (reserveIn + amountInAfterFee)
 */
export function cpmmSwapExactIn(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  tradeFeeRate1e6: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const amountInAfterFee = (amountIn * (FEE_DENOM - tradeFeeRate1e6)) / FEE_DENOM;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

function effectiveReserves(pool: CachedCpmmPool): { r0: bigint; r1: bigint } {
  const r0 = pool.vault0Amount > pool.protocolFees0 + pool.fundFees0
    ? pool.vault0Amount - pool.protocolFees0 - pool.fundFees0
    : 0n;
  const r1 = pool.vault1Amount > pool.protocolFees1 + pool.fundFees1
    ? pool.vault1Amount - pool.protocolFees1 - pool.fundFees1
    : 0n;
  return { r0, r1 };
}

export function calculateCpmmAmountOut(
  pool: CachedCpmmPool,
  amountIn: bigint,
  inputMint: PublicKey,
): bigint {
  const isInput0 = pool.token0Mint.equals(inputMint);
  const isInput1 = pool.token1Mint.equals(inputMint);
  if (!isInput0 && !isInput1) return 0n;
  const { r0, r1 } = effectiveReserves(pool);
  const reserveIn = isInput0 ? r0 : r1;
  const reserveOut = isInput0 ? r1 : r0;
  return cpmmSwapExactIn(amountIn, reserveIn, reserveOut, pool.tradeFeeRate);
}

// ═══════════════════════════════════════════════════════════════
// Build swap instruction
// ═══════════════════════════════════════════════════════════════

export interface BuildCpmmSwapParams {
  pool: CachedCpmmPool;
  payer: PublicKey;
  userInputTokenAccount: PublicKey;
  userOutputTokenAccount: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

export function buildCpmmSwapInstruction(p: BuildCpmmSwapParams): TransactionInstruction {
  const isInput0 = p.pool.token0Mint.equals(p.inputMint);
  const isInput1 = p.pool.token1Mint.equals(p.inputMint);
  if (!isInput0 && !isInput1) {
    throw new Error(
      `inputMint ${p.inputMint.toString()} is neither token0 nor token1 of CPMM pool ${p.pool.poolAddress.toString()}`,
    );
  }

  const inputVault = isInput0 ? p.pool.token0Vault : p.pool.token1Vault;
  const outputVault = isInput0 ? p.pool.token1Vault : p.pool.token0Vault;
  const inputTokenProgram = isInput0 ? p.pool.token0Program : p.pool.token1Program;
  const outputTokenProgram = isInput0 ? p.pool.token1Program : p.pool.token0Program;
  const inputMint = isInput0 ? p.pool.token0Mint : p.pool.token1Mint;
  const outputMint = isInput0 ? p.pool.token1Mint : p.pool.token0Mint;

  // Instruction data: discriminator(8) + amount_in(8) + minimum_amount_out(8) = 24
  const data = Buffer.alloc(8 + 8 + 8);
  SWAP_BASE_INPUT_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amountIn, 8);
  data.writeBigUInt64LE(p.minimumAmountOut, 16);

  const keys = [
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.pool.authority, isSigner: false, isWritable: false },
    { pubkey: p.pool.ammConfig, isSigner: false, isWritable: false },
    { pubkey: p.pool.poolAddress, isSigner: false, isWritable: true },
    { pubkey: p.userInputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.userOutputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: inputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: outputTokenProgram, isSigner: false, isWritable: false },
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: p.pool.observationKey, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: RAYDIUM_CPMM_PROGRAM,
    keys,
    data,
  });
}

export function getRequiredCpmmAlts(_pool: CachedCpmmPool): PublicKey[] {
  return [];
}

/**
 * SOL-per-token from cached CPMM (for the price book).
 */
export function cpmmSolPerToken(pool: CachedCpmmPool): number {
  const SOL = 'So11111111111111111111111111111111111111112';
  const { r0, r1 } = effectiveReserves(pool);
  if (r0 === 0n || r1 === 0n) return 0;
  const sol0 = pool.token0Mint.toString() === SOL;
  const sol1 = pool.token1Mint.toString() === SOL;
  if (!sol0 && !sol1) return 0;
  // Human-adjusted ratio
  const r0Human = Number(r0) / 10 ** pool.mint0Decimals;
  const r1Human = Number(r1) / 10 ** pool.mint1Decimals;
  if (sol0) {
    // SOL = token0; SOL per token = r0 / r1
    return r1Human === 0 ? 0 : r0Human / r1Human;
  }
  // SOL = token1; SOL per token = r1 / r0
  return r0Human === 0 ? 0 : r1Human / r0Human;
}
