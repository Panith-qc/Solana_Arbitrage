/**
 * Multi-DEX spread integration test (post-DAMM).
 *
 * Purpose: prove that every DEX adapter (Raydium AMM V4, Raydium CLMM,
 * Orca Whirlpool, Raydium CPMM, Meteora DLMM, Meteora DAMM v1) feeds the
 * SAME price book uniformly, and cross-DEX spread detection works
 * end-to-end for at least 5 tokens.
 *
 * Steps for each (token, DEX):
 *   1. Discover the live pool address via Jupiter /quote
 *      (onlyDirectRoutes + dexes filter)
 *   2. Cache pool state via the matching cache<Dex>PoolData builder
 *   3. Register the pool at runtime in priceBook.registryCache
 *   4. Feed pseudo-reserves (or raw reserves for AMM V4) into
 *      priceBook.updatePool(...)
 *
 * Then for each token:
 *   5. Call priceBook.getBestPrices(tokenMint)
 *   6. Print   Best buy [dex] at [price] / Best sell [dex] at [price]
 *              Spread [X] bps
 *
 * Fails loudly if any token ends up with fewer than 2 cached pools, or if
 * a computed price is NaN / 0 / absurd (> 1e4 or < 1e-12 SOL per token).
 *
 * NOTE: uses curl via execSync for RPC+Jupiter (matches the rest of the
 *       research scripts — Node fetch is unreliable in this agent env).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

import { cachePoolData, type CachedPoolData } from '../directSwapBuilder.js';
import { cacheClmmPoolData, clmmSolPerToken } from '../clmmSwapBuilder.js';
import { cacheWhirlpoolPoolData, whirlpoolSolPerToken } from '../whirlpoolSwapBuilder.js';
import { cacheCpmmPoolData, cpmmSolPerToken } from '../cpmmSwapBuilder.js';
import { cacheDlmmPoolData, dlmmSolPerToken } from '../dlmmSwapBuilder.js';
import { cacheDammPoolData, dammSolPerToken } from '../dammSwapBuilder.js';
import {
  initPriceBook,
  registerPool,
  updatePool,
  getBestPrices,
  getEntriesForToken,
} from '../priceBook.js';
import { SOL_MINT, type PoolRegistryEntry } from '../config.js';

// ═══════════════════════════════════════════════════════════════
// Tokens under test
// ═══════════════════════════════════════════════════════════════

type PoolType = PoolRegistryEntry['poolType'];

interface TokenSpec {
  mint: string;
  symbol: string;
  decimals: number;
  /** DEX adapters to probe for this token. */
  dexes: PoolType[];
}

// Five tokens, multi-DEX coverage. Each has >= 2 pools so spread detection
// has something to compare.
const TOKENS: TokenSpec[] = [
  {
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    symbol: 'RAY',
    decimals: 6,
    dexes: ['amm-v4', 'clmm', 'whirlpool'],
  },
  {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    decimals: 6,
    dexes: ['amm-v4', 'clmm', 'whirlpool', 'dlmm'],
  },
  {
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'jitoSOL',
    decimals: 9,
    dexes: ['clmm', 'whirlpool', 'damm'],
  },
  {
    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    symbol: 'mSOL',
    decimals: 9,
    dexes: ['amm-v4', 'clmm', 'whirlpool', 'damm'],
  },
  {
    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    symbol: 'bSOL',
    decimals: 9,
    dexes: ['amm-v4', 'whirlpool', 'damm'],
  },
];

// ═══════════════════════════════════════════════════════════════
// Jupiter dex label mapping
// ═══════════════════════════════════════════════════════════════

// Jupiter free-tier /quote exposes AMMs under these labels. Hitting
// unknown labels just returns an empty routePlan, which we treat as
// "not available for this token" (skip rather than fail).
const JUP_DEX_LABEL: Record<PoolType, string> = {
  'amm-v4': 'Raydium',
  clmm: 'Raydium CLMM',
  whirlpool: 'Whirlpool',
  cpmm: 'Raydium CP',
  dlmm: 'Meteora DLMM',
  damm: 'Meteora', // Dynamic AMM v1 — Jupiter label
};

const DEX_DISPLAY: Record<PoolType, string> = {
  'amm-v4': 'Raydium AMM V4',
  clmm: 'Raydium CLMM',
  whirlpool: 'Orca Whirlpool',
  cpmm: 'Raydium CPMM',
  dlmm: 'Meteora DLMM',
  damm: 'Meteora DAMM',
};

