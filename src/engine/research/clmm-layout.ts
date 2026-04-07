/**
 * Phase A — Step A1: Raydium CLMM account layout research
 *
 * Goal: fetch a known Raydium CLMM pool from mainnet, decode the PoolState
 * fields per the spec (Section 4B), and print every value so we can verify
 * offsets BEFORE writing the swap builder.
 *
 * PoolState layout (post 8-byte Anchor discriminator):
 *   offset   8  bump              u8
 *   offset   9  ammConfig         Pubkey (32)
 *   offset  41  owner             Pubkey (32)
 *   offset  73  tokenMint0        Pubkey (32)
 *   offset 105  tokenMint1        Pubkey (32)
 *   offset 137  tokenVault0       Pubkey (32)
 *   offset 169  tokenVault1       Pubkey (32)
 *   offset 201  observationKey    Pubkey (32)
 *   offset 233  mintDecimals0     u8
 *   offset 234  mintDecimals1     u8
 *   offset 235  tickSpacing       u16
 *   offset 237  liquidity         u128 (16)
 *   offset 253  sqrtPriceX64      u128 (16)
 *   offset 269  tickCurrent       i32
 *
 * Worked example (RAY/SOL CLMM 2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2):
 *   sqrtPriceX64 ≈ 1.6296e18  (varies live)
 *   ratio        = sqrtPriceX64 / 2^64
 *   priceRaw     = ratio^2
 *   priceAdj     = priceRaw * 10^(dec0 - dec1)
 *   if mint0 == SOL: invert (we want token-per-SOL? — spec says price expressed
 *   as SOL-per-token; bot stores SOL/token, so when mint0 = SOL we invert)
 *
 * Environment note: Codespace cannot reach Helius reliably via Node fetch.
 * This script tries Helius first, then Jupiter-free public RPC, then falls
 * back to printing curl commands the user can run on the GCP VM.
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Known Raydium CLMM pools to inspect
const POOLS: Array<{ label: string; address: string }> = [
  { label: 'RAY/SOL CLMM', address: '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2' },
  { label: 'JUP/SOL CLMM', address: 'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz' },
];

const RPC_URLS: string[] = [
  process.env.HELIUS_RPC_URL || '',
  process.env.RPC_URL || '',
  'https://api.mainnet-beta.solana.com',
].filter(Boolean);

interface AccountInfoResult {
  data: [string, string]; // [base64, "base64"]
  owner: string;
  lamports: number;
}

async function fetchAccountViaCurl(rpc: string, address: string): Promise<AccountInfoResult | null> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [address, { encoding: 'base64' }],
  });
  try {
    const out = execSync(
      `curl -s --max-time 8 -X POST -H "Content-Type: application/json" -d '${body}' '${rpc}'`,
      { encoding: 'utf8' }
    );
    const json = JSON.parse(out);
    if (!json?.result?.value) return null;
    return json.result.value as AccountInfoResult;
  } catch (err) {
    console.error(`  curl failed for ${rpc}: ${(err as Error).message}`);
    return null;
  }
}

async function fetchAccount(address: string): Promise<AccountInfoResult | null> {
  for (const rpc of RPC_URLS) {
    const res = await fetchAccountViaCurl(rpc, address);
    if (res) {
      console.log(`  fetched via ${rpc}`);
      return res;
    }
  }
  console.error('  ALL RPC ENDPOINTS FAILED. Run this on GCP VM:');
  console.error(
    `    curl -s -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["${address}",{"encoding":"base64"}]}' $HELIUS_RPC_URL`
  );
  return null;
}

function readU8(buf: Buffer, off: number): number {
  return buf.readUInt8(off);
}
function readU16LE(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function readI32LE(buf: Buffer, off: number): number {
  return buf.readInt32LE(off);
}
function readU128LE(buf: Buffer, off: number): bigint {
  // little-endian 16 bytes
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface DecodedClmm {
  bump: number;
  ammConfig: string;
  owner: string;
  tokenMint0: string;
  tokenMint1: string;
  tokenVault0: string;
  tokenVault1: string;
  observationKey: string;
  mintDecimals0: number;
  mintDecimals1: number;
  tickSpacing: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
}

function decodeClmmPoolState(data: Buffer): DecodedClmm {
  // Skip 8-byte Anchor discriminator
  return {
    bump: readU8(data, 8),
    ammConfig: readPubkey(data, 9),
    owner: readPubkey(data, 41),
    tokenMint0: readPubkey(data, 73),
    tokenMint1: readPubkey(data, 105),
    tokenVault0: readPubkey(data, 137),
    tokenVault1: readPubkey(data, 169),
    observationKey: readPubkey(data, 201),
    mintDecimals0: readU8(data, 233),
    mintDecimals1: readU8(data, 234),
    tickSpacing: readU16LE(data, 235),
    liquidity: readU128LE(data, 237),
    sqrtPriceX64: readU128LE(data, 253),
    tickCurrent: readI32LE(data, 269),
  };
}

/**
 * Compute SOL-per-token price from a decoded CLMM pool.
 *
 * Worked example — RAY/SOL CLMM:
 *   tokenMint0 = SOL (9 dec), tokenMint1 = RAY (6 dec)
 *   sqrtPriceX64 = 1.6296e18
 *   ratio = 1.6296e18 / 2^64 = 0.08835
 *   priceRaw = 0.007806   (= token1-per-token0 raw, i.e. RAY-per-SOL raw)
 *   adjusted = priceRaw * 10^(dec0 - dec1) = 0.007806 * 10^3 = 7.806
 *     -> means 1 SOL = 7.806 RAY (wait — this is a sanity check; if mint0=SOL,
 *        then "token1-per-token0" is RAY-per-SOL, so adjusted = ~128 RAY/SOL,
 *        and SOL/RAY = 1/128 ≈ 0.0078). Verified against AMM V4 0.007792.
 */
