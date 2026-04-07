/**
 * Phase D — Step D3 verification: DLMM builder end-to-end check
 *
 * 1. Caches the JUP/SOL DLMM pool via dlmmSwapBuilder.cacheDlmmPoolData
 * 2. Calls calculateDlmmAmountOut for 0.01 SOL -> JUP
 * 3. Compares with Jupiter /quote (direct route, DLMM only) within 50 bps
 * 4. Builds the swap instruction (dry, not sent) using dummy user accounts
 * 5. Prints all fixed accounts with roles + 3 bin array PDAs
 * 6. Verifies programId == LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { execSync } from 'child_process';
import {
  METEORA_DLMM_PROGRAM,
  cacheDlmmPoolData,
  calculateDlmmAmountOut,
  buildDlmmSwapInstruction,
  binArrayIndex,
  deriveBinArrayPda,
} from '../dlmmSwapBuilder.js';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
// JUP/SOL DLMM — Jupiter routes JUP directly through DLMM.
const POOL_ADDR = process.env.POOL || 'Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf';
const AMOUNT_IN_LAMPORTS = 10_000_000n; // 0.01 SOL
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
  console.log('=== Phase D3 verification: DLMM builder end-to-end ===');
  console.log('RPC  :', RPC_URL);
  console.log('Pool :', POOL_ADDR);
  console.log('');

  const connection = new Connection(RPC_URL, 'confirmed');

  // Step 1: cache the pool
  console.log('Step 1: cacheDlmmPoolData');
  const cached = await cacheDlmmPoolData(connection, POOL_ADDR, 'JUP/SOL DLMM');
  if (!cached) {
    console.error('FAIL: cacheDlmmPoolData returned null');
    process.exit(1);
  }
  console.log('  tokenXMint :', cached.tokenXMint.toString(),
    cached.tokenXMint.equals(SOL_MINT) ? '(SOL)' : '');
  console.log('  tokenYMint :', cached.tokenYMint.toString(),
    cached.tokenYMint.equals(SOL_MINT) ? '(SOL)' : '');
  console.log('  reserveX   :', cached.reserveX.toString());
  console.log('  reserveY   :', cached.reserveY.toString());
  console.log('  oracle     :', cached.oracle.toString());
  console.log('  decimals   :', `X=${cached.decimalsX} Y=${cached.decimalsY}`);
  console.log('  activeId   :', cached.activeId);
  console.log('  binStep    :', cached.binStep);
  console.log('  baseFactor :', cached.baseFactor);
  console.log('  vaultX     :', cached.vaultXAmount.toString());
  console.log('  vaultY     :', cached.vaultYAmount.toString());

  const xIsSol = cached.tokenXMint.equals(SOL_MINT);
  const yIsSol = cached.tokenYMint.equals(SOL_MINT);
  if (!xIsSol && !yIsSol) {
    console.error('FAIL: pool has no SOL side');
    process.exit(1);
  }
  const outputMint = xIsSol ? cached.tokenYMint : cached.tokenXMint;
  const outputDecimals = xIsSol ? cached.decimalsY : cached.decimalsX;

  // Step 2: calculate output via builder
  console.log('\nStep 2: calculateDlmmAmountOut');
  const ourOut = calculateDlmmAmountOut(cached, AMOUNT_IN_LAMPORTS, SOL_MINT);
  const ourHuman = Number(ourOut) / 10 ** outputDecimals;
  console.log('  amountIn  :', AMOUNT_IN_LAMPORTS.toString(), 'lamports SOL');
  console.log('  amountOut :', ourOut.toString(), `(${ourHuman.toFixed(8)})`);

  // Step 3: Jupiter compare
  console.log('\nStep 3: Jupiter /quote (direct DLMM route)');
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
  if (route && route.label && !route.label.includes('Meteora DLMM')) {
    console.log('  WARN: Jupiter route label is not Meteora DLMM —', route.label);
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
  console.log('\nStep 4: buildDlmmSwapInstruction (dry, not sent)');
  const payer = Keypair.generate().publicKey;
  // Dummy user ATAs (real executor derives/creates these; for dry build we
  // just need non-null PublicKeys so the IX can be assembled).
  const userInputAta = Keypair.generate().publicKey;
  const userOutputAta = Keypair.generate().publicKey;
  const minOut = (ourOut * 995n) / 1000n; // 0.5% slippage

  const ix = buildDlmmSwapInstruction({
    pool: cached,
    payer,
    userInputTokenAccount: userInputAta,
    userOutputTokenAccount: userOutputAta,
    inputMint: SOL_MINT,
    amountIn: AMOUNT_IN_LAMPORTS,
    minimumAmountOut: minOut,
  });

  // Step 6: verify programId
  console.log('  programId :', ix.programId.toString());
  if (!ix.programId.equals(METEORA_DLMM_PROGRAM)) {
    console.error(
      `FAIL: programId mismatch. Expected ${METEORA_DLMM_PROGRAM.toString()}, got ${ix.programId.toString()}`,
    );
    process.exit(3);
  }
  console.log('  programId matches METEORA_DLMM_PROGRAM');

  // Step 5: print all accounts with roles
  console.log('\nStep 5: account list (', ix.keys.length, 'accounts)');
  const roles = [
    'lb_pair',
    'bin_array_bitmap_extension (optional=program)',
    'reserve_x',
    'reserve_y',
    'user_token_in',
    'user_token_out',
    'token_x_mint',
    'token_y_mint',
    'oracle',
    'host_fee_in (optional=program)',
    'user (payer, signer)',
    'token_x_program',
    'token_y_program',
    'event_authority',
    'program',
    'bin_array_lower (remaining)',
    'bin_array_active (remaining)',
    'bin_array_upper (remaining)',
  ];
  ix.keys.forEach((k, i) => {
    const flags =
      (k.isSigner ? 'S' : '-') + (k.isWritable ? 'W' : '-');
    console.log(`  [${String(i).padStart(2, ' ')}] ${flags}  ${k.pubkey.toString().padEnd(44)}  ${roles[i] ?? ''}`);
  });

  // Bin arrays
  console.log('\nStep 6: bin array PDAs (derived from activeId =', cached.activeId + ')');
  const idx = binArrayIndex(cached.activeId);
  console.log('  binArrayIndex(active_id) =', idx);
  console.log('  lower  (idx-1 =', idx - 1, '):', deriveBinArrayPda(cached.poolAddress, idx - 1).toString());
  console.log('  active (idx   =', idx, ')  :', deriveBinArrayPda(cached.poolAddress, idx).toString());
  console.log('  upper  (idx+1 =', idx + 1, '):', deriveBinArrayPda(cached.poolAddress, idx + 1).toString());

  // Instruction data sanity
  console.log('\nStep 7: instruction data');
  console.log('  bytes len    :', ix.data.length);
  console.log('  discriminator:', ix.data.subarray(0, 8).toString('hex'));
  console.log('  amount_in    :', ix.data.readBigUInt64LE(8).toString());
  console.log('  min_out      :', ix.data.readBigUInt64LE(16).toString());

  console.log('\nAll checks PASSED. Ready for D4 wiring.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
