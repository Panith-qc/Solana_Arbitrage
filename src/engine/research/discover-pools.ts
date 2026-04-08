/**
 * Phase H — Pool Discovery + Token Expansion
 * ==========================================
 *
 * Discovers on-chain liquidity pools for a curated set of 20 tokens
 * across 7 supported DEXes, using Jupiter as the route oracle and the
 * Solana RPC as the authoritative programId verifier.
 *
 * Approach:
 *   1. For each token × direction (SOL→T, T→SOL) × DEX:
 *        call lite-api.jup.ag /swap/v1/quote with dexes=<label> and
 *        onlyDirectRoutes=true — Jupiter returns a single-hop route
 *        through that specific DEX if a pool exists.
 *   2. For every pool address harvested from routePlan[0].swapInfo.ammKey,
 *        call RPC getAccountInfo (dataSlice 0 bytes) and read
 *        account.owner. Compare against the seven known DEX program IDs
 *        to authoritatively identify the DEX. Pools whose owner does not
 *        match any known DEX program are dropped (they could be Launchlab
 *        staging pools, DAMM v2, Phoenix orderbooks, etc. — all outside
 *        this bot's supported set).
 *   3. Deduplicate by pool address, emit a single JSON record per pool.
 *
 * Output schema (one object per pool):
 *   {
 *     address:    <base58 pool pubkey>,
 *     dex:        raydium_amm_v4 | raydium_clmm | raydium_cpmm |
 *                 orca_whirlpool | meteora_dlmm | meteora_dynamic |
 *                 pumpswap,
 *     tokenA:     <base58 mint>,
 *     tokenB:     <base58 mint>,
 *     label:      "<SYMBOL_A>/<SYMBOL_B> <DEX>"
 *   }
 *
 * The script writes the full JSON array to stdout and also to
 * src/engine/research/discovered-pools.json when the OUT env var is set.
 * A human-readable summary is always written to stderr.
 *
 * Run:
 *   HELIUS_RPC_URL=... npx tsx src/engine/research/discover-pools.ts
 *   # or pipe the JSON:
 *   HELIUS_RPC_URL=... OUT=discovered-pools.json npx tsx src/engine/research/discover-pools.ts
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Curated 20-token universe ──────────────────────────────────────────────
// All verified mainnet mints. SOL is the quote side, so the 20 below are the
// "base" tokens we want pools for (plus USDC/USDT cross-pairs via SOL).
interface Token { symbol: string; mint: string; decimals: number; }
const TOKENS: Token[] = [
  { symbol: 'SOL',     mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', decimals: 9 },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', decimals: 9 },
  { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', decimals: 9 },
  { symbol: 'RAY',     mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 },
  { symbol: 'ORCA',    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  decimals: 6 },
  { symbol: 'JUP',     mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  { symbol: 'BONK',    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  { symbol: 'WIF',     mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  { symbol: 'JTO',     mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
  { symbol: 'PYTH',    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6 },
  { symbol: 'RENDER',  mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  decimals: 8 },
  { symbol: 'W',       mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', decimals: 6 },
  { symbol: 'TENSOR',  mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6',  decimals: 9 },
  { symbol: 'DRIFT',   mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', decimals: 6 },
  { symbol: 'MNDE',    mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',  decimals: 9 },
  { symbol: 'HNT',     mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',  decimals: 8 },
  { symbol: 'POPCAT',  mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', decimals: 9 },
];

// ── Supported DEX program IDs ──────────────────────────────────────────────
// These are the seven DEXes this bot has native raw-swap builders for.
// The programId is the authority for the on-chain pool account and is the
// final arbiter of which DEX a pool belongs to.
type DexId =
  | 'raydium_amm_v4'
  | 'raydium_clmm'
  | 'raydium_cpmm'
  | 'orca_whirlpool'
  | 'meteora_dlmm'
  | 'meteora_dynamic'
  | 'pumpswap';

interface DexSpec {
  id: DexId;
  programId: string;
  /** Jupiter dexes= filter label. */
  jupLabel: string;
}

