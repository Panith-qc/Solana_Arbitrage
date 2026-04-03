#!/usr/bin/env npx tsx
// TEST SCRIPT: WebSocket Price Book ��� connects to real Helius mainnet
// Run: npx tsx src/engine/test-ws-pricebook.ts
//
// This script:
// 1. Connects to wss://atlas-mainnet.helius-rpc.com via Solana Connection
// 2. Subscribes to all pool vault accounts
// 3. Logs every reserve update with decimal-adjusted prices
// 4. Detects and logs cross-DEX spreads

// ── PROXY SETUP: undici ProxyAgent for environments with HTTP_PROXY ──
// Must be set BEFORE any fetch() calls (including @solana/web3.js internals)
import { ProxyAgent, setGlobalDispatcher } from 'undici';
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log('Proxy configured for fetch() calls');
}

import { Connection, PublicKey, AccountInfo, Context } from '@solana/web3.js';
import dotenv from 'dotenv';
dotenv.config();

import {
  SCAN_TOKENS,
  RAYDIUM_POOL_REGISTRY,
  SOL_MINT,
  type PoolRegistryEntry,
} from './config.js';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
if (!HELIUS_API_KEY) {
  console.error('ERROR: HELIUS_API_KEY not set in .env');
  process.exit(1);
}

// Use atlas-mainnet for Enhanced WebSocket (2 credits per 0.1MB)
const WS_URL = `wss://atlas-mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

console.log(`\n${'═'.repeat(70)}`);
console.log('PHASE 3: WebSocket Price Book — Real Mainnet Test');
console.log(`${'═'.repeat(70)}\n`);

// ═══════════════════════════════════════════════════════════════
// LAYOUT CONSTANTS
// ═══════════════════════════════════════════════════════════════

const AMM_V4_BASE_VAULT_OFFSET = 336;
const AMM_V4_QUOTE_VAULT_OFFSET = 368;
const AMM_V4_BASE_PNL_OFFSET = 192;
const AMM_V4_QUOTE_PNL_OFFSET = 200;
const AMM_V4_MIN_DATA_LENGTH = 752;

// SPL Token Account layout: offset 64 = amount (u64 LE)
const SPL_TOKEN_AMOUNT_OFFSET = 64;

const CLMM_SQRT_PRICE_X64_OFFSET = 253;
const CLMM_MINT_DECIMALS_0_OFFSET = 233;
const CLMM_MINT_DECIMALS_1_OFFSET = 234;
const CLMM_MIN_DATA_LENGTH = 400;

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

/** Token decimals map: mint → decimals */
const decimals = new Map<string, number>();
decimals.set(SOL_MINT, 9);
for (const t of SCAN_TOKENS) decimals.set(t.mint, t.decimals);

/** Token symbol map: mint → symbol */
const symbols = new Map<string, string>();
symbols.set(SOL_MINT, 'SOL');
for (const t of SCAN_TOKENS) symbols.set(t.mint, t.symbol);

/** Pool registry map: poolAddress → entry */
const registry = new Map<string, PoolRegistryEntry>();
for (const e of RAYDIUM_POOL_REGISTRY) registry.set(e.poolAddress, e);

/** Vault → pool mapping */
const vaultToPool = new Map<string, { poolAddress: string; side: 'base' | 'quote' }>();

/** Pool vault state */
const poolState = new Map<string, {
  baseVault: string;
  quoteVault: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  basePnl: bigint;
  quotePnl: bigint;
}>();

/** Price book: poolAddress → { price, label, ... } */
interface PriceEntry {
  label: string;
  dex: string;
  poolType: 'amm-v4' | 'clmm';
  tokenSymbol: string;
  tokenMint: string;
  tokenDecimals: number;
  baseReserve: bigint;
  quoteReserve: bigint;
  price: number;
  updatedAt: number;
  slot: number;
}
const priceBook = new Map<string, PriceEntry>();

let totalUpdates = 0;
let totalSpreads = 0;

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function calcPrice(baseReserve: bigint, quoteReserve: bigint, tokenDec: number, poolType: string): number {
  if (baseReserve === 0n || quoteReserve === 0n) return 0;
  if (poolType === 'clmm') {
    return Number(baseReserve) / Number(quoteReserve);
  }
  const baseFloat = Number(baseReserve) / (10 ** tokenDec);
  const quoteFloat = Number(quoteReserve) / (10 ** 9);
  if (baseFloat === 0) return 0;
  return quoteFloat / baseFloat;
}

function formatReserve(reserve: bigint, dec: number): string {
  const val = Number(reserve) / (10 ** dec);
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(2)}K`;
  return val.toFixed(4);
}

