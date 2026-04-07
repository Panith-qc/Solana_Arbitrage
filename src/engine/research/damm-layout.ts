/**
 * Phase D — Step D6: Meteora Dynamic AMM (DAMM v1) Pool layout research
 *
 * Dynamic AMM is a vault-backed constant-product AMM. Unlike CPMM, the pool
 * does NOT hold token reserves directly — instead it holds LP tokens of
 * Meteora dynamic-vault accounts, and the pool's effective reserve on each
 * side is computed as:
 *
 *   reserveA = floor(a_vault.total_amount * pool.a_vault_lp.amount / a_vault.lp_mint.supply)
 *
 * The vaults can rebalance into lending strategies, which is why the pool
 * itself stores no reserve fields. Reserve computation is handled in D7;
 * this script only decodes the Pool account header.
 *
 * Program: Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
 * Source : https://github.com/MeteoraAg/damm-v1-sdk
 *          programs/dynamic-amm/src/state.rs
 * Account: Pool (944 bytes incl. 8-byte Anchor discriminator)
 *
 * Pool layout (post 8-byte Anchor discriminator):
 *
 *   off   0  lp_mint                  Pubkey (32)
 *   off  32  token_a_mint             Pubkey (32)
 *   off  64  token_b_mint             Pubkey (32)
 *   off  96  a_vault                  Pubkey (32)  <-- dynamic-vault account
 *   off 128  b_vault                  Pubkey (32)  <-- dynamic-vault account
 *   off 160  a_vault_lp               Pubkey (32)  <-- pool's vault-LP SPL token acct
 *   off 192  b_vault_lp               Pubkey (32)  <-- pool's vault-LP SPL token acct
 *   off 224  a_vault_lp_bump          u8
 *   off 225  enabled                  bool
 *   off 226  protocol_token_a_fee     Pubkey (32)
 *   off 258  protocol_token_b_fee     Pubkey (32)
 *   off 290  fee_last_updated_at      u64
 *   off 298  _padding0                [u8;24]
 *   off 322  fees PoolFees            32
 *               u64 trade_fee_numerator
 *               u64 trade_fee_denominator
 *               u64 protocol_trade_fee_numerator
 *               u64 protocol_trade_fee_denominator
 *   off 354  pool_type                u8 (+ anchor tag handling)  [TODO-VERIFY remaining]
 *
 *   The remaining ~890 bytes hold curve_type, bootstrapping, partner_info,
 *   padding — none of which we need for swap math. Decoder ignores them.
 *
 * Trade fee bps = trade_fee_numerator * 10000 / trade_fee_denominator.
 */

import { PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const METEORA_DAMM_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

// Verified Meteora Dynamic AMM SOL pools (owner == DAMM program), top by TVL.
const POOLS: Array<{ label: string; address: string }> = [
  { label: 'jitoSOL/SOL DAMM', address: 'ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw' },
  { label: 'mSOL/SOL DAMM',    address: 'HcjZvfeSNJbNkfLD4eEcRBr96AD3w1GpmMppaeRZf7ur' },
  { label: 'bSOL/SOL DAMM',    address: 'DvWpLaNUPqoCGn4foM6hekAPKqMtADJJbJWhwuMiT6vK' },
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
  console.error('  ALL RPC ENDPOINTS FAILED. Run on GCP VM.');
  return null;
}

function readU8(buf: Buffer, off: number): number { return buf.readUInt8(off); }
function readU64LE(buf: Buffer, off: number): bigint { return buf.readBigUInt64LE(off); }
function readPubkey(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

interface DecodedDamm {
  lpMint: string;
  tokenAMint: string;
  tokenBMint: string;
  aVault: string;
  bVault: string;
  aVaultLp: string;
  bVaultLp: string;
  enabled: number;
  protocolTokenAFee: string;
  protocolTokenBFee: string;
  feeLastUpdatedAt: bigint;
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  protocolTradeFeeNumerator: bigint;
  protocolTradeFeeDenominator: bigint;
  feeBps: number;
}

function decodeDammPool(body: Buffer): DecodedDamm {
  const tradeNum = readU64LE(body, 322);
  const tradeDen = readU64LE(body, 330);
  const feeBps = tradeDen === 0n ? 0 : Number((tradeNum * 10_000n) / tradeDen);
  return {
    lpMint:                      readPubkey(body, 0),
    tokenAMint:                  readPubkey(body, 32),
    tokenBMint:                  readPubkey(body, 64),
    aVault:                      readPubkey(body, 96),
    bVault:                      readPubkey(body, 128),
    aVaultLp:                    readPubkey(body, 160),
    bVaultLp:                    readPubkey(body, 192),
    enabled:                     readU8(body, 225),
    protocolTokenAFee:           readPubkey(body, 226),
    protocolTokenBFee:           readPubkey(body, 258),
    feeLastUpdatedAt:            readU64LE(body, 290),
    tradeFeeNumerator:           tradeNum,
    tradeFeeDenominator:         tradeDen,
    protocolTradeFeeNumerator:   readU64LE(body, 338),
    protocolTradeFeeDenominator: readU64LE(body, 346),
    feeBps,
  };
}

async function main(): Promise<void> {
  console.log('=== Meteora Dynamic AMM (v1) Pool Layout Research (Phase D Step D6) ===');
  console.log('SOL mint    :', SOL_MINT);
  console.log('DAMM program:', METEORA_DAMM_PROGRAM);
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
    if (acct.owner !== METEORA_DAMM_PROGRAM) {
      console.log('  WARN: owner mismatch, expected DAMM program. Got:', acct.owner);
    }

    const data = Buffer.from(acct.data[0], 'base64');
    console.log('  owner program :', acct.owner);
    console.log('  data length   :', data.length, 'bytes (expect 944)');
    console.log('  discriminator :', data.subarray(0, 8).toString('hex'));

    const body = data.subarray(8);
    let d: DecodedDamm;
    try {
      d = decodeDammPool(body);
    } catch (err) {
      console.error('  DECODE FAILED:', (err as Error).message);
      continue;
    }

    console.log('  lpMint                 :', d.lpMint);
    console.log('  tokenAMint             :', d.tokenAMint, d.tokenAMint === SOL_MINT ? '(SOL)' : '');
    console.log('  tokenBMint             :', d.tokenBMint, d.tokenBMint === SOL_MINT ? '(SOL)' : '');
    console.log('  aVault                 :', d.aVault);
    console.log('  bVault                 :', d.bVault);
    console.log('  aVaultLp               :', d.aVaultLp);
    console.log('  bVaultLp               :', d.bVaultLp);
    console.log('  enabled                :', d.enabled);
    console.log('  protocolTokenAFee      :', d.protocolTokenAFee);
    console.log('  protocolTokenBFee      :', d.protocolTokenBFee);
    console.log('  feeLastUpdatedAt       :', d.feeLastUpdatedAt.toString());
    console.log('  tradeFeeNumerator      :', d.tradeFeeNumerator.toString());
    console.log('  tradeFeeDenominator    :', d.tradeFeeDenominator.toString());
    console.log('  protocolTradeFeeNum    :', d.protocolTradeFeeNumerator.toString());
    console.log('  protocolTradeFeeDen    :', d.protocolTradeFeeDenominator.toString());
    console.log('  -> trade fee (bps)     :', d.feeBps);
    console.log('');
  }

  console.log('Done. Verify offsets above match the spec, then proceed to D7.');
  console.log('D7 will fetch a_vault, b_vault, a_vault_lp, b_vault_lp + lp_mint');
  console.log('to compute effective reserves and verify swap math vs Jupiter.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
