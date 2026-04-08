// PUMPSWAP AMM SWAP BUILDER
// Builds raw PumpSwap (pump.fun AMM) swap instructions from cached pool
// state — no SDK, no Jupiter. Same hot-path role as cpmmSwapBuilder.ts /
// dammSwapBuilder.ts but for PumpSwap, the constant-product AMM hosting
// graduated pump.fun meme tokens.
//
// Phase E3 of multi-DEX expansion. Math = Uniswap V2 constant product
// with a 25 bps fee on the input side; verified vs Jupiter in
// src/engine/research/test-pumpswap-swap.ts.
//
// PumpSwap pools are dangerous (meme tokens, freeze authorities, sub-hour
// rugs). Pool acceptance is gated by safety checks in cachePumpSwapPoolData
// — see the meme-safety section below.
//
// Pool layout (post 8-byte Anchor discriminator):
//   off   8  pool_bump                 u8
//   off   9  index                     u16
//   off  11  creator                   Pubkey (32)
//   off  43  base_mint                 Pubkey (32)   — meme token
//   off  75  quote_mint                Pubkey (32)   — SOL (WSOL)
//   off 107  lp_mint                   Pubkey (32)
//   off 139  pool_base_token_account   Pubkey (32)
//   off 171  pool_quote_token_account  Pubkey (32)
//   off 203  lp_supply                 u64
//   off 211  coin_creator              Pubkey (32)
//   --- min length 243
//
// PumpSwap swap instructions:
//   Buy  (SOL → base):  base_amount_out: u64, max_quote_amount_in: u64
//   Sell (base → SOL):  base_amount_in : u64, min_quote_amount_out: u64
//
//   discriminator = sha256("global:buy")[:8]   /  sha256("global:sell")[:8]
//
//   accounts (17):
//     0  pool                                  (writable)
//     1  user                                  (signer, writable)
//     2  global_config
//     3  base_mint
//     4  quote_mint
//     5  user_base_token_account               (writable)
//     6  user_quote_token_account              (writable)
//     7  pool_base_token_account               (writable)
//     8  pool_quote_token_account              (writable)
//     9  protocol_fee_recipient
//    10  protocol_fee_recipient_token_account  (writable)
//    11  base_token_program
//    12  quote_token_program
//    13  system_program
//    14  associated_token_program
//    15  event_authority                       PDA: ["__event_authority"]
//    16  program (PumpSwap)

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

export const PUMPSWAP_PROGRAM = new PublicKey(
  'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP1',
);

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';

const POOL = {
  POOL_BUMP: 8,
  INDEX: 9,
  CREATOR: 11,
  BASE_MINT: 43,
  QUOTE_MINT: 75,
  LP_MINT: 107,
  POOL_BASE_TOKEN_ACCOUNT: 139,
  POOL_QUOTE_TOKEN_ACCOUNT: 171,
  LP_SUPPLY: 203,
  COIN_CREATOR: 211,
  MIN_DATA_LENGTH: 243,
} as const;

const FEE_DENOM = 10_000n;
const SPL_TOKEN_AMOUNT_OFFSET = 64;
// SPL Mint layout:
//   mint_authority: COption<Pubkey> = 36 bytes (off 0-35)
//   supply: u64                     =  8 bytes (off 36-43)
//   decimals: u8                    =  1 byte  (off 44)
//   is_initialized: u8              =  1 byte  (off 45)
//   freeze_authority: COption<Pubkey> = 36 bytes (off 46-81)
const SPL_MINT_DECIMALS_OFFSET = 44;
const SPL_MINT_FREEZE_AUTH_TAG_OFFSET = 46;

// Anchor discriminators
const BUY_DISC  = createHash('sha256').update('global:buy').digest().subarray(0, 8);
const SELL_DISC = createHash('sha256').update('global:sell').digest().subarray(0, 8);

// Event authority PDA — single seed across all pools.
const EVENT_AUTH_SEED = Buffer.from('__event_authority');
const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [EVENT_AUTH_SEED],
  PUMPSWAP_PROGRAM,
);

// Default total fee for PumpSwap (LP 20 + protocol 5). Override per-pool
// at cache time if a GlobalConfig is supplied.
const DEFAULT_FEE_BPS = 25n;

// ═══════════════════════════════════════════════════════════════
// Meme safety thresholds
// ═══════════════════════════════════════════════════════════════

/** Reject pools younger than this many seconds. */
const MIN_POOL_AGE_SECS = 3600; // 1 hour
/** Reject pools with less than ~$5k of SOL liquidity. At ~$170/SOL the
 *  floor is ~30 SOL = 30e9 lamports. The floor is intentionally
 *  conservative — meme pools below this threshold consistently rug. */
