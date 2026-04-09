// DIRECT DEX SWAP BUILDER
// Builds raw swap instructions from cached pool state — no Jupiter, no SDK.
// For the HOT PATH: WebSocket detects spread → build swap → sign → send.
// Target: <5ms instruction build time.

import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  Connection,
  Keypair,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
} from '@solana/spl-token';
import { executionLog } from './logger.js';
import { JITO_TIP_ACCOUNTS, LAMPORTS_PER_SOL, SOL_MINT } from './config.js';
import { getRandomTipAccount } from './transactionBuilder.js';

// ═══════════════════════════════════════════════════════════════
// Raydium AMM V4 Program
// ═══════════════════════════════════════════════════════════════

const RAYDIUM_AMM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// OpenBook DEX (Serum V3) market layout offsets
// Layout: blob(5) | accountFlags(u64) | ownAddress(32) | vaultSignerNonce(u64)
//         | baseMint(32) | quoteMint(32) | baseVault(32) | baseDepositsTotal(u64)
//         | baseFeesAccrued(u64) | quoteVault(32) | quoteDepositsTotal(u64)
//         | quoteFeesAccrued(u64) | quoteDustThreshold(u64) | requestQueue(32)
//         | eventQueue(32) | bids(32) | asks(32) | ...
const OPENBOOK_MARKET_LAYOUT = {
  VAULT_SIGNER_NONCE_OFFSET: 45,  // u64 (after blob5 + flags8 + ownAddr32)
  BASE_VAULT_OFFSET: 117,         // 32-byte pubkey (coin vault)
  QUOTE_VAULT_OFFSET: 165,        // 32-byte pubkey (pc vault)
  EVENT_QUEUE_OFFSET: 253,        // 32-byte pubkey
  BIDS_OFFSET: 285,               // 32-byte pubkey
  ASKS_OFFSET: 317,               // 32-byte pubkey
} as const;

// Raydium AMM V4 account layout offsets (from state.rs AmmInfo struct)
const AMM_LAYOUT = {
  STATUS: 0,                    // u64
  TRADE_FEE_NUMERATOR: 144,    // u64
  TRADE_FEE_DENOMINATOR: 152,  // u64
  BASE_NEED_TAKE_PNL: 192,     // u64
  QUOTE_NEED_TAKE_PNL: 200,    // u64
  BASE_VAULT: 336,             // 32-byte pubkey
  QUOTE_VAULT: 368,            // 32-byte pubkey
  BASE_MINT: 400,              // 32-byte pubkey
  QUOTE_MINT: 432,             // 32-byte pubkey
  LP_MINT: 464,                // 32-byte pubkey
  OPEN_ORDERS: 496,            // 32-byte pubkey
  MARKET_ID: 528,              // 32-byte pubkey
  MARKET_PROGRAM_ID: 560,      // 32-byte pubkey
  TARGET_ORDERS: 624,          // 32-byte pubkey
  MIN_DATA_LENGTH: 752,
} as const;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** All the data needed to build a swap instruction for a Raydium AMM V4 pool */
export interface CachedPoolData {
  poolAddress: PublicKey;
  ammAuthority: PublicKey;
  openOrders: PublicKey;
  targetOrders: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  marketProgramId: PublicKey;
  marketId: PublicKey;
  // Market accounts (from OpenBook DEX market account)
  marketBids: PublicKey;
  marketAsks: PublicKey;
  marketEventQueue: PublicKey;
  marketBaseVault: PublicKey;
  marketQuoteVault: PublicKey;
  marketVaultSigner: PublicKey;
  // Fee info (on-chain u64 values — kept as bigint per standard)
  tradeFeeNumerator: bigint;
  tradeFeeDenominator: bigint;
  // Current reserves (updated by WebSocket via updateCachedReserves)
  baseReserve: bigint;
  quoteReserve: bigint;
  // Pool type label
  label: string;
}

/** Result of building a hot-path transaction */
export interface HotPathTxResult {
  transaction: VersionedTransaction;
  sizeBytes: number;
  expectedProfitLamports: bigint;
  buyPool: string;
  sellPool: string;
  tipLamports: bigint;
}

// ═══════════════════════════════════════════════════════════════
// Pool Data Caching
// ═══════════════════════════════════════════════════════════════

/** Global cache of pool data for hot path */
const poolDataCache = new Map<string, CachedPoolData>();

