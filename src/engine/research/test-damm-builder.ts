/**
 * Phase D — Step D10 verification: DAMM (Meteora Dynamic AMM v1) builder
 * end-to-end check.
 *
 * 1. Caches the jitoSOL/SOL DAMM pool via dammSwapBuilder.cacheDammPoolData
 *    (decodes pool, fetches both dynamic-vaults, vault-LP token accts,
 *    LP mint supplies, mint decimals, and the live SPL stake pool for
 *    Stable+SplStake depeg.)
 * 2. Calls calculateDammAmountOut for 0.1 SOL -> jitoSOL.
 * 3. Compares with Jupiter /quote (direct route) within 50 bps.
 * 4. Builds the swap instruction (dry, not sent) using dummy user accounts.
 * 5. Verifies programId == Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB.
 * 6. Prints all accounts with roles, including the SplStake remaining acct.
 *
 * Run: npx tsx src/engine/research/test-damm-builder.ts
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import {
  METEORA_DAMM_PROGRAM,
  METEORA_DYNAMIC_VAULT_PROGRAM,
  cacheDammPoolData,
  calculateDammAmountOut,
  buildDammSwapInstruction,
  effectiveDammReserves,
} from '../dammSwapBuilder.js';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
// jitoSOL/SOL DAMM (Stable + SplStake depeg) — verified at -0.27 bps in D7.
const POOL_ADDR = process.env.POOL || 'ERgpKaq59Nnfm9YRVAAhnq16cZhHxGcDoDWCzXbhiaNw';
const POOL_LABEL = process.env.POOL_LABEL || 'jitoSOL/SOL DAMM';
const AMOUNT_IN_LAMPORTS = 100_000_000n; // 0.1 SOL
const TOLERANCE_BPS = 50;

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  'https://api.mainnet-beta.solana.com';

function curlGet(url: string): string {
  return execSync(`curl -s --max-time 10 '${url}'`, { encoding: 'utf8' });
}

interface JupQuote {
  outAmount: string;
  routePlan: Array<{ swapInfo: { ammKey: string; label: string } }>;
}
function jupiterQuote(outputMint: string): JupQuote | null {
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT.toString()}` +
    `&outputMint=${outputMint}&amount=${AMOUNT_IN_LAMPORTS}&slippageBps=200` +
    `&onlyDirectRoutes=true&swapMode=ExactIn`;
  try {
    const json = JSON.parse(curlGet(url));
    if (json?.outAmount) return json as JupQuote;
    console.error('  Jupiter response had no outAmount:', JSON.stringify(json).slice(0, 200));
    return null;
  } catch (err) {
    console.error('  Jupiter quote failed:', (err as Error).message);
    return null;
  }
}

async function main(): Promise<void> {
  console.log('=== Phase D10 verification: DAMM v1 builder end-to-end ===');
  console.log('RPC  :', RPC_URL);
  console.log('Pool :', POOL_ADDR, `(${POOL_LABEL})`);
  console.log('');

  const connection = new Connection(RPC_URL, 'confirmed');

  // Step 1: cache the pool
  console.log('Step 1: cacheDammPoolData');
  const cached = await cacheDammPoolData(connection, POOL_ADDR, POOL_LABEL);
  if (!cached) {
    console.error('FAIL: cacheDammPoolData returned null');
    process.exit(1);
  }
  console.log('  tokenAMint     :', cached.tokenAMint.toString(),
    cached.tokenAMint.equals(SOL_MINT) ? '(SOL)' : '');
  console.log('  tokenBMint     :', cached.tokenBMint.toString(),
    cached.tokenBMint.equals(SOL_MINT) ? '(SOL)' : '');
  console.log('  aVault         :', cached.aVault.toString());
  console.log('  bVault         :', cached.bVault.toString());
  console.log('  aTokenVault    :', cached.aTokenVault.toString());
  console.log('  bTokenVault    :', cached.bTokenVault.toString());
  console.log('  aVaultLp       :', cached.aVaultLp.toString());
  console.log('  bVaultLp       :', cached.bVaultLp.toString());
  console.log('  aVaultLpMint   :', cached.aVaultLpMint.toString());
  console.log('  bVaultLpMint   :', cached.bVaultLpMint.toString());
  console.log('  decimals       :', `A=${cached.decimalsA} B=${cached.decimalsB}`);
  console.log('  feeBps         :', cached.feeBps);
  console.log('  curve          :', cached.curve.kind);
  if (cached.curve.kind === 'Stable') {
    console.log('    amp                :', cached.curve.amp.toString());
    console.log('    depegType          :', cached.curve.depegType);
    console.log('    base_virtual_price :', cached.curve.depegBaseVirtualPrice.toString());
  }
  if (cached.stakePool) {
    console.log('  stakePool      :', cached.stakePool.toString());
  }

  const aIsSol = cached.tokenAMint.equals(SOL_MINT);
  const bIsSol = cached.tokenBMint.equals(SOL_MINT);
  if (!aIsSol && !bIsSol) {
    console.error('FAIL: pool has no SOL side');
    process.exit(1);
  }
  const outputMint = aIsSol ? cached.tokenBMint : cached.tokenAMint;
  const outputDecimals = aIsSol ? cached.decimalsB : cached.decimalsA;

  // Effective reserves (vault unlock-aware)
  const { reserveA, reserveB } = effectiveDammReserves(cached);
  console.log('  effectiveResA  :', reserveA.toString());
  console.log('  effectiveResB  :', reserveB.toString());

  // Step 2: calculate output via builder
  console.log('\nStep 2: calculateDammAmountOut');
  const ourOut = calculateDammAmountOut(cached, AMOUNT_IN_LAMPORTS, SOL_MINT);
  const ourHuman = Number(ourOut) / 10 ** outputDecimals;
  console.log('  amountIn  :', AMOUNT_IN_LAMPORTS.toString(), 'lamports SOL');
  console.log('  amountOut :', ourOut.toString(), `(${ourHuman.toFixed(8)})`);

  // Step 3: Jupiter compare
  console.log('\nStep 3: Jupiter /quote (direct route)');
  const jup = jupiterQuote(outputMint.toString());
  if (!jup) {
    console.error('FAIL: no Jupiter quote');
    process.exit(1);
  }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** outputDecimals;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  ammKey    :', route?.ammKey, `(${route?.label})`);
  console.log('  outAmount :', jupRaw.toString(), `(${jupHuman.toFixed(8)})`);
  if (route && route.ammKey !== POOL_ADDR) {
    console.log('  WARN: Jupiter routed through a different pool than ours.');
  }
  if (route && route.label && !route.label.includes('Meteora')) {
    console.log('  WARN: Jupiter route label is not Meteora —', route.label);
  }

  const diff = ourHuman - jupHuman;
  const diffBps = jupHuman === 0 ? Infinity : (diff / jupHuman) * 10_000;
  console.log(`  diff      : ${diff.toFixed(8)} (${diffBps.toFixed(2)} bps)`);
  if (Math.abs(diffBps) > TOLERANCE_BPS) {
    console.error(`FAIL: drift ${diffBps.toFixed(2)} bps exceeds tolerance ${TOLERANCE_BPS} bps`);
    process.exit(2);
  }
  console.log(`  PASS: within ${TOLERANCE_BPS} bps`);

  // Step 4: build swap instruction (dry)
  console.log('\nStep 4: buildDammSwapInstruction (dry, not sent)');
  const payer = Keypair.generate().publicKey;
  const userInputAta = Keypair.generate().publicKey;
  const userOutputAta = Keypair.generate().publicKey;
  const minOut = (ourOut * 995n) / 1000n; // 0.5% slippage

  const ix = buildDammSwapInstruction({
    pool: cached,
    payer,
    userInputTokenAccount: userInputAta,
    userOutputTokenAccount: userOutputAta,
    inputMint: SOL_MINT,
    amountIn: AMOUNT_IN_LAMPORTS,
    minimumAmountOut: minOut,
  });

  // Step 5: verify programId
  console.log('  programId :', ix.programId.toString());
  if (!ix.programId.equals(METEORA_DAMM_PROGRAM)) {
    console.error(
      `FAIL: programId mismatch. Expected ${METEORA_DAMM_PROGRAM.toString()}, got ${ix.programId.toString()}`,
    );
    process.exit(3);
  }
  console.log('  programId matches METEORA_DAMM_PROGRAM');

  // Step 6: print all accounts with roles
  console.log('\nStep 5: account list (', ix.keys.length, 'accounts)');
  const roles = [
    'pool',
    'user_source_token (input)',
    'user_destination_token (output)',
    'a_vault',
    'b_vault',
    'a_token_vault',
    'b_token_vault',
    'a_vault_lp_mint',
    'b_vault_lp_mint',
    'a_vault_lp',
    'b_vault_lp',
    'protocol_token_fee (input-side)',
    'user (payer, signer)',
    'vault_program',
    'token_program',
    'stake_pool (remaining, SplStake depeg)',
  ];
  ix.keys.forEach((k, i) => {
    const flags = (k.isSigner ? 'S' : '-') + (k.isWritable ? 'W' : '-');
    console.log(`  [${String(i).padStart(2, ' ')}] ${flags}  ${k.pubkey.toString().padEnd(44)}  ${roles[i] ?? ''}`);
  });

  // Verify vault_program slot
  const vaultProgramKey = ix.keys[13];
  if (!vaultProgramKey.pubkey.equals(METEORA_DYNAMIC_VAULT_PROGRAM)) {
    console.error(
      `FAIL: vault_program slot mismatch. Expected ${METEORA_DYNAMIC_VAULT_PROGRAM.toString()}, got ${vaultProgramKey.pubkey.toString()}`,
    );
    process.exit(4);
  }
  console.log('  vault_program slot matches METEORA_DYNAMIC_VAULT_PROGRAM');

  // Verify SplStake remaining account is present and matches
  if (
    cached.curve.kind === 'Stable' &&
    cached.curve.depegType === 'SplStake' &&
    cached.stakePool
  ) {
    if (ix.keys.length !== 16) {
      console.error(`FAIL: SplStake pool requires 16 accounts, got ${ix.keys.length}`);
      process.exit(5);
    }
    const stakeKey = ix.keys[15];
    if (!stakeKey.pubkey.equals(cached.stakePool)) {
      console.error(
        `FAIL: stake_pool slot mismatch. Expected ${cached.stakePool.toString()}, got ${stakeKey.pubkey.toString()}`,
      );
      process.exit(6);
    }
    console.log('  stake_pool remaining account matches cached SplStake pool');
  } else {
    if (ix.keys.length !== 15) {
      console.error(`FAIL: non-SplStake pool requires 15 accounts, got ${ix.keys.length}`);
      process.exit(5);
    }
    console.log('  no stake_pool remaining account (curve != Stable+SplStake)');
  }

  // Instruction data sanity
  console.log('\nStep 6: instruction data');
  console.log('  bytes len    :', ix.data.length);
  console.log('  discriminator:', ix.data.subarray(0, 8).toString('hex'));
  console.log('  amount_in    :', ix.data.readBigUInt64LE(8).toString());
  console.log('  min_out      :', ix.data.readBigUInt64LE(16).toString());

  console.log('\nAll checks PASSED. DAMM v1 wiring verified end-to-end.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