const DEXES: DexSpec[] = [
  { id: 'raydium_amm_v4',  programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', jupLabel: 'Raydium'       },
  { id: 'raydium_clmm',    programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', jupLabel: 'Raydium CLMM'  },
  { id: 'raydium_cpmm',    programId: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', jupLabel: 'Raydium CP'    },
  { id: 'orca_whirlpool',  programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', jupLabel: 'Whirlpool'     },
  { id: 'meteora_dlmm',    programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', jupLabel: 'Meteora DLMM'  },
  { id: 'meteora_dynamic', programId: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', jupLabel: 'Meteora'       },
  { id: 'pumpswap',        programId: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', jupLabel: 'Pump.fun Amm'  },
];

const PROGRAM_TO_DEX: Record<string, DexId> = Object.fromEntries(
  DEXES.map((d) => [d.programId, d.id]),
);

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  'https://api.mainnet-beta.solana.com';

// ── HTTP helpers (shell curl to keep the script dep-free) ──────────────────

function curlGet(url: string): string {
  return execSync(`curl -s --max-time 15 '${url}'`, { encoding: 'utf8' });
}

function rpcPost(body: unknown): any {
  const payload = JSON.stringify(body).replace(/'/g, "'\\''");
  const out = execSync(
    `curl -sX POST -H 'Content-Type: application/json' -d '${payload}' --max-time 15 '${RPC_URL}'`,
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

// ── Jupiter route discovery ────────────────────────────────────────────────

interface JupRouteStep {
  ammKey: string;
  label: string;
  inputMint: string;
  outputMint: string;
}

interface JupQuote {
  outAmount?: string;
  routePlan?: Array<{ swapInfo: JupRouteStep }>;
  error?: string;
  errorCode?: string;
}

function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  dexLabel: string,
): JupQuote | null {
  // URL-encode spaces and periods in the dex label.
  const encodedDex = encodeURIComponent(dexLabel);
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}` +
    `&outputMint=${outputMint}&amount=${amount}&slippageBps=500` +
    `&onlyDirectRoutes=true&swapMode=ExactIn&dexes=${encodedDex}`;
  try {
    const json: JupQuote = JSON.parse(curlGet(url));
    if (json.errorCode === 'NO_ROUTES_FOUND') return null;
    if (!json.outAmount) return null;
    return json;
  } catch (err: any) {
    return null;
  }
}

// ── RPC owner verification ────────────────────────────────────────────────

interface OwnerCacheEntry {
  owner: string | null;
}
const ownerCache = new Map<string, OwnerCacheEntry>();

function fetchAccountOwner(address: string): string | null {
  const hit = ownerCache.get(address);
  if (hit) return hit.owner;
  try {
    const resp = rpcPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      // dataSlice {0,0} means "give me metadata only, zero data bytes".
      params: [address, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
    });
    const owner = resp?.result?.value?.owner ?? null;
    ownerCache.set(address, { owner });
    return owner;
  } catch {
    ownerCache.set(address, { owner: null });
    return null;
  }
}

// ── Amount selection for Token → SOL leg ──────────────────────────────────
// Use "1 full token" worth (10^decimals) as the reverse-direction input.
// This is a round number that's small enough to avoid price-impact errors
// on thin pools, yet large enough to route through meaningful liquidity.
function reverseAmount(token: Token): bigint {
  return BigInt(10) ** BigInt(token.decimals);
}

// ── Main discovery loop ────────────────────────────────────────────────────

interface DiscoveredPool {
  address: string;
  dex: DexId;
  tokenA: string;
  tokenB: string;
  label: string;
}

function symbolByMint(mint: string): string | null {
  const t = TOKENS.find((x) => x.mint === mint);
  return t?.symbol ?? null;
}

function dexShortLabel(id: DexId): string {
  switch (id) {
    case 'raydium_amm_v4':  return 'Raydium AMM V4';
    case 'raydium_clmm':    return 'Raydium CLMM';
    case 'raydium_cpmm':    return 'Raydium CPMM';
    case 'orca_whirlpool':  return 'Orca Whirlpool';
    case 'meteora_dlmm':    return 'Meteora DLMM';
    case 'meteora_dynamic': return 'Meteora DAMM';
    case 'pumpswap':        return 'PumpSwap';
  }
}

async function main(): Promise<void> {
  console.error('=== Phase H: discover-pools ===');
  console.error('RPC    :', RPC_URL);
  console.error('Tokens :', TOKENS.length);
  console.error('DEXes  :', DEXES.length);
  console.error('');

  // Unique map keyed by pool address so we don't double-count pools that
  // surface from multiple directions or via SOL and USDC routing.
  const pools = new Map<string, DiscoveredPool>();

  // Counters for the summary.
  const perDexCount = new Map<DexId, number>();
  const perTokenCount = new Map<string, number>();
  const seenTokens = new Set<string>();

  // Iterate: for each non-SOL token, query both directions against each DEX.
  // SOL appears as quote on both sides of each probe, so SOL itself does not
  // need its own iteration.
  const baseTokens = TOKENS.filter((t) => t.mint !== SOL_MINT);

  for (const token of baseTokens) {
    console.error(`\n[token] ${token.symbol} (${token.mint})`);
    let tokenPoolCount = 0;

    for (const dex of DEXES) {
      // Direction 1: SOL → token
      const fwd = jupiterQuote(SOL_MINT, token.mint, 100_000_000n, dex.jupLabel);
      // Direction 2: token → SOL (confirms bidirectional liquidity)
      const rev = jupiterQuote(token.mint, SOL_MINT, reverseAmount(token), dex.jupLabel);

      const routeSteps: JupRouteStep[] = [];
      if (fwd?.routePlan) routeSteps.push(...fwd.routePlan.map((r) => r.swapInfo));
      if (rev?.routePlan) routeSteps.push(...rev.routePlan.map((r) => r.swapInfo));

      for (const step of routeSteps) {
        const address = step.ammKey;
        if (!address || pools.has(address)) continue;

        // Authoritative DEX identification via on-chain owner check.
        const owner = fetchAccountOwner(address);
        if (!owner) {
          console.error(`  [${dex.id}] ${address} — owner fetch failed, skipping`);
          continue;
        }
        const realDex = PROGRAM_TO_DEX[owner];
        if (!realDex) {
          console.error(
            `  [${dex.id}] ${address} — unknown owner ${owner} (not a supported DEX)`,
          );
          continue;
        }
        if (realDex !== dex.id) {
          // Jupiter label disagrees with on-chain owner. Trust on-chain.
          console.error(
            `  [${dex.id} → ${realDex}] ${address} — label mismatch, using on-chain`,
          );
        }

        const tokenA = step.inputMint;
        const tokenB = step.outputMint;
        const symA = symbolByMint(tokenA) ?? tokenA.slice(0, 4);
        const symB = symbolByMint(tokenB) ?? tokenB.slice(0, 4);
        const entry: DiscoveredPool = {
          address,
          dex: realDex,
          tokenA,
          tokenB,
          label: `${symA}/${symB} ${dexShortLabel(realDex)}`,
        };
        pools.set(address, entry);
        perDexCount.set(realDex, (perDexCount.get(realDex) ?? 0) + 1);
        perTokenCount.set(
          token.symbol,
          (perTokenCount.get(token.symbol) ?? 0) + 1,
        );
        seenTokens.add(token.symbol);
        tokenPoolCount++;
        console.error(`  [${realDex}] ${address}  (${entry.label})`);
      }
    }

    console.error(`  → ${tokenPoolCount} new pools for ${token.symbol}`);
  }

  // Emit results
  const out = Array.from(pools.values()).sort((a, b) => {
    if (a.dex !== b.dex) return a.dex.localeCompare(b.dex);
    return a.label.localeCompare(b.label);
  });

  // Summary
  console.error('\n=== Summary ===');
  console.error(`Total pools   : ${out.length}`);
  console.error(`Unique tokens : ${seenTokens.size}`);
  console.error(`DEXes with ≥1 : ${perDexCount.size}`);
  console.error('Per-DEX:');
  for (const dex of DEXES) {
    console.error(`  ${dex.id.padEnd(18)} ${perDexCount.get(dex.id) ?? 0}`);
  }
  console.error('Per-token:');
  for (const t of baseTokens) {
    console.error(`  ${t.symbol.padEnd(8)} ${perTokenCount.get(t.symbol) ?? 0}`);
  }
  console.error('');
  console.error(
    `${out.length} pools found across ${perDexCount.size} DEXes for ${seenTokens.size} tokens`,
  );

  const json = JSON.stringify(out, null, 2);
  if (process.env.OUT) {
    writeFileSync(process.env.OUT, json);
    console.error(`wrote ${process.env.OUT}`);
  }
  // Always emit JSON to stdout (summary goes to stderr) so it can be piped.
  process.stdout.write(json + '\n');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
