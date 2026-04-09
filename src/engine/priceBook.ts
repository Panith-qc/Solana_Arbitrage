// WEBSOCKET PRICE BOOK — Phase 3
// In-memory price book fed by poolMonitor WebSocket updates.
// Stores decimal-adjusted prices per pool, computes cross-DEX spreads.
//
// Architecture:
// poolMonitor → onPoolUpdate → priceBook.updatePool(...)
//                            → priceBook.detectSpread(...)
//
// Hot path reads getPriceBookEntry(poolAddress) for latest price.
// Zero async overhead — all state is module-level.
//
// CODING STANDARDS:
// - All on-chain amounts are BigInt
// - Prices are decimal-adjusted (mSOL/SOL ≈ 1.08, not raw reserves)
// - Every async function has try/catch with context
// - Cross-DEX spread = (sellPrice - buyPrice) / buyPrice * 10000 bps

import { dataLog } from './logger.js';
import {
  SCAN_TOKENS,
  ALL_POOL_REGISTRY,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  TOKEN_DECIMALS,
  type PoolRegistryEntry,
  type TokenInfo,
} from './config.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Single pool entry in the price book */
export interface PriceBookEntry {
  poolAddress: string;
  label: string;
  dex: string;             // 'Raydium AMM' | 'Raydium CLMM' | 'Orca' | 'Meteora' | 'PumpSwap'
  poolType: 'amm-v4' | 'clmm' | 'whirlpool' | 'cpmm' | 'dlmm' | 'damm' | 'pumpswap';
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Raw base reserve (token side), BigInt */
  baseReserve: bigint;
  /** Raw quote reserve (SOL side), BigInt */
  quoteReserve: bigint;
  /** Decimal-adjusted price: how many SOL per 1 token
   *  e.g. mSOL/SOL ≈ 1.08, BONK/SOL ≈ 0.0000018 */
  price: number;
  /** Unix ms of last update */
  updatedAt: number;
  /** Slot of last update */
  slot: number;
}

/** Cross-DEX spread between two pools for the same token */
export interface PriceBookSpread {
  tokenMint: string;
  tokenSymbol: string;
  spreadBps: number;
  buyPool: PriceBookEntry;
  sellPool: PriceBookEntry;
  timestamp: number;
}

/** Callback for price book updates (for logging/metrics) */
export type PriceBookUpdateCallback = (entry: PriceBookEntry) => void;

/** Callback for spread detection */
export type PriceBookSpreadCallback = (spread: PriceBookSpread) => void;

// ═══════════════════════════════════════════════════════════════
// MODULE STATE
// ═══════════════════════════════════════════════════════════════

/** Price book: poolAddress → PriceBookEntry */
const book: Map<string, PriceBookEntry> = new Map();

/** Token decimals cache: tokenMint → decimals */
const decimalsCache: Map<string, number> = new Map();

/** Token symbol cache: tokenMint → symbol */
const symbolCache: Map<string, string> = new Map();

/** Pool registry cache: poolAddress → PoolRegistryEntry */
const registryCache: Map<string, PoolRegistryEntry> = new Map();

/** Registered update callbacks */
const updateCallbacks: PriceBookUpdateCallback[] = [];

/** Registered spread callbacks */
const spreadCallbacks: PriceBookSpreadCallback[] = [];

/** Minimum spread in bps to report (3 bps covers base gas) */
const MIN_SPREAD_BPS = 3;

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

/**
 * Initialize the price book caches from config.
 * Must be called once at startup before any updates arrive.
 *
 * // Example trace:
 * //   initPriceBook()
 * //   decimalsCache: mSOL→9, jitoSOL→9, BONK→5, ...
 * //   registryCache: EGyhb2u...→{label:'mSOL/SOL AMM', poolType:'amm-v4', ...}
 */
export function initPriceBook(): void {
  // Cache token decimals and symbols
  // SOL is always 9 decimals
  decimalsCache.set(SOL_MINT, 9);
  symbolCache.set(SOL_MINT, 'SOL');

  for (const token of SCAN_TOKENS) {
    decimalsCache.set(token.mint, token.decimals);
    symbolCache.set(token.mint, token.symbol);
  }

  // Cache decimals for ALL tokens in the pool registry (not just SCAN_TOKENS).
  // Discovered pools may include tokens (USDC, USDT, HNT, POPCAT, ORCA, etc.)
  // not listed in SCAN_TOKENS. Without this, updatePool() silently drops them.
  for (const entry of ALL_POOL_REGISTRY) {
    registryCache.set(entry.poolAddress, entry);
    if (!decimalsCache.has(entry.tokenMint)) {
      const dec = TOKEN_DECIMALS[entry.tokenMint];
      if (dec !== undefined) {
        decimalsCache.set(entry.tokenMint, dec);
        symbolCache.set(entry.tokenMint, entry.tokenSymbol);
      }
    }
  }

  dataLog.info(
    { tokens: decimalsCache.size, pools: registryCache.size },
    'Price book initialized',
  );
}

