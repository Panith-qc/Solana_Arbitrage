// MIXED-DEX HOT PATH BUILDER
// Builds an atomic 2-leg arbitrage transaction where each leg may be either
// a Raydium AMM V4 pool OR a Raydium CLMM pool. Phase A4 of multi-DEX
// expansion — wires clmmSwapBuilder into the existing hot path so spreads
// detected between AMM and CLMM pools can be executed directly (no Jupiter).
//
// Same instruction order as directSwapBuilder.buildHotPathTransaction:
//   ComputeLimit, ComputePrice, ATAs, WSOL wrap, Buy, Sell, WSOL unwrap, Jito tip
//
// Returns null if unprofitable after fees + tip + minimum profit floor.

import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  Keypair,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import { executionLog } from './logger.js';
import { SOL_MINT } from './config.js';
import { getRandomTipAccount } from './transactionBuilder.js';
import {
  getCachedPool as getCachedAmmPool,
  buildRaydiumSwapInstruction,
  calculateAmountOut as calcAmmAmountOut,
  type CachedPoolData as CachedAmmPool,
} from './directSwapBuilder.js';
import {
  getCachedClmmPool,
  buildClmmSwapInstruction,
  calculateClmmAmountOut,
  type CachedClmmPool,
} from './clmmSwapBuilder.js';
import {
  getCachedWhirlpoolPool,
  buildWhirlpoolSwapInstruction,
  calculateWhirlpoolAmountOut,
  type CachedWhirlpoolPool,
} from './whirlpoolSwapBuilder.js';
import {
  getCachedCpmmPool,
  buildCpmmSwapInstruction,
  calculateCpmmAmountOut,
  type CachedCpmmPool,
} from './cpmmSwapBuilder.js';
import {
  getCachedDlmmPool,
  buildDlmmSwapInstruction,
  calculateDlmmAmountOut,
  type CachedDlmmPool,
} from './dlmmSwapBuilder.js';
import {
  getCachedDammPool,
  buildDammSwapInstruction,
  calculateDammAmountOut,
  type CachedDammPool,
} from './dammSwapBuilder.js';
import {
  getCachedPumpSwapPool,
  buildPumpSwapInstruction,
  calculatePumpSwapAmountOut,
  MAX_PUMPSWAP_TRADE_LAMPORTS,
  type CachedPumpSwapPool,
} from './pumpSwapBuilder.js';

export interface MixedHotPathResult {
  transaction: VersionedTransaction;
  sizeBytes: number;
  expectedProfitLamports: bigint;
  buyPool: string;
  sellPool: string;
  buyDex: 'amm-v4' | 'clmm' | 'whirlpool' | 'cpmm' | 'dlmm' | 'damm' | 'pumpswap';
  sellDex: 'amm-v4' | 'clmm' | 'whirlpool' | 'cpmm' | 'dlmm' | 'damm' | 'pumpswap';
  tipLamports: bigint;
}

export type Resolved =
  | { kind: 'amm'; pool: CachedAmmPool; tokenMint: PublicKey; isSolQuote: boolean }
  | { kind: 'clmm'; pool: CachedClmmPool; tokenMint: PublicKey }
  | { kind: 'whirlpool'; pool: CachedWhirlpoolPool; tokenMint: PublicKey }
  | { kind: 'cpmm'; pool: CachedCpmmPool; tokenMint: PublicKey }
  | { kind: 'dlmm'; pool: CachedDlmmPool; tokenMint: PublicKey }
  | { kind: 'damm'; pool: CachedDammPool; tokenMint: PublicKey }
  | { kind: 'pumpswap'; pool: CachedPumpSwapPool; tokenMint: PublicKey };