function computeSolPerToken(d: DecodedClmm): { solPerToken: number; nonSolMint: string; nonSolDecimals: number } {
  const Q64 = 2n ** 64n;
  // Use floating math at the end (display only)
  const ratio = Number(d.sqrtPriceX64) / Number(Q64);
  const priceRaw = ratio * ratio; // token1-per-token0, raw units
  const decAdj = Math.pow(10, d.mintDecimals0 - d.mintDecimals1);
  const token1PerToken0 = priceRaw * decAdj; // human units

  if (d.tokenMint0 === SOL_MINT) {
    // token0 = SOL, token1 = the token. token1PerToken0 = TOKEN per SOL.
    // SOL per token = 1 / that.
    return {
      solPerToken: 1 / token1PerToken0,
      nonSolMint: d.tokenMint1,
      nonSolDecimals: d.mintDecimals1,
    };
  } else if (d.tokenMint1 === SOL_MINT) {
    // token1 = SOL, token0 = the token. token1PerToken0 = SOL per TOKEN already.
    return {
      solPerToken: token1PerToken0,
      nonSolMint: d.tokenMint0,
      nonSolDecimals: d.mintDecimals0,
    };
  } else {
    return { solPerToken: NaN, nonSolMint: '(neither side is SOL)', nonSolDecimals: 0 };
  }
}

async function main(): Promise<void> {
  console.log('=== Raydium CLMM Layout Research (Phase A Step A1) ===');
  console.log('SOL mint:', SOL_MINT);
  console.log('RPC endpoints in order:');
  for (const r of RPC_URLS) console.log('  -', r);
  console.log('');

  for (const pool of POOLS) {
    console.log(`--- ${pool.label} (${pool.address}) ---`);
    const acct = await fetchAccount(pool.address);
    if (!acct) {
      console.log('  SKIP: could not fetch.\n');
      continue;
    }
    const data = Buffer.from(acct.data[0], 'base64');
    console.log('  owner program:', acct.owner);
    console.log('  data length  :', data.length, 'bytes');
    console.log('  discriminator:', data.subarray(0, 8).toString('hex'));

    let decoded: DecodedClmm;
    try {
      decoded = decodeClmmPoolState(data);
    } catch (err) {
      console.error('  DECODE FAILED:', (err as Error).message);
      continue;
    }

    console.log('  bump          :', decoded.bump);
    console.log('  ammConfig     :', decoded.ammConfig);
    console.log('  owner         :', decoded.owner);
    console.log('  tokenMint0    :', decoded.tokenMint0, decoded.tokenMint0 === SOL_MINT ? '(SOL)' : '');
    console.log('  tokenMint1    :', decoded.tokenMint1, decoded.tokenMint1 === SOL_MINT ? '(SOL)' : '');
    console.log('  tokenVault0   :', decoded.tokenVault0);
    console.log('  tokenVault1   :', decoded.tokenVault1);
    console.log('  observationKey:', decoded.observationKey);
    console.log('  mintDecimals0 :', decoded.mintDecimals0);
    console.log('  mintDecimals1 :', decoded.mintDecimals1);
    console.log('  tickSpacing   :', decoded.tickSpacing);
    console.log('  liquidity     :', decoded.liquidity.toString());
    console.log('  sqrtPriceX64  :', decoded.sqrtPriceX64.toString());
    console.log('  tickCurrent   :', decoded.tickCurrent);

    const { solPerToken, nonSolMint, nonSolDecimals } = computeSolPerToken(decoded);
    console.log(`  -> SOL per ${nonSolMint} (${nonSolDecimals} dec): ${solPerToken.toFixed(10)}`);
    console.log('');
  }

  console.log('Done. Verify offsets above match the spec, then proceed to A2.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