// ═══════════════════════════════════════════════════════════════
// PRICE CALCULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate decimal-adjusted price from raw reserves.
 * For an AMM V4 pool with tokenA=token, tokenB=SOL:
 *   price = (quoteReserve / 10^quoteDecimals) / (baseReserve / 10^baseDecimals)
 *         = quoteReserve * 10^baseDecimals / (baseReserve * 10^quoteDecimals)
 * This gives: "how many SOL per 1 token"
 *
 * For CLMM pools, reserves are pseudo-reserves (price already encoded),
 * so we handle them differently.
 *
 * // Example trace (mSOL/SOL AMM):
 * //   baseReserve = 245_000_000_000n (245 mSOL, 9 decimals)
 * //   quoteReserve = 264_600_000_000n (264.6 SOL, 9 decimals)
 * //   tokenDecimals = 9, solDecimals = 9
 * //   price = 264.6 / 245.0 = 1.08 SOL per mSOL ✓
 * //
 * // Example trace (BONK/SOL AMM):
 * //   baseReserve = 5_000_000_000_00000n (50B BONK, 5 decimals)
 * //   quoteReserve = 90_000_000_000n (90 SOL, 9 decimals)
 * //   tokenDecimals = 5, solDecimals = 9
 * //   price = 90 / 50_000_000_000 = 0.0000000018 SOL per BONK ✓
 */
/**
 * Convert pseudo-reserves to decimal-adjusted SOL-per-token price.
 * ALL pool types now pass pseudo-reserves: reserveA = solPerToken × 1e9,
 * reserveB = 1e9. poolMonitor handles the conversion from raw reserves
 * (AMM V4) or on-chain math (CLMM sqrtPriceX64, DLMM bins, etc.)
 * before calling updatePool().
 */
export function calculateDecimalPrice(
  baseReserve: bigint,
  quoteReserve: bigint,
  _tokenDecimals: number,
  _poolType: 'amm-v4' | 'clmm' | 'whirlpool' | 'cpmm' | 'dlmm' | 'damm' | 'pumpswap',
): number {
  if (baseReserve === 0n || quoteReserve === 0n) return 0;
  return Number(baseReserve) / Number(quoteReserve);
}

// ═══════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════

/**
 * Update a pool entry in the price book.
 * Called by poolMonitor on every reserve change.
 * Recalculates decimal-adjusted price and checks for cross-DEX spreads.
 *
 * // Example trace:
 * //   updatePool('EGyhb2u...', 245_000_000_000n, 264_600_000_000n, 300500, 1712000000000)
 * //   registry lookup → mSOL/SOL AMM, tokenDecimals=9
 * //   price = 264.6 / 245.0 = 1.08
 * //   book.set('EGyhb2u...', { price: 1.08, ... })
 * //   check spreads vs mSOL/SOL CLMM → spread = 0.5 bps (< 3, skip)
 */
export function updatePool(
  poolAddress: string,
  baseReserve: bigint,
  quoteReserve: bigint,
  slot: number,
  timestamp: number,
): void {
  const registry = registryCache.get(poolAddress);
  if (!registry) return;

  const tokenDecimals = decimalsCache.get(registry.tokenMint);
  if (tokenDecimals === undefined) return;

  const dex =
    registry.poolType === 'amm-v4'
      ? 'Raydium AMM'
      : registry.poolType === 'clmm'
      ? 'Raydium CLMM'
      : registry.poolType === 'whirlpool'
      ? 'Orca Whirlpool'
      : registry.poolType === 'cpmm'
      ? 'Raydium CPMM'
      : registry.poolType === 'dlmm'
      ? 'Meteora DLMM'
      : registry.poolType === 'damm'
      ? 'Meteora DAMM'
      : 'PumpSwap AMM';
  const price = calculateDecimalPrice(baseReserve, quoteReserve, tokenDecimals, registry.poolType);

  if (price <= 0) return;

  const entry: PriceBookEntry = {
    poolAddress,
    label: registry.label,
    dex,
    poolType: registry.poolType,
    tokenMint: registry.tokenMint,
    tokenSymbol: registry.tokenSymbol,
    tokenDecimals,
    baseReserve,
    quoteReserve,
    price,
    updatedAt: timestamp,
    slot,
  };

  book.set(poolAddress, entry);

  // DEBUG: trace pipeline — remove after verifying hot path works
  dataLog.info(
    { token: registry.tokenSymbol, pool: poolAddress.slice(0, 8), price: price.toFixed(8), poolType: registry.poolType, slot },
    `PRICE BOOK UPDATE: ${registry.tokenSymbol} pool=${poolAddress.slice(0, 8)} price=${price.toFixed(8)}`,
  );

  // Fire update callbacks
  for (const cb of updateCallbacks) {
    try { cb(entry); } catch (err: any) {
      dataLog.warn({ err: err?.message }, 'Price book update callback error');
    }
  }

  // Check cross-DEX spreads
  detectSpread(entry);
}