function checkSpreads(updatedPoolAddr: string): void {
  const updated = priceBook.get(updatedPoolAddr);
  if (!updated) return;

  for (const [addr, other] of priceBook) {
    if (addr === updatedPoolAddr) continue;
    if (other.tokenMint !== updated.tokenMint) continue;
    if (Date.now() - other.updatedAt > 10_000) continue;

    const hi = Math.max(updated.price, other.price);
    const lo = Math.min(updated.price, other.price);
    if (lo <= 0) continue;
    const spreadBps = ((hi - lo) / lo) * 10_000;

    if (spreadBps >= 1) {
      totalSpreads++;
      const buyPool = updated.price < other.price ? updated : other;
      const sellPool = updated.price < other.price ? other : updated;
      console.log(
        `\n  🔀 CROSS-DEX SPREAD: ${updated.tokenSymbol} ${spreadBps.toFixed(2)} bps` +
        `\n     BUY  @ ${buyPool.dex} (${buyPool.label}): ${buyPool.price.toFixed(10)}` +
        `\n     SELL @ ${sellPool.dex} (${sellPool.label}): ${sellPool.price.toFixed(10)}` +
        `\n     Spread #${totalSpreads}\n`,
      );
    }
  }
}

function updatePriceBookEntry(poolAddress: string, baseReserve: bigint, quoteReserve: bigint, slot: number): void {
  const reg = registry.get(poolAddress);
  if (!reg) return;

  const tokenDec = decimals.get(reg.tokenMint);
  if (tokenDec === undefined) return;

  const dex = reg.poolType === 'amm-v4' ? 'Raydium AMM' : 'Raydium CLMM';
  const price = calcPrice(baseReserve, quoteReserve, tokenDec, reg.poolType);
  if (price <= 0) return;

  totalUpdates++;
  const now = Date.now();

  priceBook.set(poolAddress, {
    label: reg.label,
    dex,
    poolType: reg.poolType,
    tokenSymbol: reg.tokenSymbol,
    tokenMint: reg.tokenMint,
    tokenDecimals: tokenDec,
    baseReserve,
    quoteReserve,
    price,
    updatedAt: now,
    slot,
  });

  const baseLabel = `${formatReserve(baseReserve, tokenDec)} ${reg.tokenSymbol}`;
  const quoteLabel = `${formatReserve(quoteReserve, 9)} SOL`;

  console.log(
    `[${new Date().toISOString().slice(11, 23)}] ` +
    `#${totalUpdates.toString().padStart(4)} ` +
    `${dex.padEnd(12)} ${reg.label.padEnd(20)} ` +
    `base=${baseLabel.padEnd(18)} quote=${quoteLabel.padEnd(14)} ` +
    `price=${price.toFixed(10)} ` +
    `slot=${slot}`,
  );

  checkSpreads(poolAddress);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // Step 1: Connect
  console.log(`Connecting to WebSocket: ${WS_URL.replace(HELIUS_API_KEY, HELIUS_API_KEY.slice(0, 8) + '...')}`);
  console.log(`RPC: ${RPC_URL.replace(HELIUS_API_KEY, HELIUS_API_KEY.slice(0, 8) + '...')}\n`);

  const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    wsEndpoint: WS_URL,
  });

  // Validate RPC
  const slot = await connection.getSlot();
  console.log(`WebSocket connected to ${WS_URL.replace(HELIUS_API_KEY, HELIUS_API_KEY.slice(0, 8) + '...')}`);
  console.log(`RPC validated — current slot: ${slot}\n`);

  // Step 2: Subscribe to pools
  const ammV4Pools = RAYDIUM_POOL_REGISTRY.filter(p => p.poolType === 'amm-v4');
  const clmmPools = RAYDIUM_POOL_REGISTRY.filter(p => p.poolType === 'clmm');

  console.log(`Pool registry: ${ammV4Pools.length} AMM V4, ${clmmPools.length} CLMM, ${RAYDIUM_POOL_REGISTRY.length} total`);
  console.log(`Tokens: ${[...new Set(RAYDIUM_POOL_REGISTRY.map(p => p.tokenSymbol))].join(', ')}\n`);

  let totalSubscriptions = 0;

  // Subscribe to AMM V4 vaults
  for (const pool of ammV4Pools) {
    try {
      const pubkey = new PublicKey(pool.poolAddress);
      const accountInfo = await connection.getAccountInfo(pubkey);
      if (!accountInfo?.data || accountInfo.data.length < AMM_V4_MIN_DATA_LENGTH) {
        console.log(`  SKIP ${pool.label}: account too small (${accountInfo?.data?.length || 0} bytes)`);
        continue;
      }

      const data = accountInfo.data;
      const baseVault = new PublicKey(data.subarray(AMM_V4_BASE_VAULT_OFFSET, AMM_V4_BASE_VAULT_OFFSET + 32));
      const quoteVault = new PublicKey(data.subarray(AMM_V4_QUOTE_VAULT_OFFSET, AMM_V4_QUOTE_VAULT_OFFSET + 32));
      const basePnl = data.readBigUInt64LE(AMM_V4_BASE_PNL_OFFSET);
      const quotePnl = data.readBigUInt64LE(AMM_V4_QUOTE_PNL_OFFSET);

      const bv = baseVault.toString();
      const qv = quoteVault.toString();

      poolState.set(pool.poolAddress, {
        baseVault: bv,
        quoteVault: qv,
        baseReserve: 0n,
        quoteReserve: 0n,
        basePnl,
        quotePnl,
      });

      vaultToPool.set(bv, { poolAddress: pool.poolAddress, side: 'base' });
      vaultToPool.set(qv, { poolAddress: pool.poolAddress, side: 'quote' });

      // Read initial vault balances
      const [baseAcct, quoteAcct] = await Promise.all([
        connection.getAccountInfo(baseVault),
        connection.getAccountInfo(quoteVault),
      ]);

      const state = poolState.get(pool.poolAddress)!;
      if (baseAcct?.data && baseAcct.data.length >= SPL_TOKEN_AMOUNT_OFFSET + 8) {
        state.baseReserve = baseAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
      }
      if (quoteAcct?.data && quoteAcct.data.length >= SPL_TOKEN_AMOUNT_OFFSET + 8) {
        state.quoteReserve = quoteAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
      }

      const effectiveBase = state.baseReserve > state.basePnl ? state.baseReserve - state.basePnl : 0n;
      const effectiveQuote = state.quoteReserve > state.quotePnl ? state.quoteReserve - state.quotePnl : 0n;

      // Initial price
      updatePriceBookEntry(pool.poolAddress, effectiveBase, effectiveQuote, slot);

      // Subscribe to vault changes
      connection.onAccountChange(baseVault, (info: AccountInfo<Buffer>, ctx: Context) => {
        handleVaultChange(bv, info, ctx);
      }, 'confirmed');
      totalSubscriptions++;

      connection.onAccountChange(quoteVault, (info: AccountInfo<Buffer>, ctx: Context) => {
        handleVaultChange(qv, info, ctx);
      }, 'confirmed');
      totalSubscriptions++;

      // Also subscribe to AMM account for PnL updates
      connection.onAccountChange(pubkey, (info: AccountInfo<Buffer>, ctx: Context) => {
        handleAmmAccountChange(pool.poolAddress, info, ctx);
      }, 'confirmed');
      totalSubscriptions++;

      console.log(`  ✓ ${pool.label}: baseVault=${bv.slice(0, 8)}... quoteVault=${qv.slice(0, 8)}...`);

    } catch (err: any) {
      console.log(`  ✗ ${pool.label}: ${err?.message}`);
    }
  }

  // Subscribe to CLMM pools
  for (const pool of clmmPools) {
    try {
      const pubkey = new PublicKey(pool.poolAddress);

      // Read initial CLMM state
      const accountInfo = await connection.getAccountInfo(pubkey);
      if (accountInfo?.data && accountInfo.data.length >= CLMM_MIN_DATA_LENGTH) {
        const clmmUpdate = parseClmmData(pool.poolAddress, accountInfo.data, slot);
        if (clmmUpdate) {
          updatePriceBookEntry(pool.poolAddress, clmmUpdate.baseReserve, clmmUpdate.quoteReserve, slot);
        }
      }

      connection.onAccountChange(pubkey, (info: AccountInfo<Buffer>, ctx: Context) => {
        handleClmmChange(pool.poolAddress, info, ctx);
      }, 'confirmed');
      totalSubscriptions++;

      console.log(`  ✓ ${pool.label}: CLMM pool subscribed`);

    } catch (err: any) {
      console.log(`  ✗ ${pool.label}: ${err?.message}`);
    }
  }

  console.log(`\nSubscribed to ${totalSubscriptions} pool accounts`);
  console.log(`\n${'─'.repeat(70)}`);
  console.log('INITIAL PRICE BOOK:');
  console.log(`${'─'.repeat(70)}`);
  printPriceBook();
  console.log(`\n${'─'.repeat(70)}`);
  console.log('WAITING FOR LIVE UPDATES (Ctrl+C to stop)...');
  console.log(`${'─'.repeat(70)}\n`);

  // Keep alive
  setInterval(() => {
    console.log(`\n--- Status: ${totalUpdates} updates, ${totalSpreads} spreads, ${priceBook.size} prices tracked ---\n`);
    printPriceBook();
  }, 30_000);
}

