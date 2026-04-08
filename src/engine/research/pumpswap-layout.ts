/**
 * Phase E — Step E1: PumpSwap AMM layout research
 *
 * PumpSwap is the pump.fun AMM program that hosts graduated tokens from
 * the bonding curve. It is a constant-product AMM (x*y=k) with a total
 * fee of 25 bps (20 bps LP + 5 bps protocol; newer pools may also include
 * a small coin_creator fee). Reserves live in two SPL Token accounts
 * referenced by the Pool account (pool_base_token_account /
 * pool_quote_token_account). Like Raydium CPMM, the Pool account itself
 * does NOT store reserves — they're fetched from the vault accounts.
 *
 * Program: see PUMPSWAP_PROGRAM below.
 *
 * Pool layout (post 8-byte Anchor discriminator):
 *   off   8  pool_bump                 u8
 *   off   9  index                     u16
 *   off  11  creator                   Pubkey (32)
 *   off  43  base_mint                 Pubkey (32)   — the meme token
 *   off  75  quote_mint                Pubkey (32)   — SOL (WSOL)
 *   off 107  lp_mint                   Pubkey (32)
 *   off 139  pool_base_token_account   Pubkey (32)   — base vault
 *   off 171  pool_quote_token_account  Pubkey (32)   — quote vault
 *   off 203  lp_supply                 u64
 *   off 211  coin_creator              Pubkey (32)
 *   --- min length 243
 *
 * GlobalConfig layout (post 8-byte Anchor discriminator):
 *   off   8  admin                          Pubkey (32)
 *   off  40  lp_fee_basis_points            u64      (e.g. 20)
 *   off  48  protocol_fee_basis_points      u64      (e.g.  5)
 *   off  56  disable_flags                  u8
 *   off  57  protocol_fee_recipients        [Pubkey; 8] (256)
 *   off 313  coin_creator_fee_basis_points  u64      (0 or small)
 *
 * Total effective fee_bps = lp + protocol + coin_creator  (≈ 25).
 *
 * Swap math (Uniswap V2 style, with bp-denominated fee on input):
 *   amountInAfterFee = amountIn * (10_000 - feeBps) / 10_000
 *   amountOut        = (amountInAfterFee * reserveOut)
 *                       / (reserveIn + amountInAfterFee)
 *
 * E1 script goal: fetch a few candidate pools via Jupiter /quote for a
 * known graduated meme token (BONK, WIF) and decode the pool + global
 * config + vault balances. Layout offsets above must be verified on the
 * GCP VM with real mainnet data before proceeding to E2.
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Program ID for the PumpSwap AMM — specified by Phase E directive.
// Verify on-VM: getProgramAccounts should return pool accounts owned by
// this program.
const PUMPSWAP_PROGRAM = 'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP1';

// Known pump.fun-graduated meme tokens to search for on PumpSwap.
// Used to resolve candidate pool addresses via Jupiter /quote
// (onlyDirectRoutes + restrictIntermediateTokens=false) — the ammKey
// returned by Jupiter's routePlan is the on-chain PumpSwap pool.
const MEME_TOKENS: Array<{ symbol: string; mint: string }> = [
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF',  mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
];

const RPC_URLS: string[] = [
  process.env.HELIUS_RPC_URL || '',
  process.env.RPC_URL || '',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

interface AccountInfoResult {
  data: [string, string];
  owner: string;
  lamports: number;
}

function curlPost(url: string, body: string): string {
  return execSync(
    `curl -s --max-time 10 -X POST -H "Content-Type: application/json" -d '${body}' '${url}'`,
    { encoding: 'utf8' },
  );
}

function curlGet(url: string): string {
  return execSync(`curl -s --max-time 10 '${url}'`, { encoding: 'utf8' });
}

async function fetchAccount(address: string): Promise<AccountInfoResult | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [address, { encoding: 'base64' }],
  });
  for (const rpc of RPC_URLS) {
    try {
      const out = curlPost(rpc, body);
      const json = JSON.parse(out);
      if (json?.result?.value) {
        console.log(`  fetched via ${rpc}`);
        return json.result.value as AccountInfoResult;
      }
    } catch (err) {
      console.error(`  curl failed for ${rpc}: ${(err as Error).message}`);
    }
  }
  return null;
}

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU16LE(buf: Buffer, off: number): number { return buf.readUInt16LE(off); }
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface DecodedPumpPool {
  poolBump: number;
  index: number;
  creator: string;
  baseMint: string;
  quoteMint: string;
  lpMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  lpSupply: bigint;
  coinCreator: string;
}

function decodePumpPool(data: Buffer): DecodedPumpPool {
  return {
    poolBump:               readU8(data, 8),
    index:                  readU16LE(data, 9),
    creator:                readPubkey(data, 11),
    baseMint:               readPubkey(data, 43),
    quoteMint:              readPubkey(data, 75),
    lpMint:                 readPubkey(data, 107),
    poolBaseTokenAccount:   readPubkey(data, 139),
    poolQuoteTokenAccount:  readPubkey(data, 171),
    lpSupply:               readU64LE(data, 203),
    coinCreator:            readPubkey(data, 211),
  };
}

interface DecodedGlobalConfig {
  admin: string;
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  disableFlags: number;
  coinCreatorFeeBps: bigint;
  totalFeeBps: number;
}

function decodeGlobalConfig(data: Buffer): DecodedGlobalConfig {
  const admin             = readPubkey(data, 8);
  const lpFeeBps          = readU64LE(data, 40);
  const protocolFeeBps    = readU64LE(data, 48);
  const disableFlags      = readU8(data, 56);
  const coinCreatorFeeBps = data.length >= 321 ? readU64LE(data, 313) : 0n;
  const totalFeeBps       = Number(lpFeeBps + protocolFeeBps + coinCreatorFeeBps);
  return { admin, lpFeeBps, protocolFeeBps, disableFlags, coinCreatorFeeBps, totalFeeBps };
}

interface JupQuoteRoute {
  swapInfo: { ammKey: string; label: string };
}
interface JupQuoteResponse {
  outAmount: string;
  routePlan: JupQuoteRoute[];
}

/**
 * Resolve a PumpSwap pool address for the given token by asking Jupiter
 * for a direct-route SOL→token quote and reading the ammKey from the
 * returned routePlan. Jupiter's label contains "Pump.fun" for PumpSwap
 * pools — we use that as a filter.
 */