// ═══════════════════════════════════════════════════════════════
// SPREAD DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Compare updated pool price against all other pools for the same token.
 * If spread > MIN_SPREAD_BPS, fire spread callback.
 *
 * // Example trace:
 * //   entry = mSOL/SOL AMM, price=1.0800
 * //   other = mSOL/SOL CLMM, price=1.0812
 * //   spread = (1.0812 - 1.0800) / 1.0800 * 10000 = 1.11 bps (< 3, skip)
 * //
 * //   entry = RAY/SOL AMM, price=0.01420
 * //   other = RAY/SOL CLMM, price=0.01428
 * //   spread = (0.01428 - 0.01420) / 0.01420 * 10000 = 5.63 bps → EMIT
 */
function detectSpread(updated: PriceBookEntry): void {
  if (spreadCallbacks.length === 0) return;

  for (const [addr, other] of book) {
    if (addr === updated.poolAddress) continue;
    if (other.tokenMint !== updated.tokenMint) continue;

    // Both must be fresh (< 10s)
    const now = Date.now();
    if (now - other.updatedAt > 10_000) continue;
    if (now - updated.updatedAt > 10_000) continue;

    const highPrice = Math.max(updated.price, other.price);
    const lowPrice = Math.min(updated.price, other.price);
    if (lowPrice <= 0) continue;

    const spreadBps = ((highPrice - lowPrice) / lowPrice) * 10_000;

    if (spreadBps >= MIN_SPREAD_BPS) {
      const buyPool = updated.price < other.price ? updated : other;
      const sellPool = updated.price < other.price ? other : updated;

      const spread: PriceBookSpread = {
        tokenMint: updated.tokenMint,
        tokenSymbol: updated.tokenSymbol,
        spreadBps,
        buyPool,
        sellPool,
        timestamp: now,
      };

      for (const cb of spreadCallbacks) {
        try { cb(spread); } catch (err: any) {
          dataLog.warn({ err: err?.message }, 'Price book spread callback error');
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/** Get a single pool's price book entry */
export function getPriceBookEntry(poolAddress: string): PriceBookEntry | null {
  return book.get(poolAddress) || null;
}

/** Get all entries for a given token mint */
export function getEntriesForToken(tokenMint: string): PriceBookEntry[] {
  const entries: PriceBookEntry[] = [];
  for (const entry of book.values()) {
    if (entry.tokenMint === tokenMint) entries.push(entry);
  }
  return entries;
}

/** Get the full price book snapshot */
export function getPriceBookSnapshot(): PriceBookEntry[] {
  return Array.from(book.values());
}

/** Get the best (lowest) buy price and best (highest) sell price for a token */
export function getBestPrices(tokenMint: string): { bestBuy: PriceBookEntry | null; bestSell: PriceBookEntry | null; spreadBps: number } {
  const entries = getEntriesForToken(tokenMint);
  if (entries.length < 2) return { bestBuy: null, bestSell: null, spreadBps: 0 };

  let bestBuy: PriceBookEntry | null = null;
  let bestSell: PriceBookEntry | null = null;

  for (const e of entries) {
    if (!bestBuy || e.price < bestBuy.price) bestBuy = e;
    if (!bestSell || e.price > bestSell.price) bestSell = e;
  }

  const spreadBps = (bestBuy && bestSell && bestBuy.price > 0)
    ? ((bestSell.price - bestBuy.price) / bestBuy.price) * 10_000
    : 0;

  return { bestBuy, bestSell, spreadBps };
}

/** Register callback for price updates */
export function onPriceUpdate(cb: PriceBookUpdateCallback): void {
  updateCallbacks.push(cb);
}

/** Register callback for spread detection */
export function onSpread(cb: PriceBookSpreadCallback): void {
  spreadCallbacks.push(cb);
}

/**
 * Register a pool registry entry at runtime. Used by research/integration
 * tests that discover pools dynamically (e.g. via Jupiter /quote) instead of
 * relying on the static ALL_POOL_REGISTRY baked into config. Production
 * code paths still use initPriceBook() with the config; this is additive.
 *
 * Also ensures the tokenMint's decimals are cached so updatePool() can price
 * AMM V4 pools (which pass raw reserves). Pass the decimals explicitly since
 * tokens discovered at runtime may not be in SCAN_TOKENS.
 */
export function registerPool(
  entry: PoolRegistryEntry,
  tokenDecimals: number,
  tokenSymbol?: string,
): void {
  registryCache.set(entry.poolAddress, entry);
  decimalsCache.set(entry.tokenMint, tokenDecimals);
  if (tokenSymbol) symbolCache.set(entry.tokenMint, tokenSymbol);
}

/** Clear all callbacks (for shutdown) */
export function clearPriceBookCallbacks(): void {
  updateCallbacks.length = 0;
  spreadCallbacks.length = 0;
}

/** Clear the entire price book (for shutdown) */
export function clearPriceBook(): void {
  book.clear();
  clearPriceBookCallbacks();
}