export function resolvePool(addr: string): Resolved | null {
  const amm = getCachedAmmPool(addr);
  if (amm) {
    const isSolQuote = amm.quoteMint.equals(NATIVE_MINT) || amm.quoteMint.toString() === SOL_MINT;
    const tokenMint = isSolQuote ? amm.baseMint : amm.quoteMint;
    return { kind: 'amm', pool: amm, tokenMint, isSolQuote };
  }
  const clmm = getCachedClmmPool(addr);
  if (clmm) {
    const tokenMint =
      clmm.tokenMint0.toString() === SOL_MINT ? clmm.tokenMint1 : clmm.tokenMint0;
    return { kind: 'clmm', pool: clmm, tokenMint };
  }
  const whirl = getCachedWhirlpoolPool(addr);
  if (whirl) {
    const tokenMint =
      whirl.tokenMintA.toString() === SOL_MINT ? whirl.tokenMintB : whirl.tokenMintA;
    return { kind: 'whirlpool', pool: whirl, tokenMint };
  }
  const cpmm = getCachedCpmmPool(addr);
  if (cpmm) {
    const tokenMint =
      cpmm.token0Mint.toString() === SOL_MINT ? cpmm.token1Mint : cpmm.token0Mint;
    return { kind: 'cpmm', pool: cpmm, tokenMint };
  }
  const dlmm = getCachedDlmmPool(addr);
  if (dlmm) {
    const tokenMint =
      dlmm.tokenXMint.toString() === SOL_MINT ? dlmm.tokenYMint : dlmm.tokenXMint;
    return { kind: 'dlmm', pool: dlmm, tokenMint };
  }
  const damm = getCachedDammPool(addr);
  if (damm) {
    const tokenMint =
      damm.tokenAMint.toString() === SOL_MINT ? damm.tokenBMint : damm.tokenAMint;
    return { kind: 'damm', pool: damm, tokenMint };
  }
  const pump = getCachedPumpSwapPool(addr);
  if (pump) {
    // PumpSwap quote is always SOL; base is the meme token.
    return { kind: 'pumpswap', pool: pump, tokenMint: pump.baseMint };
  }
  return null;
}

/**
 * Quote SOL -> token (buy leg) for either pool kind. Returns 0n on failure.
 */
export function quoteBuy(r: Resolved, solIn: bigint): bigint {
  if (r.kind === 'amm') {
    const reserveIn = r.isSolQuote ? r.pool.quoteReserve : r.pool.baseReserve;
    const reserveOut = r.isSolQuote ? r.pool.baseReserve : r.pool.quoteReserve;
    return calcAmmAmountOut(
      solIn,
      reserveIn,
      reserveOut,
      r.pool.tradeFeeNumerator,
      r.pool.tradeFeeDenominator,
    );
  }
  if (r.kind === 'clmm') {
    return calculateClmmAmountOut(r.pool, solIn, new PublicKey(SOL_MINT));
  }
  if (r.kind === 'whirlpool') {
    return calculateWhirlpoolAmountOut(r.pool, solIn, new PublicKey(SOL_MINT));
  }
  if (r.kind === 'cpmm') {
    return calculateCpmmAmountOut(r.pool, solIn, new PublicKey(SOL_MINT));
  }
  if (r.kind === 'dlmm') {
    return calculateDlmmAmountOut(r.pool, solIn, new PublicKey(SOL_MINT));
  }
  if (r.kind === 'damm') {
    return calculateDammAmountOut(r.pool, solIn, new PublicKey(SOL_MINT));
  }
  return calculatePumpSwapAmountOut(r.pool, solIn, new PublicKey(SOL_MINT));
}

/**
 * Quote token -> SOL (sell leg) for either pool kind. Returns 0n on failure.
 */
export function quoteSell(r: Resolved, tokenIn: bigint): bigint {
  if (r.kind === 'amm') {
    const reserveIn = r.isSolQuote ? r.pool.baseReserve : r.pool.quoteReserve;
    const reserveOut = r.isSolQuote ? r.pool.quoteReserve : r.pool.baseReserve;
    return calcAmmAmountOut(
      tokenIn,
      reserveIn,
      reserveOut,
      r.pool.tradeFeeNumerator,
      r.pool.tradeFeeDenominator,
    );
  }
  if (r.kind === 'clmm') {
    return calculateClmmAmountOut(r.pool, tokenIn, r.tokenMint);
  }
  if (r.kind === 'whirlpool') {
    return calculateWhirlpoolAmountOut(r.pool, tokenIn, r.tokenMint);
  }
  if (r.kind === 'cpmm') {
    return calculateCpmmAmountOut(r.pool, tokenIn, r.tokenMint);
  }
  if (r.kind === 'dlmm') {
    return calculateDlmmAmountOut(r.pool, tokenIn, r.tokenMint);
  }
  if (r.kind === 'damm') {
    return calculateDammAmountOut(r.pool, tokenIn, r.tokenMint);
  }
  return calculatePumpSwapAmountOut(r.pool, tokenIn, r.tokenMint);
}

/**
 * Build a buy/sell instruction for either pool kind.
 */
