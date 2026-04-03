// TRANSACTION BUILDER
// Constructs optimized versioned transactions with priority fees and Jito tips.
// Handles deserialization of Jupiter swap payloads and signing.

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
  Connection,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { executionLog } from './logger.js';
import { JITO_TIP_ACCOUNTS } from './config.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface BuildSwapResult {
  transaction: VersionedTransaction;
  /** Whether the transaction was successfully signed */
  signed: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// SWAP TRANSACTION BUILDING
// ═══════════════════════════════════════════════════════════════════

/**
 * Deserialize a base64-encoded swap transaction (from Jupiter /swap API),
 * sign it with the provided wallet keypair, and return the VersionedTransaction.
 *
 * @param swapBase64 The base64-encoded serialized VersionedTransaction from Jupiter
 * @param wallet     The signing Keypair (must be the fee payer / authority)
 * @returns          The signed VersionedTransaction ready to send
 */
export function buildSwapTransaction(
  swapBase64: string,
  wallet: Keypair,
): VersionedTransaction {
  try {
    const swapBuffer = Buffer.from(swapBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(swapBuffer);

    // Sign with the wallet keypair
    transaction.sign([wallet]);

    executionLog.debug(
      {
        signaturesCount: transaction.signatures.length,
        messageVersion: transaction.version,
      },
      'Swap transaction built and signed',
    );

    return transaction;
  } catch (err: any) {
    executionLog.error(
      { error: err.message },
      'Failed to build swap transaction from base64 payload',
    );
    throw new Error(`buildSwapTransaction failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// PRIORITY FEE
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a new VersionedTransaction that prepends ComputeBudgetProgram instructions
 * (SetComputeUnitPrice and optionally SetComputeUnitLimit) to the given transaction.
 *
 * Because VersionedTransaction messages are immutable after construction, we must
 * reconstruct the transaction from its message, prepend the priority-fee instructions,
 * and re-sign.
 *
 * @param transaction   The original VersionedTransaction
 * @param feeMicroLamports  Priority fee in micro-lamports per compute unit
 * @param computeUnitLimit  Optional explicit compute-unit limit (default: 400_000)
 * @param wallet        The wallet Keypair to re-sign with
 * @param connection    Connection to resolve lookup tables (needed for V0 messages)
 * @returns             A new VersionedTransaction with priority fee instructions prepended
 */
export async function addPriorityFee(
  transaction: VersionedTransaction,
  feeMicroLamports: number,
  wallet: Keypair,
  connection: Connection,
  computeUnitLimit: number = 400_000,
): Promise<VersionedTransaction> {
  try {
    const message = transaction.message;

    // Resolve address lookup tables if this is a V0 message
    const lookupTableAccounts: AddressLookupTableAccount[] = [];
    if ('addressTableLookups' in message && message.addressTableLookups.length > 0) {
      for (const lookup of message.addressTableLookups) {
        const accountInfo = await connection.getAddressLookupTable(lookup.accountKey);
        if (accountInfo.value) {
          lookupTableAccounts.push(accountInfo.value);
        }
      }
    }

    // Decompile the existing message to get instructions
    const decompiled = TransactionMessage.decompile(message, {
      addressLookupTableAccounts: lookupTableAccounts,
    });

    // Filter out any existing ComputeBudget instructions to avoid duplicates
    const filteredInstructions = decompiled.instructions.filter(
      (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
    );

    // Build the priority fee instructions
    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: feeMicroLamports,
    });
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit,
    });

    // Prepend priority fee instructions
    const newInstructions: TransactionInstruction[] = [
      computeLimitIx,
      priorityFeeIx,
      ...filteredInstructions,
    ];

    // Rebuild the versioned message
    const newMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: decompiled.recentBlockhash,
      instructions: newInstructions,
    }).compileToV0Message(lookupTableAccounts);

    const newTransaction = new VersionedTransaction(newMessage);
    newTransaction.sign([wallet]);

    executionLog.debug(
      {
        feeMicroLamports,
        computeUnitLimit,
        instructionCount: newInstructions.length,
      },
      'Priority fee added to transaction',
    );

    return newTransaction;
  } catch (err: any) {
    executionLog.error(
      { error: err.message },
      'Failed to add priority fee to transaction',
    );
    throw new Error(`addPriorityFee failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// JITO TIP
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a new VersionedTransaction that appends a Jito tip transfer to one of the
 * Jito tip accounts. The tip is a simple SOL transfer via SystemProgram.
 *
 * @param transaction  The original VersionedTransaction
 * @param tipLamports  Tip amount in lamports
 * @param tipAccount   The Jito tip account public key string (or use getRandomTipAccount())
 * @param wallet       The wallet Keypair for signing and as the tip source
 * @param connection   Connection to resolve lookup tables
 * @returns            A new VersionedTransaction with the tip instruction appended
 */
export async function addJitoTip(
  transaction: VersionedTransaction,
  tipLamports: number,
  tipAccount: string,
  wallet: Keypair,
  connection: Connection,
): Promise<VersionedTransaction> {
  try {
    const message = transaction.message;

    // Resolve address lookup tables
    const lookupTableAccounts: AddressLookupTableAccount[] = [];
    if ('addressTableLookups' in message && message.addressTableLookups.length > 0) {
      for (const lookup of message.addressTableLookups) {
        const accountInfo = await connection.getAddressLookupTable(lookup.accountKey);
        if (accountInfo.value) {
          lookupTableAccounts.push(accountInfo.value);
        }
      }
    }

    // Decompile existing message
    const decompiled = TransactionMessage.decompile(message, {
      addressLookupTableAccounts: lookupTableAccounts,
    });

    // Create the tip transfer instruction
    const tipIx = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    });

    // Append tip instruction after all existing instructions
    const newInstructions: TransactionInstruction[] = [
      ...decompiled.instructions,
      tipIx,
    ];

    // Rebuild the versioned message
    const newMessage = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: decompiled.recentBlockhash,
      instructions: newInstructions,
    }).compileToV0Message(lookupTableAccounts);

    const newTransaction = new VersionedTransaction(newMessage);
    newTransaction.sign([wallet]);

    executionLog.debug(
      {
        tipLamports,
        tipAccount,
        instructionCount: newInstructions.length,
      },
      'Jito tip added to transaction',
    );

    return newTransaction;
  } catch (err: any) {
    executionLog.error(
      { error: err.message, tipAccount, tipLamports },
      'Failed to add Jito tip to transaction',
    );
    throw new Error(`addJitoTip failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// JITO TIP ACCOUNT SELECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Pick a random Jito tip account from the configured list.
 * Randomization distributes tips across validators and avoids hot-spot contention.
 */
export function getRandomTipAccount(): string {
  const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return JITO_TIP_ACCOUNTS[index];
}

// ═══════════════════════════════════════════════════════════════════
// COMBINED ATOMIC SWAP (two Jupiter swaps in ONE transaction)
// ═══════════════════════════════════════════════════════════════════

/** Max Solana transaction size in bytes */
const MAX_TX_SIZE = 1232;

export interface CombinedSwapResult {
  transaction: VersionedTransaction;
  /** Serialized size in bytes — must be ≤ 1232 */
  sizeBytes: number;
  /** Resolved lookup tables — needed for patchComputeUnitLimit without re-fetch */
  lookupTables: AddressLookupTableAccount[];
}

/**
 * Combine two Jupiter swap transactions (forward: SOL→Token, reverse: Token→SOL)
 * into a SINGLE VersionedTransaction. This is fully atomic by Solana's runtime:
 * if any instruction fails, the entire transaction reverts. No partial execution.
 *
 * Flow:
 * 1. Deserialize both swap TXs from Jupiter /swap base64 payloads
 * 2. Decompile both to extract raw instructions
 * 3. Merge: [ComputeBudget] + [Forward swap ixs] + [Reverse swap ixs]
 * 4. Compile to V0 message with all lookup tables from both TXs
 * 5. Sign once, return combined TX
 *
 * @returns CombinedSwapResult with the signed TX and its byte size, or throws if > 1232 bytes
 */
export async function combineSwapsIntoSingleTx(
  forwardSwapBase64: string,
  reverseSwapBase64: string,
  wallet: Keypair,
  connection: Connection,
  priorityFeeMicroLamports: number = 10_000,
  computeUnitLimit: number = 600_000,
): Promise<CombinedSwapResult> {
  // ── 1. Deserialize both swap TXs ─────────────────────────────
  const forwardTx = VersionedTransaction.deserialize(
    Buffer.from(forwardSwapBase64, 'base64'),
  );
  const reverseTx = VersionedTransaction.deserialize(
    Buffer.from(reverseSwapBase64, 'base64'),
  );

  // ── 2. Resolve ALL address lookup tables from both TXs ───────
  const lookupTableMap = new Map<string, AddressLookupTableAccount>();

  for (const tx of [forwardTx, reverseTx]) {
    const msg = tx.message;
    if ('addressTableLookups' in msg && msg.addressTableLookups.length > 0) {
      for (const lookup of msg.addressTableLookups) {
        const key = lookup.accountKey.toString();
        if (!lookupTableMap.has(key)) {
          const info = await connection.getAddressLookupTable(lookup.accountKey);
          if (info.value) {
            lookupTableMap.set(key, info.value);
          }
        }
      }
    }
  }

  const allLookupTables = Array.from(lookupTableMap.values());

  // ── 3. Decompile both messages to get raw instructions ───────
  const forwardMsg = TransactionMessage.decompile(forwardTx.message, {
    addressLookupTableAccounts: allLookupTables,
  });
  const reverseMsg = TransactionMessage.decompile(reverseTx.message, {
    addressLookupTableAccounts: allLookupTables,
  });

  // ── 4. Extract swap instructions (strip ComputeBudget from both) ──
  const forwardSwapIxs = forwardMsg.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );
  const reverseSwapIxs = reverseMsg.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );

  // ── 5. Build combined instruction array ──────────────────────
  // Order: ComputeBudget → Forward swap → Reverse swap
  const combinedInstructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...forwardSwapIxs,
    ...reverseSwapIxs,
  ];

  // ── 6. Get fresh blockhash and compile ───────────────────────
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const compiledMessage = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: combinedInstructions,
  }).compileToV0Message(allLookupTables);

  const combinedTx = new VersionedTransaction(compiledMessage);

  // ── 7. Check size BEFORE signing ─────────────────────────────
  // Signing doesn't change size (signature slot is pre-allocated)
  const serialized = combinedTx.serialize();
  const sizeBytes = serialized.length;

  if (sizeBytes > MAX_TX_SIZE) {
    throw new TxTooLargeError(
      `Combined TX is ${sizeBytes} bytes (limit: ${MAX_TX_SIZE}). ` +
      `Forward: ${forwardSwapIxs.length} ixs, Reverse: ${reverseSwapIxs.length} ixs`,
      sizeBytes,
    );
  }

  // ── 8. Sign and return ───────────────────────────────────────
  combinedTx.sign([wallet]);

  executionLog.info(
    {
      sizeBytes,
      forwardIxs: forwardSwapIxs.length,
      reverseIxs: reverseSwapIxs.length,
      lookupTables: allLookupTables.length,
      computeUnitLimit,
    },
    'Combined atomic TX built — both swaps in single transaction',
  );

  return { transaction: combinedTx, sizeBytes, lookupTables: allLookupTables };
}

/**
 * Custom error for when combined TX exceeds 1232 byte limit.
 * Caller can catch this specifically and fall back to sequential execution.
 */
export class TxTooLargeError extends Error {
  public readonly sizeBytes: number;
  constructor(message: string, sizeBytes: number) {
    super(message);
    this.name = 'TxTooLargeError';
    this.sizeBytes = sizeBytes;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TOKEN LEDGER COMBINED SWAP
// Uses Jupiter's sharedAccountsRouteWithTokenLedger for the reverse leg
// so it dynamically reads the actual token balance instead of a hardcoded inAmount.
// ═══════════════════════════════════════════════════════════════════

/** A single instruction from Jupiter's /swap-instructions response */
export interface JupiterInstructionPayload {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string; // base64-encoded
}

/** Response from Jupiter's /swap-instructions endpoint */
export interface SwapInstructionsResponse {
  tokenLedgerInstruction: JupiterInstructionPayload | null;
  computeBudgetInstructions: JupiterInstructionPayload[];
  setupInstructions: JupiterInstructionPayload[];
  swapInstruction: JupiterInstructionPayload;
  cleanupInstruction: JupiterInstructionPayload | null;
  addressLookupTableAddresses: string[];
}

/** Deserialize a Jupiter instruction payload into a Solana TransactionInstruction */
function deserializeJupiterInstruction(ix: JupiterInstructionPayload): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

/**
 * Combine a forward Jupiter swap TX (base64) with a reverse leg that uses
 * Jupiter's Token Ledger mechanism. The Token Ledger records the intermediate
 * token balance BEFORE the reverse swap, so the reverse instruction uses
 * the ACTUAL token amount (whatever the forward leg produced) instead of
 * a hardcoded inAmount from the quote.
 *
 * TX structure:
 * [ComputeBudget] → [Forward setup + swap ixs] → [SetTokenLedger] →
 * [Reverse setup ixs] → [Reverse swap (token ledger)] → [Reverse cleanup]
 *
 * @param forwardSwapBase64   Base64 TX from Jupiter /swap (SOL→Token)
 * @param reverseInstructions Parsed instructions from Jupiter /swap-instructions
 *                            with useTokenLedger=true (Token→SOL)
 * @param wallet              Signing keypair
 * @param connection          Solana connection
 * @param priorityFeeMicroLamports  Priority fee
 * @param computeUnitLimit    Compute budget
 */
export async function combineSwapsWithTokenLedger(
  forwardSwapBase64: string,
  reverseInstructions: SwapInstructionsResponse,
  wallet: Keypair,
  connection: Connection,
  priorityFeeMicroLamports: number = 10_000,
  computeUnitLimit: number = 600_000,
  jitoTipLamports: number = 0,
): Promise<CombinedSwapResult> {
  // ── 1. Deserialize forward swap TX ─────────────────────────────
  const forwardTx = VersionedTransaction.deserialize(
    Buffer.from(forwardSwapBase64, 'base64'),
  );

  // ── 2. Resolve address lookup tables from BOTH legs ────────────
  const lookupTableMap = new Map<string, AddressLookupTableAccount>();

  // From forward TX
  const fwdMsg = forwardTx.message;
  if ('addressTableLookups' in fwdMsg && fwdMsg.addressTableLookups.length > 0) {
    for (const lookup of fwdMsg.addressTableLookups) {
      const key = lookup.accountKey.toString();
      if (!lookupTableMap.has(key)) {
        const info = await connection.getAddressLookupTable(lookup.accountKey);
        if (info.value) lookupTableMap.set(key, info.value);
      }
    }
  }

  // From reverse instructions' addressLookupTableAddresses
  for (const addr of reverseInstructions.addressLookupTableAddresses) {
    if (!lookupTableMap.has(addr)) {
      const pubkey = new PublicKey(addr);
      const info = await connection.getAddressLookupTable(pubkey);
      if (info.value) lookupTableMap.set(addr, info.value);
    }
  }

  const allLookupTables = Array.from(lookupTableMap.values());

  // ── 3. Decompile forward TX to get its instructions ────────────
  const forwardMsg = TransactionMessage.decompile(forwardTx.message, {
    addressLookupTableAccounts: allLookupTables,
  });
  const forwardSwapIxs = forwardMsg.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );

  // ── 4. Deserialize reverse leg instructions ────────────────────
  // NOTE: We skip reverseInstructions.setupInstructions because the
  // forward TX already creates the necessary token accounts (ATAs).
  // Including reverse setup would try to re-create the same accounts,
  // causing errors 6 (AlreadyInUse) or 13 (InvalidState).
  const reverseSwapIx = deserializeJupiterInstruction(reverseInstructions.swapInstruction);
  const reverseCleanupIx = reverseInstructions.cleanupInstruction
    ? deserializeJupiterInstruction(reverseInstructions.cleanupInstruction)
    : null;
  const tokenLedgerIx = reverseInstructions.tokenLedgerInstruction
    ? deserializeJupiterInstruction(reverseInstructions.tokenLedgerInstruction)
    : null;

  // ── 5. Build combined instruction array ────────────────────────
  // Order: ComputeBudget → Forward ixs → SetTokenLedger → Reverse swap → Cleanup
  // No reverse setup — forward leg already created all needed accounts.
  const combinedInstructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...forwardSwapIxs,
  ];

  // Token ledger instruction MUST come after forward swap (records balance)
  // and BEFORE reverse swap (reverse reads the recorded balance)
  if (tokenLedgerIx) {
    combinedInstructions.push(tokenLedgerIx);
  }

  combinedInstructions.push(reverseSwapIx);
  if (reverseCleanupIx) {
    combinedInstructions.push(reverseCleanupIx);
  }

  // ── 5b. Add Jito tip as LAST instruction ──────────────────────
  // Required for Helius Sender (dual SWQoS + Jito routing).
  // Tip goes to a random Jito tip account to distribute load.
  if (jitoTipLamports > 0) {
    const tipIx = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: new PublicKey(getRandomTipAccount()),
      lamports: jitoTipLamports,
    });
    combinedInstructions.push(tipIx);
  }

  // ── 6. Get fresh blockhash and compile ─────────────────────────
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const compiledMessage = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: combinedInstructions,
  }).compileToV0Message(allLookupTables);

  const combinedTx = new VersionedTransaction(compiledMessage);

  // ── 7. Check size BEFORE signing ───────────────────────────────
  const serialized = combinedTx.serialize();
  const sizeBytes = serialized.length;

  if (sizeBytes > MAX_TX_SIZE) {
    throw new TxTooLargeError(
      `Token ledger combined TX is ${sizeBytes} bytes (limit: ${MAX_TX_SIZE}). ` +
      `Forward: ${forwardSwapIxs.length} ixs, Reverse: 1 swap`,
      sizeBytes,
    );
  }

  // ── 8. Sign and return ─────────────────────────────────────────
  combinedTx.sign([wallet]);

  executionLog.info(
    {
      sizeBytes,
      forwardIxs: forwardSwapIxs.length,
      hasTokenLedger: !!tokenLedgerIx,
      hasCleanup: !!reverseCleanupIx,
      lookupTables: allLookupTables.length,
      computeUnitLimit,
      jitoTipLamports,
    },
    `Token ledger combined TX built — reverse leg uses dynamic balance${jitoTipLamports > 0 ? ` + ${jitoTipLamports} lamport Jito tip` : ''}`,
  );

  return { transaction: combinedTx, sizeBytes, lookupTables: allLookupTables };
}

// ═══════════════════════════════════════════════════════════════════
// PATCH CU LIMIT — modify existing TX without full rebuild
// Finds the SetComputeUnitLimit instruction and patches the u32 value,
// then re-signs. Saves ~70ms vs full rebuild (no ALT re-fetch).
// ═══════════════════════════════════════════════════════════════════

/**
 * Patch the ComputeUnitLimit in an existing VersionedTransaction.
 * Avoids full TX rebuild — decompile, replace CU ix, recompile, re-sign.
 *
 * @param transaction       The existing signed VersionedTransaction
 * @param newComputeUnits   The new CU limit to set
 * @param wallet            Keypair for re-signing
 * @param lookupTables      Address lookup tables (must be the same ones used to build)
 * @returns                 New VersionedTransaction with patched CU limit
 */
export function patchComputeUnitLimit(
  transaction: VersionedTransaction,
  newComputeUnits: number,
  wallet: Keypair,
  lookupTables: AddressLookupTableAccount[],
): VersionedTransaction {
  const message = transaction.message;

  // Decompile to get instructions
  const decompiled = TransactionMessage.decompile(message, {
    addressLookupTableAccounts: lookupTables,
  });

  // Replace the SetComputeUnitLimit instruction (discriminator byte 0x02)
  const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toString();
  const newCuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: newComputeUnits });

  const patchedInstructions = decompiled.instructions.map((ix) => {
    if (ix.programId.toString() === COMPUTE_BUDGET_ID && ix.data[0] === 0x02) {
      return newCuIx;
    }
    return ix;
  });

  // Recompile with same blockhash and lookup tables
  const newMessage = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: decompiled.recentBlockhash,
    instructions: patchedInstructions,
  }).compileToV0Message(lookupTables);

  const newTx = new VersionedTransaction(newMessage);
  newTx.sign([wallet]);
  return newTx;
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY: BUILD TIP-ONLY TRANSACTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a standalone tip transaction (no swap). Useful for bundle padding
 * or as a separate tip transaction in multi-TX bundles.
 *
 * @param wallet        The wallet Keypair
 * @param tipLamports   Tip amount in lamports
 * @param connection    Connection for fetching latest blockhash
 * @param tipAccount    Optional specific tip account (defaults to random)
 * @returns             A signed VersionedTransaction containing only the tip transfer
 */
export async function buildTipTransaction(
  wallet: Keypair,
  tipLamports: number,
  connection: Connection,
  tipAccount?: string,
): Promise<VersionedTransaction> {
  const resolvedTipAccount = tipAccount || getRandomTipAccount();

  const tipIx = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(resolvedTipAccount),
    lamports: tipLamports,
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipIx],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet]);

  executionLog.debug(
    { tipLamports, tipAccount: resolvedTipAccount },
    'Standalone tip transaction built',
  );

  return transaction;
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY: SERIALIZE FOR BUNDLE
// ═══════════════════════════════════════════════════════════════════

/**
 * Serialize a signed VersionedTransaction to a base58 string for
 * Jito bundle submission (the /api/v1/bundles sendBundle expects base58).
 */
export function serializeTransaction(transaction: VersionedTransaction): string {
  const serialized = transaction.serialize();
  return bs58.encode(serialized);
}