/**
 * Fetch and cache all data needed for direct swap instruction building.
 * Called once at startup for each monitored AMM V4 pool.
 * After this, only reserves are updated via WebSocket.
 */
export async function cachePoolData(
  connection: Connection,
  poolAddress: string,
  label: string,
): Promise<CachedPoolData | null> {
  try {
    const poolPubkey = new PublicKey(poolAddress);

    // 1. Fetch AMM account
    const ammAcct = await connection.getAccountInfo(poolPubkey);
    if (!ammAcct?.data || ammAcct.data.length < AMM_LAYOUT.MIN_DATA_LENGTH) {
      executionLog.warn({ pool: poolAddress, len: ammAcct?.data?.length }, 'AMM account too small');
      return null;
    }

    const ammData = ammAcct.data;

    // 2. Read all pubkeys from AMM account
    const readPubkey = (offset: number) => new PublicKey(ammData.subarray(offset, offset + 32));

    const baseVault = readPubkey(AMM_LAYOUT.BASE_VAULT);
    const quoteVault = readPubkey(AMM_LAYOUT.QUOTE_VAULT);
    const baseMint = readPubkey(AMM_LAYOUT.BASE_MINT);
    const quoteMint = readPubkey(AMM_LAYOUT.QUOTE_MINT);
    const openOrders = readPubkey(AMM_LAYOUT.OPEN_ORDERS);
    const marketId = readPubkey(AMM_LAYOUT.MARKET_ID);
    const marketProgramId = readPubkey(AMM_LAYOUT.MARKET_PROGRAM_ID);
    const targetOrders = readPubkey(AMM_LAYOUT.TARGET_ORDERS);

    const tradeFeeNumerator = ammData.readBigUInt64LE(AMM_LAYOUT.TRADE_FEE_NUMERATOR);
    const tradeFeeDenominator = ammData.readBigUInt64LE(AMM_LAYOUT.TRADE_FEE_DENOMINATOR);

    // 3. Derive AMM authority PDA
    // Seeds: [b"amm authority"]  with AMM program
    const [ammAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from([97, 109, 109, 32, 97, 117, 116, 104, 111, 114, 105, 116, 121])],
      RAYDIUM_AMM_V4_PROGRAM,
    );

    // 4. Fetch market account to get market-side accounts
    const marketAcct = await connection.getAccountInfo(marketId);
    if (!marketAcct?.data || marketAcct.data.length < 220) {
      executionLog.warn({ pool: poolAddress, market: marketId.toString() }, 'Market account too small');
      return null;
    }

    const mktData = marketAcct.data;
    const marketBids = new PublicKey(mktData.subarray(OPENBOOK_MARKET_LAYOUT.BIDS_OFFSET, OPENBOOK_MARKET_LAYOUT.BIDS_OFFSET + 32));
    const marketAsks = new PublicKey(mktData.subarray(OPENBOOK_MARKET_LAYOUT.ASKS_OFFSET, OPENBOOK_MARKET_LAYOUT.ASKS_OFFSET + 32));
    const marketEventQueue = new PublicKey(mktData.subarray(OPENBOOK_MARKET_LAYOUT.EVENT_QUEUE_OFFSET, OPENBOOK_MARKET_LAYOUT.EVENT_QUEUE_OFFSET + 32));
    const marketBaseVault = new PublicKey(mktData.subarray(OPENBOOK_MARKET_LAYOUT.BASE_VAULT_OFFSET, OPENBOOK_MARKET_LAYOUT.BASE_VAULT_OFFSET + 32));
    const marketQuoteVault = new PublicKey(mktData.subarray(OPENBOOK_MARKET_LAYOUT.QUOTE_VAULT_OFFSET, OPENBOOK_MARKET_LAYOUT.QUOTE_VAULT_OFFSET + 32));

    const vaultSignerNonce = mktData.readBigUInt64LE(OPENBOOK_MARKET_LAYOUT.VAULT_SIGNER_NONCE_OFFSET);

    // Derive market vault signer
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(vaultSignerNonce);
    const marketVaultSigner = await PublicKey.createProgramAddress(
      [marketId.toBuffer(), nonceBuffer],
      marketProgramId,
    );

    // 5. Fetch initial vault balances
    const [baseVaultAcct, quoteVaultAcct] = await Promise.all([
      connection.getAccountInfo(baseVault),
      connection.getAccountInfo(quoteVault),
    ]);

    // SPL Token Account layout: offset 64 = amount (u64 LE)
    const baseReserve = baseVaultAcct?.data ? baseVaultAcct.data.readBigUInt64LE(64) : 0n;
    const quoteReserve = quoteVaultAcct?.data ? quoteVaultAcct.data.readBigUInt64LE(64) : 0n;

    const basePnl = ammData.readBigUInt64LE(AMM_LAYOUT.BASE_NEED_TAKE_PNL);
    const quotePnl = ammData.readBigUInt64LE(AMM_LAYOUT.QUOTE_NEED_TAKE_PNL);

    const cached: CachedPoolData = {
      poolAddress: poolPubkey,
      ammAuthority,
      openOrders,
      targetOrders,
      baseVault,
      quoteVault,
      baseMint,
      quoteMint,
      marketProgramId,
      marketId,
      marketBids,
      marketAsks,
      marketEventQueue,
      marketBaseVault,
      marketQuoteVault,
      marketVaultSigner,
      tradeFeeNumerator,
      tradeFeeDenominator,
      baseReserve: baseReserve > basePnl ? baseReserve - basePnl : 0n,
      quoteReserve: quoteReserve > quotePnl ? quoteReserve - quotePnl : 0n,
      label,
    };

    poolDataCache.set(poolAddress, cached);

    executionLog.info(
      {
        pool: label,
        baseReserve: cached.baseReserve.toString(),
        quoteReserve: cached.quoteReserve.toString(),
        fee: `${tradeFeeNumerator.toString()}/${tradeFeeDenominator.toString()}`,
      },
      'Pool data cached for direct swap building',
    );

    return cached;
  } catch (err: any) {
    executionLog.error({ err: err?.message, pool: poolAddress }, 'Failed to cache pool data');
    return null;
  }
}