function buildLegInstruction(
  r: Resolved,
  walletPk: PublicKey,
  userInputAta: PublicKey,
  userOutputAta: PublicKey,
  inputMint: PublicKey,
  amountIn: bigint,
  minimumAmountOut: bigint,
): TransactionInstruction {
  if (r.kind === 'amm') {
    return buildRaydiumSwapInstruction(
      r.pool,
      userInputAta,
      userOutputAta,
      walletPk,
      amountIn,
      minimumAmountOut,
    );
  }
  if (r.kind === 'clmm') {
    return buildClmmSwapInstruction({
      pool: r.pool,
      payer: walletPk,
      userInputTokenAccount: userInputAta,
      userOutputTokenAccount: userOutputAta,
      inputMint,
      amountIn,
      minimumAmountOut,
    });
  }
  if (r.kind === 'whirlpool') {
    // Whirlpool ix takes A/B accounts in fixed slots, not in/out.
    const inputIsA = r.pool.tokenMintA.equals(inputMint);
    const userTokenAccountA = inputIsA ? userInputAta : userOutputAta;
    const userTokenAccountB = inputIsA ? userOutputAta : userInputAta;
    return buildWhirlpoolSwapInstruction({
      pool: r.pool,
      payer: walletPk,
      userTokenAccountA,
      userTokenAccountB,
      inputMint,
      amountIn,
      minimumAmountOut,
    });
  }
  if (r.kind === 'cpmm') {
    return buildCpmmSwapInstruction({
      pool: r.pool,
      payer: walletPk,
      userInputTokenAccount: userInputAta,
      userOutputTokenAccount: userOutputAta,
      inputMint,
      amountIn,
      minimumAmountOut,
    });
  }
  if (r.kind === 'dlmm') {
    // dlmm — uses input/output named accounts like CLMM/CPMM
    return buildDlmmSwapInstruction({
      pool: r.pool,
      payer: walletPk,
      userInputTokenAccount: userInputAta,
      userOutputTokenAccount: userOutputAta,
      inputMint,
      amountIn,
      minimumAmountOut,
    });
  }
  if (r.kind === 'damm') {
    // damm — vault-backed AMM, same input/output ATA shape
    return buildDammSwapInstruction({
      pool: r.pool,
      payer: walletPk,
      userInputTokenAccount: userInputAta,
      userOutputTokenAccount: userOutputAta,
      inputMint,
      amountIn,
      minimumAmountOut,
    });
  }
  // pumpswap — base/quote ATA layout. quote is always SOL (WSOL ATA).
  // The WSOL ATA is userInputAta when buying and userOutputAta when selling.
  const isBuy = r.pool.quoteMint.equals(inputMint);
  const userQuoteAta = isBuy ? userInputAta : userOutputAta;
  const userBaseAta = isBuy ? userOutputAta : userInputAta;
  return buildPumpSwapInstruction({
    pool: r.pool,
    payer: walletPk,
    userQuoteTokenAccount: userQuoteAta,
    userBaseTokenAccount: userBaseAta,
    inputMint,
    amountIn,
    minimumAmountOut,
  });
}

function dexTag(r: Resolved): 'amm-v4' | 'clmm' | 'whirlpool' | 'cpmm' | 'dlmm' | 'damm' | 'pumpswap' {
  if (r.kind === 'amm') return 'amm-v4';
  if (r.kind === 'clmm') return 'clmm';
  if (r.kind === 'whirlpool') return 'whirlpool';
  if (r.kind === 'cpmm') return 'cpmm';
  if (r.kind === 'dlmm') return 'dlmm';
  if (r.kind === 'damm') return 'damm';
  return 'pumpswap';
}

function poolLabel(r: Resolved): string {
  return r.pool.label;
}

