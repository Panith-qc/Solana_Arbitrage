/**
 * Phase B — Step B1: Orca Whirlpool account layout research
 *
 * Goal: fetch known Whirlpool pools from mainnet, decode the Whirlpool
 * account per the on-chain Anchor layout, and print every value so we can
 * verify offsets BEFORE writing the swap builder.
 *
 * Reference: https://github.com/orca-so/whirlpools
 *
 * Whirlpool account layout (after 8-byte Anchor discriminator):
 *   offset   8  whirlpoolsConfig         Pubkey (32)
 *   offset  40  whirlpoolBump            [u8;1]  (1)
 *   offset  41  tickSpacing              u16     (2)
 *   offset  43  tickSpacingSeed          [u8;2]  (2)
 *   offset  45  feeRate                  u16     (2)   // hundredths of bps. 3000 = 30 bps = 0.30%
 *   offset  47  protocolFeeRate          u16     (2)
 *   offset  49  liquidity                u128    (16)
 *   offset  65  sqrtPrice                u128    (16)  // Q64.64 fixed-point
 *   offset  81  tickCurrentIndex         i32     (4)
 *   offset  85  protocolFeeOwedA         u64     (8)
 *   offset  93  protocolFeeOwedB         u64     (8)
 *   offset 101  tokenMintA               Pubkey  (32)
 *   offset 133  tokenVaultA              Pubkey  (32)
 *   offset 165  feeGrowthGlobalA         u128    (16)
 *   offset 181  tokenMintB               Pubkey  (32)
 *   offset 213  tokenVaultB              Pubkey  (32)
 *   offset 245  feeGrowthGlobalB         u128    (16)
 *   offset 261  rewardLastUpdatedTimestamp u64   (8)
 *   offset 269  rewardInfos[3]                   (3 * 128 = 384)
 *   --- min length ~653 bytes
 *
 * Price formula (identical to Uniswap V3 / Raydium CLMM):
 *   price_raw  = (sqrtPrice / 2^64)^2          // tokenB-per-tokenA, raw atomic units
 *   price_adj  = price_raw * 10^(decA - decB)  // human B-per-A
 *
 * In Whirlpool, tokenA and tokenB are sorted lexicographically by mint pubkey,
 * so SOL is sometimes A and sometimes B. We must check at runtime.
 *
 * Environment note: Codespace cannot reach Helius reliably via Node fetch.
 * Falls back to printing curl commands the user can run on the GCP VM.
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// Known Orca Whirlpool pools to inspect.
// SOL/USDC 0.05% and 0.30% are universally referenced and used as sanity
// anchors. The SOL-LST candidates are best-effort and must be verified
// against the orca pools list / API on the VM (Phase B4 will pin them).
const POOLS: Array<{ label: string; address: string }> = [
  // Sanity anchors — well-known
  { label: 'SOL/USDC 0.05% Whirlpool', address: 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ' },
  { label: 'SOL/USDC 0.30% Whirlpool', address: '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm' },
  // SOL-LST candidates — verify in B4
  { label: 'mSOL/SOL Whirlpool (candidate)', address: 'HQcY5n2zP6rW74fyFEhWeBd3LnJpBcZechkvJpmdb8cx' },
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
      { encoding: 'utf8' },
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
    `    curl -s -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["${address}",{"encoding":"base64"}]}' $HELIUS_RPC_URL`,
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
function readU64LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
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

interface DecodedWhirlpool {
  whirlpoolsConfig: string;
  whirlpoolBump: number;
  tickSpacing: number;
  feeRate: number;            // hundredths of bps (3000 = 30 bps = 0.30%)
  protocolFeeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;          // Q64.64
  tickCurrentIndex: number;
  protocolFeeOwedA: bigint;
  protocolFeeOwedB: bigint;
  tokenMintA: string;
  tokenVaultA: string;
  feeGrowthGlobalA: bigint;
  tokenMintB: string;
  tokenVaultB: string;
  feeGrowthGlobalB: bigint;
  rewardLastUpdatedTimestamp: bigint;
}

function decodeWhirlpool(data: Buffer): DecodedWhirlpool {
  // Skip 8-byte Anchor discriminator
  return {
    whirlpoolsConfig:           readPubkey(data, 8),
    whirlpoolBump:              readU8(data, 40),
    tickSpacing:                readU16LE(data, 41),
    // tickSpacingSeed [u8;2] at 43..45 — skipped
    feeRate:                    readU16LE(data, 45),
    protocolFeeRate:            readU16LE(data, 47),
    liquidity:                  readU128LE(data, 49),
    sqrtPrice:                  readU128LE(data, 65),
    tickCurrentIndex:           readI32LE(data, 81),
    protocolFeeOwedA:           readU64LE(data, 85),
    protocolFeeOwedB:           readU64LE(data, 93),
    tokenMintA:                 readPubkey(data, 101),
    tokenVaultA:                readPubkey(data, 133),
    feeGrowthGlobalA:           readU128LE(data, 165),
    tokenMintB:                 readPubkey(data, 181),
    tokenVaultB:                readPubkey(data, 213),
    feeGrowthGlobalB:           readU128LE(data, 245),
    rewardLastUpdatedTimestamp: readU64LE(data, 261),
  };
}

/**
 * Compute SOL-per-token from a decoded Whirlpool. Whirlpool sorts mints
 * lexicographically, so SOL may be A or B.
 *
 * Worked example (SOL/USDC, SOL=A, USDC=B):
 *   decA=9, decB=6, sqrtPrice ~ Q64.64
 *   ratio    = sqrtPrice / 2^64
 *   priceRaw = ratio^2                       // USDC_atomic per SOL_atomic
 *   priceAdj = priceRaw * 10^(decA-decB)     // USDC_human per SOL_human
 *   -> 1 SOL ≈ 150 USDC, so SOL/USDC = 1/150
 *   nonSolPerSol = priceAdj
 *   solPerNonSol = 1 / priceAdj
 */
