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
 * Serialize a signed VersionedTransaction to a base64 string suitable for
 * Jito bundle submission (the /api/v1/bundles endpoint expects base64 strings).
 */
export function serializeTransaction(transaction: VersionedTransaction): string {
  const serialized = transaction.serialize();
  return Buffer.from(serialized).toString('base64');
}