function handleVaultChange(vaultAddress: string, info: AccountInfo<Buffer>, ctx: Context): void {
  const mapping = vaultToPool.get(vaultAddress);
  if (!mapping) return;

  const { poolAddress, side } = mapping;
  const state = poolState.get(poolAddress);
  if (!state) return;

  const data = info.data;
  if (!data || data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return;

  // SPL Token Account layout: offset 64 = amount (u64 LE)
  const newAmount = data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);

  if (side === 'base') {
    state.baseReserve = newAmount;
  } else {
    state.quoteReserve = newAmount;
  }

  const effectiveBase = state.baseReserve > state.basePnl ? state.baseReserve - state.basePnl : 0n;
  const effectiveQuote = state.quoteReserve > state.quotePnl ? state.quoteReserve - state.quotePnl : 0n;

  updatePriceBookEntry(poolAddress, effectiveBase, effectiveQuote, ctx.slot);
}

function handleAmmAccountChange(poolAddress: string, info: AccountInfo<Buffer>, ctx: Context): void {
  const data = info.data;
  if (!data || data.length < AMM_V4_MIN_DATA_LENGTH) return;

  const state = poolState.get(poolAddress);
  if (!state) return;

  // Update PnL fields
  state.basePnl = data.readBigUInt64LE(AMM_V4_BASE_PNL_OFFSET);
  state.quotePnl = data.readBigUInt64LE(AMM_V4_QUOTE_PNL_OFFSET);

  const effectiveBase = state.baseReserve > state.basePnl ? state.baseReserve - state.basePnl : 0n;
  const effectiveQuote = state.quoteReserve > state.quotePnl ? state.quoteReserve - state.quotePnl : 0n;

  updatePriceBookEntry(poolAddress, effectiveBase, effectiveQuote, ctx.slot);
}