const MIN_QUOTE_LIQUIDITY_LAMPORTS = 30n * 1_000_000_000n;
/** Maximum trade size for any PumpSwap leg, in lamports. */
export const MAX_PUMPSWAP_TRADE_LAMPORTS = 100_000_000n; // 0.1 SOL

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CachedPumpSwapPool {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  // Live state
  baseReserve: bigint;   // raw vault balance
  quoteReserve: bigint;  // raw vault balance (lamports for SOL pools)
  // Fee bps applied to input. Defaults to DEFAULT_FEE_BPS.
  feeBps: bigint;
  // Optional GlobalConfig + protocol fee recipient — required to build
  // an actual swap instruction; if missing, the pool can still be used
  // for read-only quoting.
  globalConfig: PublicKey | null;
  protocolFeeRecipient: PublicKey | null;
  protocolFeeRecipientTokenAccount: PublicKey | null;
  // Provenance / safety metadata
  createdAtSec: number;
  hasFreezeAuthority: boolean;
  label: string;
}

const pumpCache = new Map<string, CachedPumpSwapPool>();
const vaultToPumpPool = new Map<string, { pool: string; side: 'base' | 'quote' }>();

export function getCachedPumpSwapPool(addr: string): CachedPumpSwapPool | undefined {
  return pumpCache.get(addr);
}

export function getPumpSwapPoolByVault(
  vault: string,
): { pool: string; side: 'base' | 'quote' } | undefined {
  return vaultToPumpPool.get(vault);
}

export function getAllCachedPumpSwapVaults(): string[] {
  return Array.from(vaultToPumpPool.keys());
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}

function decodeMintHasFreezeAuthority(data: Buffer): boolean {
  // COption<Pubkey> tag is the first byte at offset 46.
  // 0 = None, 1 = Some.
  if (data.length < SPL_MINT_FREEZE_AUTH_TAG_OFFSET + 1) return false;
  return data.readUInt8(SPL_MINT_FREEZE_AUTH_TAG_OFFSET) === 1;
}