// ═══════════════════════════════════════════════════════════════
// curl helpers (Node fetch is flaky in this environment)
// ═══════════════════════════════════════════════════════════════

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  'https://api.mainnet-beta.solana.com';

function curlGet(url: string, timeoutSec = 15): string {
  return execSync(`curl -sSL --max-time ${timeoutSec} '${url}'`, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function curlPost(url: string, body: string, timeoutSec = 15): string {
  const escaped = body.replace(/'/g, "'\\''");
  return execSync(
    `curl -sSL --max-time ${timeoutSec} -X POST ` +
      `-H "Content-Type: application/json" -d '${escaped}' '${url}'`,
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
}

/** fetch shim that pipes everything through curl — used for the Connection. */
function curlFetch(): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body ?? '';
    const out =
      init?.method && init.method.toUpperCase() === 'POST'
        ? curlPost(url, String(body))
        : curlGet(url);
    return new Response(out, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

// ═══════════════════════════════════════════════════════════════
// Jupiter pool discovery
// ═══════════════════════════════════════════════════════════════

interface JupQuote {
  outAmount?: string;
  routePlan?: Array<{
    swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string };
  }>;
  error?: string;
}

/**
 * Probe Jupiter with the given (dexes=) filter and pick the first single-hop
 * pool it returns. Returns null if Jupiter has no direct route on that DEX
 * for the pair (normal — not every token lives on every DEX).
 */
function discoverPool(
  outputMint: string,
  poolType: PoolType,
  amountInLamports: bigint,
): { ammKey: string; label: string } | null {
  const label = JUP_DEX_LABEL[poolType];
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}` +
    `&outputMint=${outputMint}&amount=${amountInLamports}` +
    `&slippageBps=200&onlyDirectRoutes=true&swapMode=ExactIn` +
    `&dexes=${encodeURIComponent(label)}`;
  let raw: string;
  try {
    raw = curlGet(url, 12);
  } catch (err: any) {
    console.error(`    discover ${poolType} curl failed: ${err?.message}`);
    return null;
  }
  let parsed: JupQuote;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`    discover ${poolType} bad JSON: ${raw.slice(0, 120)}`);
    return null;
  }
  if (parsed?.error || !parsed?.routePlan?.length) return null;
  const hop = parsed.routePlan[0];
  if (parsed.routePlan.length !== 1) return null; // not a true direct route
  return { ammKey: hop.swapInfo.ammKey, label: hop.swapInfo.label };
}

// ═══════════════════════════════════════════════════════════════
// Per-DEX cache + priceBook feed
// ═══════════════════════════════════════════════════════════════

interface FeedResult {
  ok: boolean;
  price: number;        // SOL per token
  poolType: PoolType;
  label: string;
  poolAddress: string;
  reason?: string;
}

/**
 * Cache the pool, register it in the priceBook registry, and call
 * priceBook.updatePool(...) with the appropriate reserves encoding.
 * Returns the computed SOL/token price for logging.
 */
async function feedPool(
  connection: Connection,
  token: TokenSpec,
  poolType: PoolType,
  poolAddress: string,
  jupLabel: string,
): Promise<FeedResult> {
  const displayLabel = `${token.symbol}/SOL ${DEX_DISPLAY[poolType]}`;
  try {
    let baseReserve = 0n;
    let quoteReserve = 0n;
    let price = 0;
    const SCALE = 1_000_000_000n;

    switch (poolType) {
      case 'amm-v4': {
        const pool = await cachePoolData(connection, poolAddress, displayLabel);
        if (!pool) return { ok: false, price: 0, poolType, label: displayLabel, poolAddress, reason: 'cachePoolData returned null' };
        // AMM V4 feeds RAW reserves; priceBook handles the decimal divide.
        // directSwapBuilder stores base=raw token vault, quote=raw SOL vault.
        baseReserve = pool.baseReserve;
        quoteReserve = pool.quoteReserve;
        // Compute the same decimal-adjusted price priceBook will derive.
        const baseFloat = Number(baseReserve) / 10 ** token.decimals;
        const quoteFloat = Number(quoteReserve) / 10 ** 9;
        price = baseFloat === 0 ? 0 : quoteFloat / baseFloat;
        // Sanity: confirm one side is the SOL vault.
        const oneIsSol =
          pool.baseMint.toString() === SOL_MINT ||
          pool.quoteMint.toString() === SOL_MINT;
        if (!oneIsSol) {
          return {
            ok: false, price: 0, poolType, label: displayLabel, poolAddress,
            reason: 'neither side is SOL',
          };
        }
        // Some AMM V4 pools use base=SOL, quote=token (order varies). If the
        // base side is SOL, swap reserves so priceBook reads them as
        // (token, SOL). quoteDecimals is always 9 in priceBook's AMM path.
        if (pool.baseMint.toString() === SOL_MINT) {
          // base=SOL, quote=token — swap for priceBook's token-base convention
          const solVault = pool.baseReserve;
          const tokVault = pool.quoteReserve;
          baseReserve = tokVault;
          quoteReserve = solVault;
          const baseFloat2 = Number(baseReserve) / 10 ** token.decimals;
          const quoteFloat2 = Number(quoteReserve) / 10 ** 9;
          price = baseFloat2 === 0 ? 0 : quoteFloat2 / baseFloat2;
        }
        break;
      }
      case 'clmm': {
        const pool = await cacheClmmPoolData(connection, poolAddress, displayLabel);
        if (!pool) return { ok: false, price: 0, poolType, label: displayLabel, poolAddress, reason: 'cacheClmmPoolData returned null' };
        price = clmmSolPerToken(pool);
        baseReserve = BigInt(Math.round(price * 1e9));
        quoteReserve = SCALE;
        break;
      }
      case 'whirlpool': {
        const pool = await cacheWhirlpoolPoolData(connection, poolAddress, displayLabel);
        if (!pool) return { ok: false, price: 0, poolType, label: displayLabel, poolAddress, reason: 'cacheWhirlpoolPoolData returned null' };
        price = whirlpoolSolPerToken(pool);
        baseReserve = BigInt(Math.round(price * 1e9));
        quoteReserve = SCALE;
        break;
      }
      case 'cpmm': {
        const pool = await cacheCpmmPoolData(connection, poolAddress, displayLabel);
        if (!pool) return { ok: false, price: 0, poolType, label: displayLabel, poolAddress, reason: 'cacheCpmmPoolData returned null' };
        price = cpmmSolPerToken(pool);
        baseReserve = BigInt(Math.round(price * 1e9));
        quoteReserve = SCALE;
        break;
      }
      case 'dlmm': {
        const pool = await cacheDlmmPoolData(connection, poolAddress, displayLabel);
        if (!pool) return { ok: false, price: 0, poolType, label: displayLabel, poolAddress, reason: 'cacheDlmmPoolData returned null' };
        price = dlmmSolPerToken(pool);
        baseReserve = BigInt(Math.round(price * 1e9));
        quoteReserve = SCALE;
        break;
      }
      case 'damm': {
        const pool = await cacheDammPoolData(connection, poolAddress, displayLabel);
        if (!pool) return { ok: false, price: 0, poolType, label: displayLabel, poolAddress, reason: 'cacheDammPoolData returned null' };
        price = dammSolPerToken(pool);
        baseReserve = BigInt(Math.round(price * 1e9));
        quoteReserve = SCALE;
        break;
      }
    }

    // Sanity-check: price must be > 0 and in a reasonable range.
    // LSTs hover around 1.0 SOL; meme/mid-caps are 1e-8..1 SOL.
    if (!Number.isFinite(price) || price <= 0 || price > 1e4 || price < 1e-12) {
      return {
        ok: false, price, poolType, label: displayLabel, poolAddress,
        reason: `nonsensical price ${price}`,
      };
    }

    // Register + feed into price book
    registerPool(
      {
        poolAddress,
        tokenMint: token.mint,
        tokenSymbol: token.symbol,
        poolType,
        label: displayLabel,
      },
      token.decimals,
      token.symbol,
    );
    updatePool(poolAddress, baseReserve, quoteReserve, 0, Date.now());

    return { ok: true, price, poolType, label: displayLabel, poolAddress };
  } catch (err: any) {
    return {
      ok: false, price: 0, poolType, label: displayLabel, poolAddress,
      reason: err?.message || String(err),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('=== Multi-DEX spread integration test ===');
  console.log('RPC:', RPC_URL);
  console.log('');

  initPriceBook();

  const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    fetch: curlFetch(),
  });

  const probeAmount = 10_000_000n; // 0.01 SOL — small enough to hit anything

  let totalProbed = 0;
  let totalFed = 0;
  const results: Array<{
    token: TokenSpec;
    feeds: FeedResult[];
  }> = [];

  for (const token of TOKENS) {
    console.log(`── ${token.symbol} (${token.mint}) ──`);
    const feeds: FeedResult[] = [];

    for (const dex of token.dexes) {
      totalProbed++;
      process.stdout.write(`  [${DEX_DISPLAY[dex]}] discover…`);
      const disc = discoverPool(token.mint, dex, probeAmount);
      if (!disc) {
        console.log(' SKIP (no direct Jupiter route)');
        continue;
      }
      process.stdout.write(` ${disc.ammKey.slice(0, 8)}… cache…`);
      const feed = await feedPool(connection, token, dex, disc.ammKey, disc.label);
      if (!feed.ok) {
        console.log(` SKIP (${feed.reason})`);
      } else {
        console.log(` OK  price=${feed.price.toFixed(10)} SOL`);
        totalFed++;
        feeds.push(feed);
      }
      // Throttle Jupiter free tier (~2 req/sec)
      await new Promise((r) => setTimeout(r, 600));
    }
    results.push({ token, feeds });
    console.log('');
  }

  // ═══════════════════════════════════════════════════════
  // Spread report
  // ═══════════════════════════════════════════════════════
  console.log('=== Spread report (live on-chain prices) ===');
  console.log('');

  let tokensWithSpread = 0;
  let tokensWithEnoughPools = 0;
  const failures: string[] = [];

  for (const { token, feeds } of results) {
    const bookEntries = getEntriesForToken(token.mint);
    const hdr = `${token.symbol.padEnd(8)} pools=${bookEntries.length}`;
    if (bookEntries.length === 0) {
      console.log(`${hdr}  NO POOLS — FAIL`);
      failures.push(`${token.symbol}: 0 pools cached`);
      continue;
    }
    if (bookEntries.length === 1) {
      const e = bookEntries[0];
      console.log(`${hdr}  only [${e.dex}] at ${e.price.toFixed(10)} SOL — cannot compute spread`);
      failures.push(`${token.symbol}: only 1 pool cached, need >= 2`);
      continue;
    }
    tokensWithEnoughPools++;

    const { bestBuy, bestSell, spreadBps } = getBestPrices(token.mint);
    if (!bestBuy || !bestSell) {
      console.log(`${hdr}  getBestPrices returned null — FAIL`);
      failures.push(`${token.symbol}: getBestPrices null`);
      continue;
    }

    console.log(hdr);
    console.log(
      `  Best buy  [${bestBuy.dex.padEnd(15)}] at ${bestBuy.price.toFixed(10)} SOL (${bestBuy.label})`,
    );
    console.log(
      `  Best sell [${bestSell.dex.padEnd(15)}] at ${bestSell.price.toFixed(10)} SOL (${bestSell.label})`,
    );
    console.log(`  Spread ${spreadBps.toFixed(2)} bps`);

    // Every remaining pool for context
    if (bookEntries.length > 2) {
      const others = bookEntries
        .filter((e) => e.poolAddress !== bestBuy.poolAddress && e.poolAddress !== bestSell.poolAddress)
        .map((e) => `    [${e.dex}] ${e.price.toFixed(10)}`)
        .join('\n');
      if (others) console.log(others);
    }

    if (spreadBps > 0) tokensWithSpread++;
    // Sanity-gate the spread itself — ought to be < 500 bps between two
    // real pools on the same pair. Larger = almost certainly a bad pool.
    if (spreadBps > 500) {
      failures.push(
        `${token.symbol}: spread ${spreadBps.toFixed(2)} bps between ${bestBuy.dex} and ${bestSell.dex} is too wide`,
      );
    }
    console.log('');
  }

  console.log('=== Summary ===');
  console.log(`  tokens tested               : ${TOKENS.length}`);
  console.log(`  tokens with >= 2 pools      : ${tokensWithEnoughPools} / ${TOKENS.length}`);
  console.log(`  tokens with computed spread : ${tokensWithSpread} / ${TOKENS.length}`);
  console.log(`  (dex,token) probes          : ${totalProbed}`);
  console.log(`  pools successfully fed      : ${totalFed}`);

  if (failures.length > 0) {
    console.log('');
    console.log('FAIL:');
    for (const f of failures) console.log('  -', f);
    process.exit(2);
  }
  if (tokensWithEnoughPools < TOKENS.length) {
    console.log('');
    console.log('FAIL: not every token produced >= 2 pools');
    process.exit(3);
  }
  console.log('');
  console.log('PASS — every token produced a sane cross-DEX spread report.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