function parseClmmData(poolAddress: string, data: Buffer, slot: number): { baseReserve: bigint; quoteReserve: bigint } | null {
  if (data.length < CLMM_MIN_DATA_LENGTH) return null;

  // sqrtPriceX64 is a u128 LE at offset 253
  const lo = data.readBigUInt64LE(CLMM_SQRT_PRICE_X64_OFFSET);
  const hi = data.readBigUInt64LE(CLMM_SQRT_PRICE_X64_OFFSET + 8);
  const sqrtPriceX64 = (hi << 64n) | lo;
  if (sqrtPriceX64 === 0n) return null;

  // rawPrice = (sqrtPriceX64 / 2^64)^2 = mint0_atomic per mint1_atomic
  // Token order varies: mint0=SOL,mint1=token OR mint0=token,mint1=SOL
  // Read mint0 to determine direction.
  const dec0 = data[CLMM_MINT_DECIMALS_0_OFFSET];
  const dec1 = data[CLMM_MINT_DECIMALS_1_OFFSET];
  const sqrtPrice = Number(sqrtPriceX64) / 2 ** 64;
  const adjPrice = sqrtPrice * sqrtPrice * (10 ** (dec0 - dec1));

  const mint0 = new PublicKey(data.subarray(73, 73 + 32));
  const mint0IsSol = mint0.toString() === SOL_MINT;
  // If mint0=SOL: adjPrice = token_per_SOL → invert
  // If mint0=token: adjPrice = SOL_per_token → use directly
  const solPerToken = mint0IsSol
    ? (adjPrice > 0 ? 1 / adjPrice : 0)
    : adjPrice;

  // Store as pseudo-reserves: reserveA = SOL_per_token * 1e9, reserveB = 1e9
  const SCALE = 1_000_000_000n;
  const scaledPrice = BigInt(Math.round(solPerToken * 1e9));

  return { baseReserve: scaledPrice, quoteReserve: SCALE };
}