function computeSolPerToken(d: DecodedWhirlpool): {
  solPerToken: number;
  nonSolMint: string;
  side: 'A' | 'B' | 'none';
} {
  const Q64 = 2n ** 64n;
  const ratio = Number(d.sqrtPrice) / Number(Q64);
  const priceRaw = ratio * ratio; // tokenB-per-tokenA, raw atomic
  // We need decimals to do the human adjustment, but the Whirlpool account
  // does NOT store decimals (unlike Raydium CLMM). For research-only display
  // we leave priceAdj computation to the caller after reading mint accounts.
  // Here we report the raw token-B-per-token-A and the SOL side.
  if (d.tokenMintA === SOL_MINT) {
    return {
      solPerToken: priceRaw === 0 ? NaN : 1 / priceRaw,
      nonSolMint: d.tokenMintB,
      side: 'A',
    };
  } else if (d.tokenMintB === SOL_MINT) {
    return {
      solPerToken: priceRaw,
      nonSolMint: d.tokenMintA,
      side: 'B',
    };
  }
  return { solPerToken: NaN, nonSolMint: '(neither side is SOL)', side: 'none' };
}

async function main(): Promise<void> {
  console.log('=== Orca Whirlpool Layout Research (Phase B Step B1) ===');
  console.log('SOL mint        :', SOL_MINT);
  console.log('Whirlpool program:', ORCA_WHIRLPOOL_PROGRAM);
  console.log('RPC endpoints in order:');
  for (const r of RPC_URLS) console.log('  -', r);
  console.log('');

  for (const pool of POOLS) {
    console.log(`--- ${pool.label} (${pool.address}) ---`);
    let acct: AccountInfoResult | null;
    try {
      acct = await fetchAccount(pool.address);
    } catch (err) {
      console.error('  fetch threw:', (err as Error).message);
      continue;
    }
    if (!acct) {
      console.log('  SKIP: could not fetch.\n');
      continue;
    }
    if (acct.owner !== ORCA_WHIRLPOOL_PROGRAM) {
      console.log('  WARN: owner mismatch, expected Whirlpool program. Got:', acct.owner);
    }

    const data = Buffer.from(acct.data[0], 'base64');
    console.log('  owner program:', acct.owner);
    console.log('  data length  :', data.length, 'bytes');
    console.log('  discriminator:', data.subarray(0, 8).toString('hex'));

    let d: DecodedWhirlpool;
    try {
      d = decodeWhirlpool(data);
    } catch (err) {
      console.error('  DECODE FAILED:', (err as Error).message);
      continue;
    }

    console.log('  whirlpoolsConfig          :', d.whirlpoolsConfig);
    console.log('  whirlpoolBump             :', d.whirlpoolBump);
    console.log('  tickSpacing               :', d.tickSpacing);
    console.log('  feeRate (1/100 bps)       :', d.feeRate, `(= ${(d.feeRate / 10000).toFixed(4)}%)`);
    console.log('  protocolFeeRate           :', d.protocolFeeRate);
    console.log('  liquidity                 :', d.liquidity.toString());
    console.log('  sqrtPrice (Q64.64)        :', d.sqrtPrice.toString());
    console.log('  tickCurrentIndex          :', d.tickCurrentIndex);
    console.log('  protocolFeeOwedA          :', d.protocolFeeOwedA.toString());
    console.log('  protocolFeeOwedB          :', d.protocolFeeOwedB.toString());
    console.log('  tokenMintA                :', d.tokenMintA, d.tokenMintA === SOL_MINT ? '(SOL)' : '');
    console.log('  tokenVaultA               :', d.tokenVaultA);
    console.log('  feeGrowthGlobalA          :', d.feeGrowthGlobalA.toString());
    console.log('  tokenMintB                :', d.tokenMintB, d.tokenMintB === SOL_MINT ? '(SOL)' : '');
    console.log('  tokenVaultB               :', d.tokenVaultB);
    console.log('  feeGrowthGlobalB          :', d.feeGrowthGlobalB.toString());
    console.log('  rewardLastUpdatedTimestamp:', d.rewardLastUpdatedTimestamp.toString());

    const { solPerToken, nonSolMint, side } = computeSolPerToken(d);
    console.log(
      `  -> SOL on side ${side}, raw SOL per ${nonSolMint}: ${Number.isFinite(solPerToken) ? solPerToken.toExponential(6) : 'N/A'}`,
    );
    console.log('  (NOTE: raw — apply 10^(decA-decB) using mint decimals to get human price)');
    console.log('');
  }

  console.log('Done. Verify offsets above match the spec, then proceed to B2.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