function decodeMintDecimals(data: Buffer): number {
  return data.readUInt8(SPL_MINT_DECIMALS_OFFSET);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ═══════════════════════════════════════════════════════════════
// Cache pool data (with meme safety checks)
// ═══════════════════════════════════════════════════════════════

export interface CachePumpSwapOptions {
  /** GlobalConfig pubkey — required if you intend to build instructions. */
  globalConfig?: PublicKey | string;
  /** Protocol fee recipient (one of the 8 listed in GlobalConfig). */
  protocolFeeRecipient?: PublicKey | string;
  /** Protocol fee recipient quote ATA (writable in the swap ix). */
  protocolFeeRecipientTokenAccount?: PublicKey | string;
  /** Override the default 25 bps fee, e.g. read from GlobalConfig. */
  feeBpsOverride?: bigint;
  /** Skip meme safety checks (verification harnesses only). */
  skipSafetyChecks?: boolean;
}

export async function cachePumpSwapPoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
  opts: CachePumpSwapOptions = {},
): Promise<CachedPumpSwapPool | null> {
  try {
    const poolPk = new PublicKey(poolAddress);
    const poolAcct = await connection.getAccountInfo(poolPk);
    if (!poolAcct?.data || poolAcct.data.length < POOL.MIN_DATA_LENGTH) {
      executionLog.warn(
        { pool: poolAddress, len: poolAcct?.data?.length },
        'PumpSwap pool account too small',
      );
      return null;
    }
    if (!poolAcct.owner.equals(PUMPSWAP_PROGRAM)) {
      executionLog.warn(
        { pool: poolAddress, owner: poolAcct.owner.toString() },
        'Pool not owned by PumpSwap program',
      );
      return null;
    }

    const data = poolAcct.data;
    const baseMint = readPubkey(data, POOL.BASE_MINT);
    const quoteMint = readPubkey(data, POOL.QUOTE_MINT);
    const poolBaseTokenAccount = readPubkey(data, POOL.POOL_BASE_TOKEN_ACCOUNT);
    const poolQuoteTokenAccount = readPubkey(data, POOL.POOL_QUOTE_TOKEN_ACCOUNT);

    if (quoteMint.toString() !== SOL_MINT_STR) {
      executionLog.warn(
        { pool: poolAddress, quoteMint: quoteMint.toString() },
        'PumpSwap pool not SOL-quoted; skipping',
      );
      return null;
    }

    // Fetch base mint (for decimals + freeze authority) and both vaults.
    const [baseMintAcct, baseVaultAcct, quoteVaultAcct] = await Promise.all([
      connection.getAccountInfo(baseMint),
      connection.getAccountInfo(poolBaseTokenAccount),
      connection.getAccountInfo(poolQuoteTokenAccount),
    ]);
    if (!baseMintAcct?.data || !baseVaultAcct?.data || !quoteVaultAcct?.data) {
      executionLog.warn({ pool: poolAddress }, 'PumpSwap related account fetch returned empty');
      return null;
    }
    const baseDecimals = decodeMintDecimals(baseMintAcct.data);
    const hasFreezeAuthority = decodeMintHasFreezeAuthority(baseMintAcct.data);
    const baseReserve = baseVaultAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    const quoteReserve = quoteVaultAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);

    // Pool age — use rentEpoch is unreliable; instead use the account's
    // first-seen slot via getSignaturesForAddress as a heuristic. We
    // approximate with the lamport allocation timestamp by reading the
    // poolAcct.rentEpoch is NOT a timestamp. The cleanest way is to ask
    // the RPC for the oldest signature's blockTime, but to keep this
    // dependency-free we record the cache time and let the verification
    // gate compare against an explicit createdAtSec passed in via opts.
    // Default: assume "now" — meaning fresh pools will pass the age
    // check only if their first signature is older than MIN_POOL_AGE.
    let createdAtSec = nowSec();
    try {
      const sigs = await connection.getSignaturesForAddress(poolPk, { limit: 1000 });
      if (sigs.length > 0) {
        const oldest = sigs[sigs.length - 1];
        if (oldest.blockTime) createdAtSec = oldest.blockTime;
      }
    } catch (err: any) {
      executionLog.debug(
        { pool: poolAddress, err: err?.message },
        'PumpSwap age lookup failed; defaulting to now',
      );
    }

    // ── Meme safety gates ──────────────────────────────────────
    if (!opts.skipSafetyChecks) {
      const ageSec = nowSec() - createdAtSec;
      if (ageSec < MIN_POOL_AGE_SECS) {
        executionLog.warn(
          { pool: poolAddress, ageSec, minAgeSec: MIN_POOL_AGE_SECS },
          'PumpSwap pool rejected: too young',
        );
        return null;
      }
      if (quoteReserve < MIN_QUOTE_LIQUIDITY_LAMPORTS) {
        executionLog.warn(
          {
            pool: poolAddress,
            quoteReserveLamports: quoteReserve.toString(),
            floorLamports: MIN_QUOTE_LIQUIDITY_LAMPORTS.toString(),
          },
          'PumpSwap pool rejected: insufficient SOL liquidity',
        );
        return null;
      }
      if (hasFreezeAuthority) {
        executionLog.warn(
          { pool: poolAddress, baseMint: baseMint.toString() },
          'PumpSwap pool rejected: base mint has freeze authority',
        );
        return null;
      }
    }

    const cached: CachedPumpSwapPool = {
      poolAddress: poolPk,
      baseMint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      baseDecimals,
      quoteDecimals: 9, // SOL
      baseReserve,
      quoteReserve,
      feeBps: opts.feeBpsOverride ?? DEFAULT_FEE_BPS,
      globalConfig: opts.globalConfig
        ? new PublicKey(opts.globalConfig)
        : null,
      protocolFeeRecipient: opts.protocolFeeRecipient
        ? new PublicKey(opts.protocolFeeRecipient)
        : null,
      protocolFeeRecipientTokenAccount: opts.protocolFeeRecipientTokenAccount
        ? new PublicKey(opts.protocolFeeRecipientTokenAccount)
        : null,
      createdAtSec,
      hasFreezeAuthority,
      label,
    };
    pumpCache.set(poolAddress, cached);
    vaultToPumpPool.set(poolBaseTokenAccount.toString(), { pool: poolAddress, side: 'base' });
    vaultToPumpPool.set(poolQuoteTokenAccount.toString(), { pool: poolAddress, side: 'quote' });

    executionLog.info(
      {
        pool: label,
        baseReserve: baseReserve.toString(),
        quoteReserve: quoteReserve.toString(),
        feeBps: cached.feeBps.toString(),
        ageSec: nowSec() - createdAtSec,
      },
      'PumpSwap pool cached',
    );
    return cached;
  } catch (err: any) {
    executionLog.error(
      { err: err?.message, pool: poolAddress },
      'Failed to cache PumpSwap pool',
    );
    return null;
  }
}

/**
 * Refresh a vault balance from a fresh SPL Token account buffer. Called by
 * the bot engine's WS router whenever a PumpSwap vault account changes.
 */
