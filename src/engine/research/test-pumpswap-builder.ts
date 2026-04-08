/**
 * Phase E — Step E5 verification: PumpSwap (pump.fun AMM) builder
 * end-to-end check.
 *
 * 1. Resolves a live PumpSwap pool via Jupiter direct route on a known
 *    meme token (default BONK, override via TOKEN / POOL env).
 * 2. Caches the pool via pumpSwapBuilder.cachePumpSwapPoolData with
 *    skipSafetyChecks=true (the meme-safety gates intentionally kill
 *    almost all pools on first sight — that's the point — so for
 *    offline verification we bypass them). Passes dummy globalConfig
 *    and protocolFeeRecipient so buildPumpSwapInstruction can run.
 * 3. Calls calculatePumpSwapAmountOut for 0.1 SOL -> token.
 * 4. Compares the result against Jupiter /quote (direct route) for the
 *    same exact-in. Must match within 50 bps.
 * 5. Builds the swap instruction (dry, not sent) with dummy user ATAs.
 * 6. Verifies programId == pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA,
 *    keys.length == 17, the event_authority PDA slot, the account
 *    ordering, and the discriminator+args encoding.
 *
 * Exit codes:
 *   0  all checks passed
 *   1  setup/fetch failure
 *   2  swap math drifted > 50 bps vs Jupiter
 *   3  programId mismatch
 *   4  accounts length wrong
 *   5  event authority slot wrong
 *   6  discriminator / args encoding wrong
 *
 * Run: HELIUS_RPC_URL=... npx tsx src/engine/research/test-pumpswap-builder.ts
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import {
  PUMPSWAP_PROGRAM,
  cachePumpSwapPoolData,
  calculatePumpSwapAmountOut,
  buildPumpSwapInstruction,
} from '../pumpSwapBuilder.js';

const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
// Default meme token — BONK is a well-known pump.fun graduate with a live
// PumpSwap pool that Jupiter routes through.
const TOKEN_MINT_STR =
  process.env.TOKEN || 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
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

async function resolvePumpSwapPool(outputMint: string): Promise<string | null> {
  const q = jupiterQuote(outputMint);
  if (!q) return null;
  for (const r of q.routePlan) {
    const label = (r.swapInfo?.label || '').toLowerCase();
    if (label.includes('pump')) return r.swapInfo.ammKey;
  }
  return null;
}

async function main(): Promise<void> {
  console.log('=== Phase E5 verification: PumpSwap builder end-to-end ===');
  console.log('RPC   :', RPC_URL);
  console.log('Token :', TOKEN_MINT_STR);
  console.log('');

  const connection = new Connection(RPC_URL, 'confirmed');

  // Step 0: resolve pool via Jupiter (or POOL env)
  let poolAddr = process.env.POOL || null;
  if (!poolAddr) {
    console.log('Step 0: resolve PumpSwap pool via Jupiter direct route');
    poolAddr = await resolvePumpSwapPool(TOKEN_MINT_STR);
    if (!poolAddr) {
      console.error('FAIL: no PumpSwap route found for token');
      console.error('      Try a different TOKEN env (e.g. another pump.fun graduate).');
      process.exit(1);
    }
    console.log('  pool :', poolAddr);
  } else {
    console.log('Step 0: using POOL env =', poolAddr);
  }
  const POOL_LABEL = 'PumpSwap verification';

  // Step 1: cache the pool (skip safety gates — we're doing offline
  // math verification, not a live trade). Pass dummy globalConfig +
  // protocolFeeRecipient so buildPumpSwapInstruction can run.
  console.log('\nStep 1: cachePumpSwapPoolData (skipSafetyChecks=true)');
  const dummyGlobalConfig = Keypair.generate().publicKey;
  const dummyProtocolFeeRecipient = Keypair.generate().publicKey;
  const dummyProtocolFeeRecipientTokenAccount = Keypair.generate().publicKey;
  const cached = await cachePumpSwapPoolData(connection, poolAddr, POOL_LABEL, {
    skipSafetyChecks: true,
    globalConfig: dummyGlobalConfig,
    protocolFeeRecipient: dummyProtocolFeeRecipient,
    protocolFeeRecipientTokenAccount: dummyProtocolFeeRecipientTokenAccount,
  });
  if (!cached) {
    console.error('FAIL: cachePumpSwapPoolData returned null');
    process.exit(1);
  }
  console.log('  baseMint              :', cached.baseMint.toString());
  console.log('  quoteMint             :', cached.quoteMint.toString(),
    cached.quoteMint.equals(SOL_MINT) ? '(SOL)' : '');
  console.log('  poolBaseTokenAccount  :', cached.poolBaseTokenAccount.toString());
  console.log('  poolQuoteTokenAccount :', cached.poolQuoteTokenAccount.toString());
  console.log('  baseReserve           :', cached.baseReserve.toString());
  console.log('  quoteReserve          :', cached.quoteReserve.toString());
  console.log('  baseDecimals          :', cached.baseDecimals);
  console.log('  feeBps                :', cached.feeBps.toString());
  console.log('  createdAtSec          :', cached.createdAtSec);
  console.log('  hasFreezeAuthority    :', cached.hasFreezeAuthority);

  if (!cached.quoteMint.equals(SOL_MINT)) {
    console.error('FAIL: pool quote mint is not SOL');
    process.exit(1);
  }

  // Step 2: calculate output via builder
  console.log('\nStep 2: calculatePumpSwapAmountOut');
  const ourOut = calculatePumpSwapAmountOut(cached, AMOUNT_IN_LAMPORTS, SOL_MINT);
  const ourHuman = Number(ourOut) / 10 ** cached.baseDecimals;
  console.log('  amountIn  :', AMOUNT_IN_LAMPORTS.toString(), 'lamports SOL');
  console.log('  amountOut :', ourOut.toString(), `(${ourHuman.toFixed(8)})`);

  // Step 3: Jupiter compare
  console.log('\nStep 3: Jupiter /quote (direct route)');
  const jup = jupiterQuote(cached.baseMint.toString());
  if (!jup) {
    console.error('FAIL: no Jupiter quote');
    process.exit(1);
  }
  const jupRaw = BigInt(jup.outAmount);
  const jupHuman = Number(jupRaw) / 10 ** cached.baseDecimals;
  const route = jup.routePlan?.[0]?.swapInfo;
  console.log('  ammKey    :', route?.ammKey, `(${route?.label})`);
  console.log('  outAmount :', jupRaw.toString(), `(${jupHuman.toFixed(8)})`);
  if (route && route.ammKey !== poolAddr) {
    console.log('  WARN: Jupiter routed through a different pool than ours.');
  }
  if (route && route.label && !route.label.toLowerCase().includes('pump')) {
    console.log('  WARN: Jupiter route label does not contain "pump" —', route.label);
  }

  const diff = ourHuman - jupHuman;
  const diffBps = jupHuman === 0 ? Infinity : (diff / jupHuman) * 10_000;
  console.log(`  diff      : ${diff.toFixed(8)} (${diffBps.toFixed(2)} bps)`);
  if (Math.abs(diffBps) > TOLERANCE_BPS) {
    console.error(`FAIL: drift ${diffBps.toFixed(2)} bps exceeds tolerance ${TOLERANCE_BPS} bps`);
    process.exit(2);
  }
  console.log(`  PASS: within ${TOLERANCE_BPS} bps`);

  // Step 4: build swap instruction (dry, not sent)
  console.log('\nStep 4: buildPumpSwapInstruction (dry, not sent)');
  const payer = Keypair.generate().publicKey;
  const userQuoteAta = Keypair.generate().publicKey; // WSOL ATA
  const userBaseAta = Keypair.generate().publicKey;  // meme token ATA
  const minOut = (ourOut * 995n) / 1000n; // 0.5% slippage

  const ix = buildPumpSwapInstruction({
    pool: cached,
    payer,
    userQuoteTokenAccount: userQuoteAta,
    userBaseTokenAccount: userBaseAta,
    inputMint: SOL_MINT, // SOL -> base = Buy direction
    amountIn: AMOUNT_IN_LAMPORTS,
    minimumAmountOut: minOut,
  });

  // Step 5: verify programId
  console.log('  programId :', ix.programId.toString());
  if (!ix.programId.equals(PUMPSWAP_PROGRAM)) {
    console.error(
      `FAIL: programId mismatch. Expected ${PUMPSWAP_PROGRAM.toString()}, got ${ix.programId.toString()}`,
    );
    process.exit(3);
  }
  console.log('  programId matches PUMPSWAP_PROGRAM');

  // Step 6: verify account list + roles (17 keys)
  console.log('\nStep 5: account list (', ix.keys.length, 'accounts)');
  const EXPECTED_N = 17;
  if (ix.keys.length !== EXPECTED_N) {
    console.error(`FAIL: expected ${EXPECTED_N} accounts, got ${ix.keys.length}`);
    process.exit(4);
  }
  const roles = [
    'pool',                                  // 0
    'user (payer, signer)',                  // 1
    'global_config',                         // 2
    'base_mint',                             // 3
    'quote_mint (SOL)',                      // 4
    'user_base_token_account',               // 5
    'user_quote_token_account',              // 6
    'pool_base_token_account',               // 7
    'pool_quote_token_account',              // 8
    'protocol_fee_recipient',                // 9
    'protocol_fee_recipient_token_account',  // 10
    'base_token_program',                    // 11
    'quote_token_program',                   // 12
    'system_program',                        // 13
    'associated_token_program',              // 14
    'event_authority',                       // 15
    'pumpswap_program',                      // 16
  ];
  ix.keys.forEach((k, i) => {
    const flags = (k.isSigner ? 'S' : '-') + (k.isWritable ? 'W' : '-');
    console.log(`  [${String(i).padStart(2, ' ')}] ${flags}  ${k.pubkey.toString().padEnd(44)}  ${roles[i] ?? ''}`);
  });

  // ── Slot sanity checks ────────────────────────────────────────
  const checks: Array<[number, string, PublicKey, boolean, boolean]> = [
    [0, 'pool', cached.poolAddress, false, true],
    [1, 'user', payer, true, true],
    [2, 'global_config', dummyGlobalConfig, false, false],
    [3, 'base_mint', cached.baseMint, false, false],
    [4, 'quote_mint', cached.quoteMint, false, false],
    [5, 'user_base_token_account', userBaseAta, false, true],
    [6, 'user_quote_token_account', userQuoteAta, false, true],
    [7, 'pool_base_token_account', cached.poolBaseTokenAccount, false, true],
    [8, 'pool_quote_token_account', cached.poolQuoteTokenAccount, false, true],
    [9, 'protocol_fee_recipient', dummyProtocolFeeRecipient, false, false],
    [10, 'protocol_fee_recipient_token_account', dummyProtocolFeeRecipientTokenAccount, false, true],
    [16, 'pumpswap_program', PUMPSWAP_PROGRAM, false, false],
  ];
  for (const [idx, name, expected, s, w] of checks) {
    const got = ix.keys[idx];
    if (!got.pubkey.equals(expected)) {
      console.error(`FAIL: slot ${idx} (${name}) pubkey mismatch`);
      console.error(`      expected ${expected.toString()}`);
      console.error(`      got      ${got.pubkey.toString()}`);
      process.exit(4);
    }
    if (got.isSigner !== s || got.isWritable !== w) {
      console.error(
        `FAIL: slot ${idx} (${name}) flags mismatch — expected S=${s} W=${w}, got S=${got.isSigner} W=${got.isWritable}`,
      );
      process.exit(4);
    }
  }
  console.log('  all slot pubkeys + flags match');

  // Verify event_authority PDA
  console.log('\nStep 6: event_authority PDA');
  const [expectedEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMPSWAP_PROGRAM,
  );
  const gotEventAuthority = ix.keys[15].pubkey;
  console.log('  expected :', expectedEventAuthority.toString());
  console.log('  got      :', gotEventAuthority.toString());
  if (!gotEventAuthority.equals(expectedEventAuthority)) {
    console.error('FAIL: event_authority slot does not match derived PDA');
    process.exit(5);
  }
  console.log('  event_authority slot matches derived PDA');

  // Instruction data sanity
  console.log('\nStep 7: instruction data (Buy direction)');
  console.log('  bytes len    :', ix.data.length);
  console.log('  discriminator:', ix.data.subarray(0, 8).toString('hex'));
  const expectedBuyDisc = createHash('sha256').update('global:buy').digest().subarray(0, 8);
  if (!ix.data.subarray(0, 8).equals(expectedBuyDisc)) {
    console.error(
      `FAIL: discriminator mismatch. Expected ${expectedBuyDisc.toString('hex')}, got ${ix.data.subarray(0, 8).toString('hex')}`,
    );
    process.exit(6);
  }
  const argBaseOut = ix.data.readBigUInt64LE(8);
  const argMaxQuoteIn = ix.data.readBigUInt64LE(16);
  console.log('  base_amount_out    :', argBaseOut.toString());
  console.log('  max_quote_amount_in:', argMaxQuoteIn.toString());
  if (argBaseOut !== minOut) {
    console.error(`FAIL: base_amount_out ${argBaseOut} != minOut ${minOut}`);
    process.exit(6);
  }
  if (argMaxQuoteIn !== AMOUNT_IN_LAMPORTS) {
    console.error(`FAIL: max_quote_amount_in ${argMaxQuoteIn} != amountIn ${AMOUNT_IN_LAMPORTS}`);
    process.exit(6);
  }
  console.log('  Buy args encoded correctly');

  // Sell-direction sanity: build a sell ix (base -> SOL) and verify the
  // discriminator + arg order flips.
  console.log('\nStep 8: instruction data (Sell direction)');
  const sellIx = buildPumpSwapInstruction({
    pool: cached,
    payer,
    userQuoteTokenAccount: userQuoteAta,
    userBaseTokenAccount: userBaseAta,
    inputMint: cached.baseMint, // base -> SOL = Sell direction
    amountIn: 1_000_000n,
    minimumAmountOut: 500n,
  });
  const expectedSellDisc = createHash('sha256').update('global:sell').digest().subarray(0, 8);
  if (!sellIx.data.subarray(0, 8).equals(expectedSellDisc)) {
    console.error(
      `FAIL: sell discriminator mismatch. Expected ${expectedSellDisc.toString('hex')}, got ${sellIx.data.subarray(0, 8).toString('hex')}`,
    );
    process.exit(6);
  }
  const sellBaseIn = sellIx.data.readBigUInt64LE(8);
  const sellMinQuoteOut = sellIx.data.readBigUInt64LE(16);
  console.log('  base_amount_in     :', sellBaseIn.toString());
  console.log('  min_quote_amount_out:', sellMinQuoteOut.toString());
  if (sellBaseIn !== 1_000_000n || sellMinQuoteOut !== 500n) {
    console.error('FAIL: sell args encoded incorrectly');
    process.exit(6);
  }
  console.log('  Sell args encoded correctly');

  console.log('\nAll checks PASSED. PumpSwap wiring verified end-to-end.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
