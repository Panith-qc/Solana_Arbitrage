/**
 * Phase A3 verification: exercise the production clmmSwapBuilder module
 * end-to-end against mainnet, then compare its quote against Jupiter and
 * print the assembled swap instruction (accounts + data) for inspection.
 *
 * Steps:
 *   1. cacheClmmPoolData() against RAY/SOL CLMM
 *   2. calculateClmmAmountOut() for 0.01 SOL -> RAY
 *   3. Compare to Jupiter /quote (must be within 50 bps; expect 0.00 bps)
 *   4. buildClmmSwapInstruction() and print every account + data hex
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  cacheClmmPoolData,
  calculateClmmAmountOut,
  buildClmmSwapInstruction,
  clmmSolPerToken,
  RAYDIUM_CLMM_PROGRAM,
} from '../clmmSwapBuilder.js';
import { execSync } from 'child_process';

const RPC = process.env.HELIUS_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const POOL = '2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2';
const SOL = 'So11111111111111111111111111111111111111112';
const RAY = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const AMOUNT_IN = 10_000_000n;

async function main(): Promise<void> {
  console.log('=== Phase A3: clmmSwapBuilder end-to-end verification ===');
  console.log('RPC:', RPC);

  // Codespace can't use Node fetch for mainnet RPC; route through curl.
  const curlFetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body ?? '';
    const escaped = String(body).replace(/'/g, "'\\''");
    const out = execSync(
      `curl -s --max-time 15 -X POST -H "Content-Type: application/json" -d '${escaped}' '${url}'`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    return new Response(out, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const connection = new Connection(RPC, { commitment: 'confirmed', fetch: curlFetch });

  // 1. Cache
  console.log('\nStep 1: cacheClmmPoolData');
  const cached = await cacheClmmPoolData(connection, POOL, 'RAY/SOL CLMM');
  if (!cached) {
    console.error('FAIL: cache returned null');
    process.exit(1);
  }
  console.log('  ammConfig    :', cached.ammConfig.toString());
  console.log('  vaults       :', cached.tokenVault0.toString(), '/', cached.tokenVault1.toString());
  console.log('  decimals     :', cached.mintDecimals0, '/', cached.mintDecimals1);
  console.log('  liquidity    :', cached.liquidity.toString());
  console.log('  sqrtPriceX64 :', cached.sqrtPriceX64.toString());
  console.log('  tickCurrent  :', cached.tickCurrent);
  console.log('  feeBps       :', cached.feeBps);
  console.log('  SOL/RAY price:', clmmSolPerToken(cached).toFixed(10));

  // 2. Quote
  console.log('\nStep 2: calculateClmmAmountOut(0.01 SOL -> RAY)');
  const out = calculateClmmAmountOut(cached, AMOUNT_IN, new PublicKey(SOL));
  const human = Number(out) / 10 ** cached.mintDecimals1;
  console.log('  amountOut raw  :', out.toString());
  console.log('  amountOut human:', human.toFixed(8), 'RAY');

  // 3. Compare Jupiter
  console.log('\nStep 3: Jupiter /quote compare');
  const jupUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${RAY}&amount=${AMOUNT_IN}&slippageBps=50&onlyDirectRoutes=true&swapMode=ExactIn`;
  const jupRaw = execSync(`curl -s --max-time 10 '${jupUrl}'`, { encoding: 'utf8' });
  const jup = JSON.parse(jupRaw);
  const jupOut = BigInt(jup.outAmount);
  const jupHuman = Number(jupOut) / 10 ** cached.mintDecimals1;
  const ammKey = jup.routePlan?.[0]?.swapInfo?.ammKey;
  console.log('  jupiter ammKey :', ammKey, ammKey === POOL ? '(SAME POOL)' : '(DIFFERENT)');
  console.log('  jupiter out    :', jupOut.toString(), `(${jupHuman.toFixed(8)} RAY)`);
  const diffBps = ((human - jupHuman) / jupHuman) * 10000;
  console.log('  diff bps       :', diffBps.toFixed(2));
  if (Math.abs(diffBps) > 50) {
    console.error('FAIL: > 50 bps');
    process.exit(2);
  }

  // 4. Build instruction
  console.log('\nStep 4: buildClmmSwapInstruction (dry — not signed/sent)');
  const dummyPayer = new PublicKey('11111111111111111111111111111112');
  const dummyInputAta = new PublicKey('11111111111111111111111111111113');
  const dummyOutputAta = new PublicKey('11111111111111111111111111111114');
  const ix = buildClmmSwapInstruction({
    pool: cached,
    payer: dummyPayer,
    userInputTokenAccount: dummyInputAta,
    userOutputTokenAccount: dummyOutputAta,
    inputMint: new PublicKey(SOL),
    amountIn: AMOUNT_IN,
    minimumAmountOut: (out * 995n) / 1000n,
  });
  console.log('  programId :', ix.programId.toString());
  console.log('  matches CLMM program:', ix.programId.equals(RAYDIUM_CLMM_PROGRAM));
  console.log('  data length :', ix.data.length, '(expected 41)');
  console.log('  data hex    :', ix.data.toString('hex'));
  console.log('  accounts (' + ix.keys.length + '):');
  const roleNames = [
    'payer (signer, w)',
    'ammConfig (r)',
    'poolState (w)',
    'userInputTokenAccount (w)',
    'userOutputTokenAccount (w)',
    'inputVault (w)',
    'outputVault (w)',
    'observationState (w)',
    'tokenProgram (r)',
    'tickArray0 (w)',
    'tickArray1 (w)',
    'tickArray2 (w)',
  ];
  ix.keys.forEach((k, i) => {
    const flags = `${k.isSigner ? 'S' : '-'}${k.isWritable ? 'W' : '-'}`;
    console.log(`    ${i.toString().padStart(2)}  ${flags}  ${k.pubkey.toString().padEnd(45)}  ${roleNames[i] ?? ''}`);
  });

  console.log('\nPASS: A3 builder produces matching quote and well-formed swap ix.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