/** Get cached pool data */
export function getCachedPool(poolAddress: string): CachedPoolData | undefined {
  return poolDataCache.get(poolAddress);
}

/** Update reserves in cache (called by poolMonitor vault subscription) */
export function updateCachedReserves(
  poolAddress: string,
  baseReserve: bigint,
  quoteReserve: bigint,
): void {
  const cached = poolDataCache.get(poolAddress);
  if (cached) {
    cached.baseReserve = baseReserve;
    cached.quoteReserve = quoteReserve;
  }
}

// ═══════════════════════════════════════════════════════════════
// AMM Math (constant-product)
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate output amount for a constant-product AMM swap.
 * amountOut = reserveOut * amountIn * (denominator - numerator)
 *           / (reserveIn * denominator + amountIn * (denominator - numerator))
 */
export function calculateAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNumerator: bigint,
  feeDenominator: bigint,
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;

  const amountInWithFee = amountIn * (feeDenominator - feeNumerator);
  const numerator = reserveOut * amountInWithFee;
  const denominator = reserveIn * feeDenominator + amountInWithFee;

  return numerator / denominator;
}

// ═══════════════════════════════════════════════════════════════
// Build Raydium AMM V4 Swap Instruction
// ═══════════════════════════════════════════════════════════════

/**
 * Build a raw Raydium AMM V4 swap instruction.
 * Instruction discriminator: 9 (swap)
 * Data: [9, amountIn(u64 LE), minimumAmountOut(u64 LE)]
 */