export function buildMixedHotPathTransaction(
  buyPoolAddr: string,
  sellPoolAddr: string,
  inputLamports: bigint,
  wallet: Keypair,
  blockhash: string,
  priorityFeeMicroLamports: number,
  minNetProfitLamports: bigint = 10_000n,
): MixedHotPathResult | null {
  const buy = resolvePool(buyPoolAddr);
  const sell = resolvePool(sellPoolAddr);
  if (!buy || !sell) {
    executionLog.debug({ buyPoolAddr, sellPoolAddr }, 'MIXED HOT: pool not cached');
    return null;
  }

  // Sanity: both legs must be the same token
  if (!buy.tokenMint.equals(sell.tokenMint)) {
    executionLog.warn(
      { buy: buy.tokenMint.toString(), sell: sell.tokenMint.toString() },
      'MIXED HOT: token mismatch between legs',
    );
    return null;
  }

  // ── PumpSwap trade-size clamp ───────────────────────────────────
  // Meme pools rug hard; never put more than MAX_PUMPSWAP_TRADE_LAMPORTS
  // (default 0.1 SOL) through a PumpSwap leg, even if the scan amount
  // is larger. The clamp applies if either the buy or sell leg is
  // PumpSwap — whichever leg the SOL is about to touch.
  const hasPumpLeg = buy.kind === 'pumpswap' || sell.kind === 'pumpswap';
  if (hasPumpLeg && inputLamports > MAX_PUMPSWAP_TRADE_LAMPORTS) {
    executionLog.debug(
      {
        inputLamports: inputLamports.toString(),
        maxPumpSwapLamports: MAX_PUMPSWAP_TRADE_LAMPORTS.toString(),
      },
      'MIXED HOT: pumpswap leg exceeds max trade size — skipping',
    );
    return null;
  }

  // ── Quote both legs ─────────────────────────────────────────────
  const tokenAmountOut = quoteBuy(buy, inputLamports);
  if (tokenAmountOut === 0n) return null;

  // Sell leg uses 0.5% safety margin (Rule 4): we tell the sell ix to spend
  // slightly less than the optimistic buy output. If the buy actually yields
  // exactly the safe amount or more, the sell succeeds. If the buy yields
  // less, the sell tries to spend more than we have → atomic revert.
  const sellAmountIn = (tokenAmountOut * 995n) / 1000n;
  const solAmountOut = quoteSell(sell, sellAmountIn);
  if (solAmountOut === 0n) return null;

  // ── Profitability ──────────────────────────────────────────────
  const grossProfit = solAmountOut - inputLamports;
  const baseFee = 5_000n + 10_000n;
  const rawTip = grossProfit > 0n ? (grossProfit * 40n) / 100n : 0n;
  const dynamicTip = rawTip < 1_000n ? 1_000n : rawTip > 200_000n ? 200_000n : rawTip;
  const totalFees = baseFee + dynamicTip;
  const netProfit = grossProfit - totalFees;
  if (netProfit < minNetProfitLamports) return null;

  // ── Slippage floors ────────────────────────────────────────────
  const minTokenOut = (tokenAmountOut * 995n) / 1000n;
  // Clamp to >= 0 — verification harnesses may pass negative minNetProfit.
  const rawMinSolOut = inputLamports + totalFees + minNetProfitLamports;
  const minSolOut = rawMinSolOut < 0n ? 0n : rawMinSolOut;

  // ── ATAs ───────────────────────────────────────────────────────
  const tokenMint = buy.tokenMint;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

  const ix: TransactionInstruction[] = [];

  // 1. Compute budget
  ix.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })); // CLMM uses more CU
  ix.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));

  // 2. (No ATA creates here — mixed AMM/CLMM TX is tight on bytes.
  //    The bot pre-creates wsolAta and per-token ATAs at startup so they
  //    persist across trades. If they're missing, the swap ix will fail and
  //    the entire atomic TX reverts safely. AMM-only path keeps the ATA
  //    creates because it has more byte headroom.)

  // 3. Wrap SOL → WSOL
  ix.push(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wsolAta,
      lamports: inputLamports,
    }),
  );
  ix.push(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
      data: Buffer.from([17]), // SyncNative
    }),
  );

  // 4. Buy leg: SOL → Token on buy pool
  ix.push(
    buildLegInstruction(
      buy,
      wallet.publicKey,
      wsolAta,
      tokenAta,
      NATIVE_MINT,
      inputLamports,
      minTokenOut,
    ),
  );

  // 5. Sell leg: Token → SOL on sell pool
  ix.push(
    buildLegInstruction(
      sell,
      wallet.publicKey,
      tokenAta,
      wsolAta,
      tokenMint,
      sellAmountIn,
      minSolOut,
    ),
  );

  // 6. Unwrap WSOL
  ix.push(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]), // CloseAccount
    }),
  );

  // 7. Jito tip LAST
  ix.push(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(getRandomTipAccount()),
      lamports: dynamicTip,
    }),
  );

  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: ix,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  const serialized = tx.serialize();

  if (serialized.length > 1232) {
    executionLog.warn(
      { sizeBytes: serialized.length, buy: buy.kind, sell: sell.kind },
      'MIXED HOT: TX exceeds 1232 bytes — needs ALTs',
    );
    return null;
  }

  return {
    transaction: tx,
    sizeBytes: serialized.length,
    expectedProfitLamports: netProfit,
    buyPool: poolLabel(buy),
    sellPool: poolLabel(sell),
    buyDex: dexTag(buy),
    sellDex: dexTag(sell),
    tipLamports: dynamicTip,
  };
}
