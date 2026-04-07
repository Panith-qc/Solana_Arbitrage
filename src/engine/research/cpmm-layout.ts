/**
 * Phase C — Step C1: Raydium CPMM (Constant Product Market Maker) layout research
 *
 * NOTE: CPMM is the *new* Raydium AMM program — it is NOT the same as
 * AMM V4 (program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8).
 * CPMM is the Anchor-based replacement, program:
 *   CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 *
 * Reference: https://github.com/raydium-io/raydium-cp-swap
 *
 * PoolState layout (post 8-byte Anchor discriminator):
 *   off   8  ammConfig                 Pubkey (32)
 *   off  40  poolCreator               Pubkey (32)
 *   off  72  token0Vault               Pubkey (32)
 *   off 104  token1Vault               Pubkey (32)
 *   off 136  lpMint                    Pubkey (32)
 *   off 168  token0Mint                Pubkey (32)
 *   off 200  token1Mint                Pubkey (32)
 *   off 232  token0Program             Pubkey (32)
 *   off 264  token1Program             Pubkey (32)
 *   off 296  observationKey            Pubkey (32)
 *   off 328  authBump                  u8
 *   off 329  status                    u8
 *   off 330  lpMintDecimals            u8
 *   off 331  mint0Decimals             u8
 *   off 332  mint1Decimals             u8
 *   off 333  lpSupply                  u64
 *   off 341  protocolFeesToken0        u64
 *   off 349  protocolFeesToken1        u64
 *   off 357  fundFeesToken0            u64
 *   off 365  fundFeesToken1            u64
 *   off 373  openTime                  u64
 *   --- min length 381 + padding
 *
 * AmmConfig layout (post 8-byte Anchor discriminator):
 *   off   8  bump                      u8
 *   off   9  disableCreatePool         bool
 *   off  10  index                     u16
 *   off  12  tradeFeeRate              u64    <-- 1e6 denom; 2500 = 25 bps
 *   off  20  protocolFeeRate           u64
 *   off  28  fundFeeRate               u64
 *   off  36  createPoolFee             u64
 *   off  44  protocolOwner             Pubkey (32)
 *   off  76  fundOwner                 Pubkey (32)
 *
 * Reserves come from vault SPL Token accounts (not from the pool itself).
 * Effective reserves = vault.amount - protocolFees - fundFees per side.
 *
 * CPMM math is constant-product (x*y=k) with the ammConfig.tradeFeeRate
 * applied to the input amount (1e6 denom). Identical to Uniswap V2.
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

// Known CPMM pools to inspect — verify on VM, candidates flagged.
const POOLS: Array<{ label: string; address: string }> = [
  { label: 'JTO/SOL CPMM (candidate)', address: '4ct8XU5tKbMNRphWy4rePsS9kBqPxNgwrkXzEXwjhyJp' },
  { label: 'WIF/SOL CPMM (candidate)', address: 'BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U' },
  { label: 'BONK/SOL CPMM (candidate)', address: '6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg' },
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
  console.error('  ALL RPC ENDPOINTS FAILED. Run on GCP VM:');
  console.error(
    `    curl -s -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["${address}",{"encoding":"base64"}]}' $HELIUS_RPC_URL`,
  );
  return null;
}

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface DecodedCpmm {
  ammConfig: string;
  poolCreator: string;
  token0Vault: string;
  token1Vault: string;
  lpMint: string;
  token0Mint: string;
  token1Mint: string;
  token0Program: string;
  token1Program: string;
  observationKey: string;
  authBump: number;
  status: number;
  lpMintDecimals: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  openTime: bigint;
}

function decodeCpmmPoolState(data: Buffer): DecodedCpmm {
  return {
    ammConfig:          readPubkey(data, 8),
    poolCreator:        readPubkey(data, 40),
    token0Vault:        readPubkey(data, 72),
    token1Vault:        readPubkey(data, 104),
    lpMint:             readPubkey(data, 136),
    token0Mint:         readPubkey(data, 168),
    token1Mint:         readPubkey(data, 200),
    token0Program:      readPubkey(data, 232),
    token1Program:      readPubkey(data, 264),
    observationKey:     readPubkey(data, 296),
    authBump:           readU8(data, 328),
    status:             readU8(data, 329),
    lpMintDecimals:     readU8(data, 330),
    mint0Decimals:      readU8(data, 331),
    mint1Decimals:      readU8(data, 332),
    lpSupply:           readU64LE(data, 333),
    protocolFeesToken0: readU64LE(data, 341),
    protocolFeesToken1: readU64LE(data, 349),
    fundFeesToken0:     readU64LE(data, 357),
    fundFeesToken1:     readU64LE(data, 365),
    openTime:           readU64LE(data, 373),
  };
}

interface DecodedAmmConfig {
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  feeBps: number;
}

function decodeCpmmAmmConfig(data: Buffer): DecodedAmmConfig {
  // After 8-byte discriminator
  const tradeFeeRate = readU64LE(data, 12);
  const protocolFeeRate = readU64LE(data, 20);
  const fundFeeRate = readU64LE(data, 28);
  // tradeFeeRate is denominated in 1e6. 2500 = 25 bps.
  const feeBps = Number(tradeFeeRate) / 100;
  return { tradeFeeRate, protocolFeeRate, fundFeeRate, feeBps };
}

async function main(): Promise<void> {
  console.log('=== Raydium CPMM Layout Research (Phase C Step C1) ===');
  console.log('SOL mint    :', SOL_MINT);
  console.log('CPMM program:', RAYDIUM_CPMM_PROGRAM);
  console.log('RPC endpoints:');
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
    if (acct.owner !== RAYDIUM_CPMM_PROGRAM) {
      console.log('  WARN: owner mismatch, expected CPMM program. Got:', acct.owner);
    }

    const data = Buffer.from(acct.data[0], 'base64');
    console.log('  owner program :', acct.owner);
    console.log('  data length   :', data.length, 'bytes');
    console.log('  discriminator :', data.subarray(0, 8).toString('hex'));

    let d: DecodedCpmm;
    try {
      d = decodeCpmmPoolState(data);
    } catch (err) {
      console.error('  DECODE FAILED:', (err as Error).message);
      continue;
    }

    console.log('  ammConfig          :', d.ammConfig);
    console.log('  poolCreator        :', d.poolCreator);
    console.log('  token0Vault        :', d.token0Vault);
    console.log('  token1Vault        :', d.token1Vault);
    console.log('  lpMint             :', d.lpMint);
    console.log('  token0Mint         :', d.token0Mint, d.token0Mint === SOL_MINT ? '(SOL)' : '');
    console.log('  token1Mint         :', d.token1Mint, d.token1Mint === SOL_MINT ? '(SOL)' : '');
    console.log('  token0Program      :', d.token0Program);
    console.log('  token1Program      :', d.token1Program);
    console.log('  observationKey     :', d.observationKey);
    console.log('  authBump           :', d.authBump);
    console.log('  status             :', d.status);
    console.log('  lpMintDecimals     :', d.lpMintDecimals);
    console.log('  mint0Decimals      :', d.mint0Decimals);
    console.log('  mint1Decimals      :', d.mint1Decimals);
    console.log('  lpSupply           :', d.lpSupply.toString());
    console.log('  protocolFeesToken0 :', d.protocolFeesToken0.toString());
    console.log('  protocolFeesToken1 :', d.protocolFeesToken1.toString());
    console.log('  fundFeesToken0     :', d.fundFeesToken0.toString());
    console.log('  fundFeesToken1     :', d.fundFeesToken1.toString());
    console.log('  openTime           :', d.openTime.toString());

    // Fetch ammConfig
    console.log('  --- ammConfig ---');
    const cfg = await fetchAccount(d.ammConfig);
    if (cfg) {
      const cfgData = Buffer.from(cfg.data[0], 'base64');
      try {
        const c = decodeCpmmAmmConfig(cfgData);
        console.log('  tradeFeeRate (1e6) :', c.tradeFeeRate.toString());
        console.log('  protocolFeeRate    :', c.protocolFeeRate.toString());
        console.log('  fundFeeRate        :', c.fundFeeRate.toString());
        console.log('  -> feeBps          :', c.feeBps);
      } catch (err) {
        console.error('  ammConfig decode failed:', (err as Error).message);
      }
    }
    console.log('');
  }

  console.log('Done. Verify offsets above match the spec, then proceed to C2.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