function handleClmmChange(poolAddress: string, info: AccountInfo<Buffer>, ctx: Context): void {
  const result = parseClmmData(poolAddress, info.data, ctx.slot);
  if (!result) return;
  updatePriceBookEntry(poolAddress, result.baseReserve, result.quoteReserve, ctx.slot);
}

function printPriceBook(): void {
  // Group by token
  const byToken = new Map<string, PriceEntry[]>();
  for (const entry of priceBook.values()) {
    const list = byToken.get(entry.tokenSymbol) || [];
    list.push(entry);
    byToken.set(entry.tokenSymbol, list);
  }

  for (const [symbol, entries] of byToken) {
    entries.sort((a, b) => a.price - b.price);
    console.log(`\n  ${symbol}/SOL:`);
    for (const e of entries) {
      const baseLabel = e.poolType === 'clmm'
        ? '(CLMM pseudo)'
        : `${formatReserve(e.baseReserve, e.tokenDecimals)} ${symbol}`;
      const quoteLabel = e.poolType === 'clmm'
        ? '(CLMM pseudo)'
        : `${formatReserve(e.quoteReserve, 9)} SOL`;
      console.log(
        `    ${e.dex.padEnd(12)} ${e.label.padEnd(20)} ` +
        `price=${e.price.toFixed(10).padEnd(16)} ` +
        `base=${baseLabel.padEnd(22)} quote=${quoteLabel}`,
      );
    }
    if (entries.length >= 2) {
      const lo = entries[0].price;
      const hi = entries[entries.length - 1].price;
      const spread = lo > 0 ? ((hi - lo) / lo) * 10_000 : 0;
      console.log(`    → Spread: ${spread.toFixed(2)} bps (buy=${entries[0].dex}, sell=${entries[entries.length - 1].dex})`);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