export function buildRaydiumSwapInstruction(
  pool: CachedPoolData,
  userSourceTokenAccount: PublicKey,
  userDestTokenAccount: PublicKey,
  userOwner: PublicKey,
  amountIn: bigint,
  minimumAmountOut: bigint,
): TransactionInstruction {
  // Instruction data: discriminator(1) + amountIn(8) + minAmountOut(8) = 17 bytes
  const data = Buffer.alloc(17);
  data.writeUInt8(9, 0); // swap instruction discriminator
  data.writeBigUInt64LE(amountIn, 1);
  data.writeBigUInt64LE(minimumAmountOut, 9);

  return new TransactionInstruction({
    programId: RAYDIUM_AMM_V4_PROGRAM,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pool.poolAddress, isSigner: false, isWritable: true },
      { pubkey: pool.ammAuthority, isSigner: false, isWritable: false },
      { pubkey: pool.openOrders, isSigner: false, isWritable: true },
      { pubkey: pool.targetOrders, isSigner: false, isWritable: true },
      { pubkey: pool.baseVault, isSigner: false, isWritable: true },
      { pubkey: pool.quoteVault, isSigner: false, isWritable: true },
      { pubkey: pool.marketProgramId, isSigner: false, isWritable: false },
      { pubkey: pool.marketId, isSigner: false, isWritable: true },
      { pubkey: pool.marketBids, isSigner: false, isWritable: true },
      { pubkey: pool.marketAsks, isSigner: false, isWritable: true },
      { pubkey: pool.marketEventQueue, isSigner: false, isWritable: true },
      { pubkey: pool.marketBaseVault, isSigner: false, isWritable: true },
      { pubkey: pool.marketQuoteVault, isSigner: false, isWritable: true },
      { pubkey: pool.marketVaultSigner, isSigner: false, isWritable: false },
      { pubkey: userSourceTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userDestTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userOwner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ═══════════════════════════════════════════════════════════════
// HOT PATH: Build Atomic Arb Transaction
// ═══════════════════════════════════════════════════════════════

/**
 * Build a complete atomic arbitrage transaction from two AMM V4 pools.
 * No Jupiter. No simulation. Just raw swap instructions.
 *
 * Flow: SOL → Token (buy pool) → Token → SOL (sell pool)
 *
 * @param buyPoolAddr   Pool where token is cheaper (buy here)
 * @param sellPoolAddr  Pool where token is more expensive (sell here)
 * @param inputLamports Amount of SOL to trade
 * @param wallet        Signing keypair
 * @param blockhash     Pre-cached recent blockhash
 * @param priorityFeeMicroLamports  Cached priority fee
 * @returns             Signed VersionedTransaction ready to send, or null if unprofitable
 */
export function buildHotPathTransaction(
  buyPoolAddr: string,
  sellPoolAddr: string,
  inputLamports: bigint,
  wallet: Keypair,
  blockhash: string,
  priorityFeeMicroLamports: number,
  minNetProfitLamports: bigint = 10_000n,
): HotPathTxResult | null {
  const buyPool = poolDataCache.get(buyPoolAddr);
  const sellPool = poolDataCache.get(sellPoolAddr);

  if (!buyPool || !sellPool) {
    executionLog.debug({ buyPoolAddr, sellPoolAddr }, 'HOT: Pool data not cached');
    return null;
  }

  // ── Step 1: Calculate amounts ─────────────────────────────────
  // Buy: SOL → Token at buyPool
  // For AMM V4, if baseMint is SOL: swap quote(SOL) → base(Token)
  //                 if quoteMint is SOL: swap base(SOL) → quote(Token)... actually
  // In Raydium AMM V4, the pool has baseMint (coin) and quoteMint (pc).
  // SOL is usually the quoteMint. So buying token = swapping quote(SOL) for base(Token).

  // Determine direction for buy pool
  const buyIsSolQuote = buyPool.quoteMint.equals(NATIVE_MINT) ||
    buyPool.quoteMint.toString() === SOL_MINT;

  let tokenAmountOut: bigint;
  if (buyIsSolQuote) {
    // SOL is quote → swap SOL(quote) for Token(base)
    tokenAmountOut = calculateAmountOut(
      inputLamports,
      buyPool.quoteReserve,
      buyPool.baseReserve,
      buyPool.tradeFeeNumerator,
      buyPool.tradeFeeDenominator,
    );
  } else {
    // SOL is base → swap SOL(base) for Token(quote)
    tokenAmountOut = calculateAmountOut(
      inputLamports,
      buyPool.baseReserve,
      buyPool.quoteReserve,
      buyPool.tradeFeeNumerator,
      buyPool.tradeFeeDenominator,
    );
  }

  if (tokenAmountOut === 0n) return null;

  // Sell: Token → SOL at sellPool
  const sellIsSolQuote = sellPool.quoteMint.equals(NATIVE_MINT) ||
    sellPool.quoteMint.toString() === SOL_MINT;

  let solAmountOut: bigint;
  if (sellIsSolQuote) {
    // SOL is quote → swap Token(base) for SOL(quote)
    solAmountOut = calculateAmountOut(
      tokenAmountOut,
      sellPool.baseReserve,
      sellPool.quoteReserve,
      sellPool.tradeFeeNumerator,
      sellPool.tradeFeeDenominator,
    );
  } else {
    // SOL is base → swap Token(quote) for SOL(base)
    solAmountOut = calculateAmountOut(
      tokenAmountOut,
      sellPool.quoteReserve,
      sellPool.baseReserve,
      sellPool.tradeFeeNumerator,
      sellPool.tradeFeeDenominator,
    );
  }

  // ── Step 2: Profitability check ───────────────────────────────
  const grossProfitLamports = solAmountOut - inputLamports;
  const baseFee = 5_000n + 10_000n; // base gas + priority fee estimate
  // Dynamic Jito tip: min(max(profit * 40 / 100, 1000), 200000) — pure BigInt
  const rawTip = grossProfitLamports > 0n ? grossProfitLamports * 40n / 100n : 0n;
  const dynamicTip = rawTip < 1_000n ? 1_000n : rawTip > 200_000n ? 200_000n : rawTip;
  const totalFees = baseFee + dynamicTip;
  const netProfit = grossProfitLamports - totalFees;

  if (netProfit < minNetProfitLamports) {
    return null;
  }

  // ── Step 3: Set minimumAmountOut with safety margin ──────────
  // Buy leg: accept up to 0.5% less tokens than calculated.
  // This covers pool movement between our read and on-chain execution.
  const minTokenOut = tokenAmountOut * 995n / 1000n;

  // Sell leg minimumAmountOut: hard floor that guarantees net profitability.
  // If pool moved and output falls below this → instruction fails → TX reverts.
  // This is the ONLY safety net (no simulation).
  const minSolOut = inputLamports + totalFees + minNetProfitLamports;

  // ── Step 4: Sell leg amountIn ───────────────────────────────
  // CRITICAL: Do NOT use exact tokenAmountOut (optimistic). If buy yields
  // even 1 fewer token, sell would try to spend more than we have → TX fails.
  // Do NOT use minTokenOut either (too conservative — leaves profit on table).
  // Use 0.5% below expected: close to actual output while tolerating rounding.
  const sellAmountIn = tokenAmountOut * 995n / 1000n;

  // ── Step 5: Determine token mint and ATAs ────────────────────
  const tokenMint = buyIsSolQuote ? buyPool.baseMint : buyPool.quoteMint;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

  // ── Step 5: Build instructions ───────────────────────────────
  const instructions: TransactionInstruction[] = [];

  // Compute budget
  instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));

  // Create ATAs if needed (idempotent — no-op if they exist)
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, wsolAta, wallet.publicKey, NATIVE_MINT,
    ),
  );
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey, tokenAta, wallet.publicKey, tokenMint,
    ),
  );

  // Wrap SOL → WSOL (transfer SOL to WSOL ATA, then sync)
  instructions.push(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wsolAta,
      lamports: inputLamports,
    }),
  );
  // SyncNative to update WSOL balance
  instructions.push(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
      data: Buffer.from([17]), // SyncNative instruction
    }),
  );

  // Buy swap: SOL → Token
  // Both branches are identical — AMM resolves direction from which user
  // token account matches which vault mint, not from the conditional.
  instructions.push(buildRaydiumSwapInstruction(
    buyPool, wsolAta, tokenAta, wallet.publicKey, inputLamports, minTokenOut,
  ));

  // Sell swap: Token → SOL
  // amountIn = sellAmountIn (0.5% below expected buy output)
  // minimumAmountOut = minSolOut (hard floor: input + fees + minProfit)
  // If actual buy output < sellAmountIn → sell tries to spend more tokens than we have → TX reverts
  // If sell output < minSolOut → instruction fails → TX reverts
  // Both reversions are safe — atomic TX, no stuck tokens.
  instructions.push(buildRaydiumSwapInstruction(
    sellPool, tokenAta, wsolAta, wallet.publicKey, sellAmountIn, minSolOut,
  ));

  // Close WSOL account → unwrap back to native SOL
  instructions.push(
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: wsolAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]), // CloseAccount instruction
    }),
  );

  // Jito tip as last instruction
  if (dynamicTip > 0n) {
    instructions.push(SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(getRandomTipAccount()),
      lamports: dynamicTip,
    }));
  }

  // ── Step 6: Compile, sign, return ────────────────────────────
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);

  const serialized = tx.serialize();

  return {
    transaction: tx,
    sizeBytes: serialized.length,
    expectedProfitLamports: netProfit,
    buyPool: buyPool.label,
    sellPool: sellPool.label,
    tipLamports: dynamicTip,
  };
}