export function updateCachedPumpSwapVault(vaultAddress: string, data: Buffer): void {
  try {
    const ref = vaultToPumpPool.get(vaultAddress);
    if (!ref) return;
    const cached = pumpCache.get(ref.pool);
    if (!cached) return;
    if (data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return;
    const amount = data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
    if (ref.side === 'base') cached.baseReserve = amount;
    else cached.quoteReserve = amount;
  } catch (err: any) {
    executionLog.warn(
      { err: err?.message, vault: vaultAddress },
      'PumpSwap vault refresh failed',
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Math (Uniswap V2 constant product, fee on input)
// ═══════════════════════════════════════════════════════════════

export function pumpSwapExactIn(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const amountInAfterFee = (amountIn * (FEE_DENOM - feeBps)) / FEE_DENOM;
  return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
}

export function calculatePumpSwapAmountOut(
  pool: CachedPumpSwapPool,
  amountIn: bigint,
  inputMint: PublicKey,
): bigint {
  const isBaseIn = pool.baseMint.equals(inputMint);
  const isQuoteIn = pool.quoteMint.equals(inputMint);
  if (!isBaseIn && !isQuoteIn) return 0n;
  const reserveIn = isQuoteIn ? pool.quoteReserve : pool.baseReserve;
  const reserveOut = isQuoteIn ? pool.baseReserve : pool.quoteReserve;
  return pumpSwapExactIn(amountIn, reserveIn, reserveOut, pool.feeBps);
}

/** SOL-per-token price for the price book. */
export function pumpSwapSolPerToken(pool: CachedPumpSwapPool): number {
  if (pool.baseReserve === 0n || pool.quoteReserve === 0n) return 0;
  const baseHuman = Number(pool.baseReserve) / 10 ** pool.baseDecimals;
  const quoteHuman = Number(pool.quoteReserve) / 10 ** pool.quoteDecimals;
  return baseHuman === 0 ? 0 : quoteHuman / baseHuman;
}

// ═══════════════════════════════════════════════════════════════
// Build swap instruction
// ═══════════════════════════════════════════════════════════════

export interface BuildPumpSwapParams {
  pool: CachedPumpSwapPool;
  payer: PublicKey;
  /** SOL ATA (WSOL). */
  userQuoteTokenAccount: PublicKey;
  /** Base (meme token) ATA. */
  userBaseTokenAccount: PublicKey;
  inputMint: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}

/**
 * Build a PumpSwap swap instruction. Direction is inferred from inputMint:
 *   inputMint == quoteMint (SOL) → buy(base_amount_out=minOut, max_quote_in=amountIn)
 *   inputMint == baseMint        → sell(base_amount_in=amountIn, min_quote_out=minOut)
 *
 * Notes:
 *   - PumpSwap's "buy" is exact-base-out, not exact-quote-in. To use it
 *     in an exact-in arb, the caller must compute base_amount_out from
 *     cached reserves (calculatePumpSwapAmountOut) and pass it as
 *     `minimumAmountOut`. `amountIn` becomes the max quote tolerated.
 *     If reserves move against us, the pool returns an
 *     ExceededSlippage / ExceededMaxIn error and the atomic TX reverts.
 */
export function buildPumpSwapInstruction(p: BuildPumpSwapParams): TransactionInstruction {
  if (!p.pool.globalConfig || !p.pool.protocolFeeRecipient || !p.pool.protocolFeeRecipientTokenAccount) {
    throw new Error(
      `PumpSwap pool ${p.pool.poolAddress.toString()} missing globalConfig / protocol fee recipient — cannot build swap`,
    );
  }
  const isBuy = p.pool.quoteMint.equals(p.inputMint);
  const isSell = p.pool.baseMint.equals(p.inputMint);
  if (!isBuy && !isSell) {
    throw new Error(
      `inputMint ${p.inputMint.toString()} is neither base nor quote of PumpSwap pool ${p.pool.poolAddress.toString()}`,
    );
  }

  // Encode args
  const data = Buffer.alloc(8 + 8 + 8);
  if (isBuy) {
    BUY_DISC.copy(data, 0);
    // base_amount_out: u64 = minimumAmountOut
    // max_quote_amount_in: u64 = amountIn
    data.writeBigUInt64LE(p.minimumAmountOut, 8);
    data.writeBigUInt64LE(p.amountIn, 16);
  } else {
    SELL_DISC.copy(data, 0);
    // base_amount_in: u64 = amountIn
    // min_quote_amount_out: u64 = minimumAmountOut
    data.writeBigUInt64LE(p.amountIn, 8);
    data.writeBigUInt64LE(p.minimumAmountOut, 16);
  }

  const keys = [
    { pubkey: p.pool.poolAddress, isSigner: false, isWritable: true },
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.pool.globalConfig, isSigner: false, isWritable: false },
    { pubkey: p.pool.baseMint, isSigner: false, isWritable: false },
    { pubkey: p.pool.quoteMint, isSigner: false, isWritable: false },
    { pubkey: p.userBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.userQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.pool.poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.pool.poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: p.pool.protocolFeeRecipient, isSigner: false, isWritable: false },
    { pubkey: p.pool.protocolFeeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM,
    keys,
    data,
  });
}

export function getRequiredPumpSwapAlts(_pool: CachedPumpSwapPool): PublicKey[] {
  return [];
}
