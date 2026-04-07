/**
 * Phase D — Step D1: Meteora DLMM (LB CLMM) LbPair layout research
 *
 * DLMM = Dynamic Liquidity Market Maker. Bin-based concentrated liquidity
 * (similar to Trader Joe v2 / "Liquidity Book"). Each bin holds reserves at
 * a fixed price = (1 + binStep/10000)^binId. Swaps traverse bins from
 * activeId outward, consuming bin reserves until the input is exhausted.
 *
 * Program ID: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
 * Source    : https://github.com/MeteoraAg/dlmm-sdk
 * Account   : LbPair (1208 bytes on chain incl. 8-byte Anchor discriminator).
 *
 * LbPair layout (post 8-byte Anchor discriminator), derived from idl.json:
 *
 *   off   0  parameters                StaticParameters (32)
 *               u16 base_factor
 *               u16 filter_period
 *               u16 decay_period
 *               u16 reduction_factor
 *               u32 variable_fee_control
 *               u32 max_volatility_accumulator
 *               i32 min_bin_id
 *               i32 max_bin_id
 *               u16 protocol_share
 *               u8  base_fee_power_factor
 *               u8  function_type
 *               [u8;4] padding
 *   off  32  v_parameters              VariableParameters (32)
 *               u32 volatility_accumulator
 *               u32 volatility_reference
 *               i32 index_reference
 *               [u8;4] padding
 *               i64 last_update_timestamp
 *               [u8;8] padding
 *   off  64  bump_seed                 u8
 *   off  65  bin_step_seed             [u8;2]
 *   off  67  pair_type                 u8
 *   off  68  active_id                 i32     <-- current bin
 *   off  72  bin_step                  u16     <-- price step in basis points
 *   off  74  status                    u8
 *   off  75  require_base_factor_seed  u8
 *   off  76  base_factor_seed          [u8;2]
 *   off  78  activation_type           u8
 *   off  79  creator_pool_on_off_ctrl  u8
 *   off  80  token_x_mint              Pubkey
 *   off 112  token_y_mint              Pubkey
 *   off 144  reserve_x                 Pubkey  <-- vault X
 *   off 176  reserve_y                 Pubkey  <-- vault Y
 *   off 208  protocol_fee              ProtocolFee (16: u64 amount_x, u64 amount_y)
 *   off 224  _padding_1                [u8;32]
 *   off 256  reward_infos              [RewardInfo;2] (288)
 *   off 544  oracle                    Pubkey
 *   off 576  bin_array_bitmap          [u64;16] (128)  <-- 1024 bits centred on bin 0
 *   off 704  last_updated_at           i64
 *   off 712  _padding_2                [u8;32]
 *   off 744  pre_activation_swap_addr  Pubkey
 *   off 776  base_key                  Pubkey
 *   off 808  activation_point          u64
 *   off 816  pre_activation_duration   u64
 *   off 824  _padding_3                [u8;8]
 *   off 832  _padding_4                u64
 *   off 840  creator                   Pubkey
 *   off 872  token_mint_x_program_flag u8       <-- 0 = SPL Token, 1 = Token-2022
 *   off 873  token_mint_y_program_flag u8
 *   off 874  version                   u8
 *   off 875  _reserved                 [u8;21]
 *   --- documented length 896. On-chain accounts are 1200 bytes post-disc;
 *       the trailing ~304 bytes are program-extended reserved space not used
 *       by the swap math we care about. [TODO-VERIFY on GCP]
 *
 * Swap math (per bin, X-for-Y direction):
 *   price_per_bin     = (1 + bin_step/10000)^active_id   (Q64.64)
 *   amount_in_after_fee = amount_in - fee
 *     where fee = amount_in * (base_fee + variable_fee) / 1e9
 *     base_fee     = base_factor * bin_step * 10                       (1e9 denom)
 *     variable_fee = (volatility_accumulator * bin_step)^2
 *                       * variable_fee_control / 100                    (1e9 denom)
 *   amount_out      = amount_in_after_fee * price                       (Q64.64)
 *   If a bin's liquidity is exhausted the swap moves to the next bin
 *   (active_id±1) and repeats. Bin reserves live in BinArray accounts.
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Verified Meteora DLMM SOL pools (owner == DLMM program), confirmed via
// Jupiter direct routing + on-chain getAccountInfo owner check.
const POOLS: Array<{ label: string; address: string }> = [
  { label: 'BONK/SOL DLMM', address: '6oFWm7KPLfxnwMb3z5xwBoXNSPP3JJyirAPqPSiVcnsp' },
  { label: 'JUP/SOL DLMM',  address: 'Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf' },
  { label: 'JLP/SOL DLMM',  address: 'G7ixPyiyNeggVf1VanSetFMNbVuVCPtimJmd9axfQqng' },
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
function readU16LE(buf: Buffer, off: number): number { return buf.readUInt16LE(off); }
function readU32LE(buf: Buffer, off: number): number { return buf.readUInt32LE(off); }
function readI32LE(buf: Buffer, off: number): number { return buf.readInt32LE(off); }
function readI64LE(buf: Buffer, off: number): bigint { return buf.readBigInt64LE(off); }
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface DecodedLbPair {
  // StaticParameters
  baseFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  protocolShare: number;
  // VariableParameters
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: bigint;
  // Pair
  pairType: number;
  activeId: number;
  binStep: number;
  status: number;
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  protocolFeeAmountX: bigint;
  protocolFeeAmountY: bigint;
  oracle: string;
  lastUpdatedAt: bigint;
  creator: string;
  tokenMintXProgramFlag: number;
  tokenMintYProgramFlag: number;
}

function decodeLbPair(body: Buffer): DecodedLbPair {
  return {
    // StaticParameters @ 0
    baseFactor:               readU16LE(body, 0),
    filterPeriod:             readU16LE(body, 2),
    decayPeriod:              readU16LE(body, 4),
    reductionFactor:          readU16LE(body, 6),
    variableFeeControl:       readU32LE(body, 8),
    maxVolatilityAccumulator: readU32LE(body, 12),
    minBinId:                 readI32LE(body, 16),
    maxBinId:                 readI32LE(body, 20),
    protocolShare:            readU16LE(body, 24),
    // VariableParameters @ 32
    volatilityAccumulator:    readU32LE(body, 32),
    volatilityReference:      readU32LE(body, 36),
    indexReference:           readI32LE(body, 40),
    lastUpdateTimestamp:      readI64LE(body, 48),
    // Pair @ 64..
    pairType:                 readU8(body, 67),
    activeId:                 readI32LE(body, 68),
    binStep:                  readU16LE(body, 72),
    status:                   readU8(body, 74),
    tokenXMint:               readPubkey(body, 80),
    tokenYMint:               readPubkey(body, 112),
    reserveX:                 readPubkey(body, 144),
    reserveY:                 readPubkey(body, 176),
    protocolFeeAmountX:       readU64LE(body, 208),
    protocolFeeAmountY:       readU64LE(body, 216),
    oracle:                   readPubkey(body, 544),
    lastUpdatedAt:            readI64LE(body, 704),
    creator:                  readPubkey(body, 840),
    tokenMintXProgramFlag:    readU8(body, 872),
    tokenMintYProgramFlag:    readU8(body, 873),
  };
}

async function main(): Promise<void> {
  console.log('=== Meteora DLMM LbPair Layout Research (Phase D Step D1) ===');
  console.log('SOL mint    :', SOL_MINT);
  console.log('DLMM program:', METEORA_DLMM_PROGRAM);
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
    if (acct.owner !== METEORA_DLMM_PROGRAM) {
      console.log('  WARN: owner mismatch, expected DLMM program. Got:', acct.owner);
    }

    const data = Buffer.from(acct.data[0], 'base64');
    console.log('  owner program :', acct.owner);
    console.log('  data length   :', data.length, 'bytes (expect 1208)');
    console.log('  discriminator :', data.subarray(0, 8).toString('hex'));

    const body = data.subarray(8);
    let d: DecodedLbPair;
    try {
      d = decodeLbPair(body);
    } catch (err) {
      console.error('  DECODE FAILED:', (err as Error).message);
      continue;
    }

    console.log('  --- StaticParameters ---');
    console.log('  baseFactor                :', d.baseFactor);
    console.log('  filterPeriod              :', d.filterPeriod);
    console.log('  decayPeriod               :', d.decayPeriod);
    console.log('  reductionFactor           :', d.reductionFactor);
    console.log('  variableFeeControl        :', d.variableFeeControl);
    console.log('  maxVolatilityAccumulator  :', d.maxVolatilityAccumulator);
    console.log('  minBinId / maxBinId       :', d.minBinId, '/', d.maxBinId);
    console.log('  protocolShare             :', d.protocolShare);
    console.log('  --- VariableParameters ---');
    console.log('  volatilityAccumulator     :', d.volatilityAccumulator);
    console.log('  volatilityReference       :', d.volatilityReference);
    console.log('  indexReference            :', d.indexReference);
    console.log('  lastUpdateTimestamp       :', d.lastUpdateTimestamp.toString());
    console.log('  --- Pair ---');
    console.log('  pairType                  :', d.pairType);
    console.log('  activeId                  :', d.activeId);
    console.log('  binStep (bps)             :', d.binStep);
    console.log('  status                    :', d.status);
    console.log('  tokenXMint                :', d.tokenXMint, d.tokenXMint === SOL_MINT ? '(SOL)' : '');
    console.log('  tokenYMint                :', d.tokenYMint, d.tokenYMint === SOL_MINT ? '(SOL)' : '');
    console.log('  reserveX vault            :', d.reserveX);
    console.log('  reserveY vault            :', d.reserveY);
    console.log('  protocolFeeAmountX        :', d.protocolFeeAmountX.toString());
    console.log('  protocolFeeAmountY        :', d.protocolFeeAmountY.toString());
    console.log('  oracle                    :', d.oracle);
    console.log('  lastUpdatedAt             :', d.lastUpdatedAt.toString());
    console.log('  creator                   :', d.creator);
    console.log('  tokenXProgramFlag         :', d.tokenMintXProgramFlag, '(0=SPL,1=Token-2022)');
    console.log('  tokenYProgramFlag         :', d.tokenMintYProgramFlag);

    // Approx base fee in bps (no variable fee component): baseFactor * binStep / 1e4
    // (DLMM stores fees with 1e9 denom; baseFactor*binStep gives 1e5-denom value
    //  which divided by 10 yields bps.)
    const approxBaseFeeBps = (d.baseFactor * d.binStep) / 10_000;
    console.log('  approx base fee (bps)     :', approxBaseFeeBps.toFixed(4));

    console.log('');
  }

  console.log('Done. Verify offsets above match the IDL, then proceed to D2.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