async function resolvePumpSwapPool(mint: string): Promise<string | null> {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT}` +
    `&outputMint=${mint}&amount=100000000&slippageBps=100` +
    `&onlyDirectRoutes=true&swapMode=ExactIn`;
  try {
    const out = curlGet(url);
    const json = JSON.parse(out) as JupQuoteResponse;
    const routes = json?.routePlan || [];
    for (const r of routes) {
      const label = (r.swapInfo?.label || '').toLowerCase();
      if (label.includes('pump')) return r.swapInfo.ammKey;
    }
  } catch (err) {
    console.error('  Jupiter resolve failed:', (err as Error).message);
  }
  return null;
}

// SPL Token account amount is at offset 64
function decodeTokenAmount(data: Buffer): bigint {
  return readU64LE(data, 64);
}

async function main(): Promise<void> {
  console.log('=== PumpSwap Layout Research (Phase E Step E1) ===');
  console.log('SOL mint        :', SOL_MINT);
  console.log('PumpSwap program:', PUMPSWAP_PROGRAM);
  console.log('RPC endpoints   :');
  for (const r of RPC_URLS) console.log('  -', r);
  console.log('');

  // Resolve a pool per candidate meme token via Jupiter.
  const pools: Array<{ label: string; address: string }> = [];
  for (const t of MEME_TOKENS) {
    console.log(`Resolving PumpSwap pool for ${t.symbol} (${t.mint})...`);
    const addr = await resolvePumpSwapPool(t.mint);
    if (addr) {
      console.log(`  -> ${addr}`);
      pools.push({ label: `${t.symbol}/SOL PumpSwap`, address: addr });
    } else {
      console.log('  -> no PumpSwap route returned by Jupiter (may not be graduated)');
    }
  }
  if (pools.length === 0) {
    console.log('\nNo PumpSwap pools resolved. Run on GCP VM with live Jupiter access.');
    process.exit(1);
  }

  // Override via POOLS env var (comma-separated addresses) for manual use.
  if (process.env.POOLS) {
    const extras = process.env.POOLS.split(',').map((s, i) => ({
      label: `ENV-${i}`,
      address: s.trim(),
    }));
    pools.push(...extras);
  }

  for (const pool of pools) {
    console.log(`\n--- ${pool.label} (${pool.address}) ---`);
    const acct = await fetchAccount(pool.address);
    if (!acct) { console.log('  SKIP: could not fetch.'); continue; }
    if (acct.owner !== PUMPSWAP_PROGRAM) {
      console.log('  WARN: owner mismatch, expected PumpSwap program. Got:', acct.owner);
    }
    const data = Buffer.from(acct.data[0], 'base64');
    console.log('  owner program    :', acct.owner);
    console.log('  data length      :', data.length, 'bytes');
    console.log('  discriminator    :', data.subarray(0, 8).toString('hex'));

    let d: DecodedPumpPool;
    try {
      d = decodePumpPool(data);
    } catch (err) {
      console.error('  DECODE FAILED:', (err as Error).message);
      continue;
    }
    console.log('  pool_bump        :', d.poolBump);
    console.log('  index            :', d.index);
    console.log('  creator          :', d.creator);
    console.log('  base_mint        :', d.baseMint, d.baseMint === SOL_MINT ? '(SOL)' : '');
    console.log('  quote_mint       :', d.quoteMint, d.quoteMint === SOL_MINT ? '(SOL)' : '');
    console.log('  lp_mint          :', d.lpMint);
    console.log('  pool_base_vault  :', d.poolBaseTokenAccount);
    console.log('  pool_quote_vault :', d.poolQuoteTokenAccount);
    console.log('  lp_supply        :', d.lpSupply.toString());
    console.log('  coin_creator     :', d.coinCreator);

    // Vault balances — sanity-check that both accounts resolve.
    const [bv, qv] = await Promise.all([
      fetchAccount(d.poolBaseTokenAccount),
      fetchAccount(d.poolQuoteTokenAccount),
    ]);
    if (bv && qv) {
      const baseRaw = decodeTokenAmount(Buffer.from(bv.data[0], 'base64'));
      const quoteRaw = decodeTokenAmount(Buffer.from(qv.data[0], 'base64'));
      console.log('  base vault raw   :', baseRaw.toString());
      console.log('  quote vault raw  :', quoteRaw.toString());
    }
  }

  // GlobalConfig — fee rate. The GlobalConfig PDA is the single-seed
  // ["global_config"] under PumpSwap. We discover it lazily by inspecting
  // any pool's linked config via Anchor account seeds; for the research
  // step we accept it via env and print its decoded fee rate. If not
  // provided, we log a TODO so verification can record the address
  // observed on mainnet.
  if (process.env.PUMPSWAP_GLOBAL_CONFIG) {
    console.log(`\n--- GlobalConfig (${process.env.PUMPSWAP_GLOBAL_CONFIG}) ---`);
    const cfg = await fetchAccount(process.env.PUMPSWAP_GLOBAL_CONFIG);
    if (cfg) {
      const data = Buffer.from(cfg.data[0], 'base64');
      try {
        const c = decodeGlobalConfig(data);
        console.log('  admin                 :', c.admin);
        console.log('  lp_fee_bps            :', c.lpFeeBps.toString());
        console.log('  protocol_fee_bps      :', c.protocolFeeBps.toString());
        console.log('  disable_flags         :', c.disableFlags);
        console.log('  coin_creator_fee_bps  :', c.coinCreatorFeeBps.toString());
        console.log('  -> total fee bps      :', c.totalFeeBps);
      } catch (err) {
        console.error('  decode failed:', (err as Error).message);
      }
    }
  } else {
    console.log('\nNOTE: set PUMPSWAP_GLOBAL_CONFIG=<pubkey> to decode the fee config.');
  }

  console.log('\nDone. Verify offsets above against mainnet data, then proceed to E2.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
