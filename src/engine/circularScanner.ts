// CIRCULAR SCANNER — Phase 5: Background Jupiter scanning process
// Runs IN PARALLEL with the WebSocket hot path (Phase 4).
// Uses 4 Jupiter API keys rotating round-robin to maximize throughput.
// Scans circular routes: SOL → Token → SOL across different DEXes.
// This is the WARM PATH (~450ms per cycle via Jupiter quote API).
//
// EXECUTION FLOW:
//   1. Quote SOL → Token (Jupiter /quote)
//   2. Quote Token → SOL (Jupiter /quote)
//   3. If profitable: call /swap on SAME key, deserialize TX, replace blockhash
//      with cached, add Jito tip, sign, fire-and-forget via Helius Sender
//
// RATE LIMITING:
//   - 4 API keys, round-robin
//   - Per-key sliding window: 55 req/min max
//   - If key at limit → skip (don't block), move to next key
//   - 250ms between individual scans → 4 checks/second max
//
// CIRCULAR PAIRS SCANNED (8 tokens × 2 amounts = 16 scans/cycle):
//   SOL → mSOL → SOL       (LST, persistent spreads)
//   SOL → jitoSOL → SOL    (LST, persistent spreads)
//   SOL → bSOL → SOL       (LST, persistent spreads)
//   SOL → BONK → SOL       (mid-cap, wider spreads)
//   SOL → WIF → SOL        (mid-cap, wider spreads)
//   SOL → RAY → SOL        (mid-cap, wider spreads)
//   SOL → JTO → SOL        (mid-cap, wider spreads)
//   SOL → JUP → SOL        (mid-cap, wider spreads)
//
// CODING STANDARDS:
//   - All on-chain amounts are BigInt (standard 1)
//   - Every async function has try/catch with context (standard 2)
//   - No Jupiter calls in hot path — this is the WARM path (standard 3)
//   - Errors logged with context, never crash the scanner loop (standard 6)

import {
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  SystemProgram,
  PublicKey,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import { executionLog } from './logger.js';
import {
  BotConfig,
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  TokenInfo,
  TWO_LEG_FEE_LAMPORTS,
  JUPITER_MAX_ACCOUNTS,
  JITO_TIP_ACCOUNTS,
} from './config.js';
import { getCachedBlockhash, getCachedPriorityFee, enqueueSignature } from './keepers.js';
import { ConnectionManager } from './connectionManager.js';
import { getRandomTipAccount } from './transactionBuilder.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface CircularOpportunity {
  tokenSymbol: string;
  tokenMint: string;
  inputLamports: bigint;
  outputLamports: bigint;
  grossProfitLamports: bigint;
  netProfitLamports: bigint;
  spreadBps: number;
  buyRoute: string;
  sellRoute: string;
  timestamp: number;
}

export type CircularCallback = (opp: CircularOpportunity) => void;

// ═══════════════════════════════════════════════════════════════
// Per-Key Rate Limiter
// Sliding window: 55 requests per 60 seconds per key.
// If a key is at its limit, skip it (return null) — never block.
// ═══════════════════════════════════════════════════════════════

interface KeyState {
  key: string;
  /** Timestamps of recent requests (sliding window) */
  timestamps: number[];
}

const RATE_LIMIT_PER_KEY = 55;     // max requests per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds

class KeyPool {
  private keys: KeyState[] = [];
  private index = 0;

  constructor(apiKeys: string[]) {
    this.keys = apiKeys.map(key => ({ key, timestamps: [] }));
  }

  get size(): number {
    return this.keys.length;
  }

  /**
   * Get the next available key via round-robin.
   * If the next key is at its rate limit, try the others.
   * Returns null if ALL keys are exhausted (caller should skip this scan).
   */
  acquire(): KeyState | null {
    if (this.keys.length === 0) return null;

    const now = Date.now();
    const startIndex = this.index;

    // Try each key starting from current round-robin position
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (startIndex + i) % this.keys.length;
      const ks = this.keys[idx];

      // Prune timestamps outside the window
      ks.timestamps = ks.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

      if (ks.timestamps.length < RATE_LIMIT_PER_KEY) {
        // Key has capacity — record this request and advance round-robin
        ks.timestamps.push(now);
        this.index = (idx + 1) % this.keys.length;
        return ks;
      }
    }

    // All keys exhausted
    return null;
  }

  /**
   * Record an additional request against a specific key.
   * Used when we make a second call (e.g., /swap) on the same key.
   */
  record(ks: KeyState): void {
    ks.timestamps.push(Date.now());
  }

  /** Get rate limit stats for monitoring */
  getStats(): { key: number; used: number; limit: number }[] {
    const now = Date.now();
    return this.keys.map((ks, i) => {
      const used = ks.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS).length;
      return { key: i, used, limit: RATE_LIMIT_PER_KEY };
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Jupiter API URLs
// ═══════════════════════════════════════════════════════════════

const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_IX_URL = 'https://lite-api.jup.ag/swap/v1/swap-instructions';

// ═══════════════════════════════════════════════════════════════
// Jupiter /swap-instructions response types
// ═══════════════════════════════════════════════════════════════

interface JupiterIxPayload {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string; // base64-encoded
}

interface SwapInstructionsResponse {
  setupInstructions?: JupiterIxPayload[];
  swapInstruction: JupiterIxPayload;
  cleanupInstruction?: JupiterIxPayload;
  addressLookupTableAddresses?: string[];
}

// ═══════════════════════════════════════════════════════════════
// Circular Scanner
// ═══════════════════════════════════════════════════════════════

export class CircularScanner {
  private config: BotConfig;
  private keyPool: KeyPool;
  private connectionManager: ConnectionManager | null = null;
  private wallet: Keypair | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: CircularCallback[] = [];

  // Scan amounts in lamports — try multiple sizes per token
  private scanAmounts: bigint[];

  // Stats
  private totalScans = 0;
  private totalOpportunities = 0;
  private totalExecutions = 0;
  private cycleCount = 0;
  private lastCycleMs = 0;
  private skippedRateLimit = 0;

  // Scan interval — 250ms between individual quote pairs = 4 checks/second
  private readonly SCAN_INTERVAL_MS = 250;

  constructor(config: BotConfig) {
    this.config = config;

    // Collect all configured Jupiter API keys
    const apiKeys: string[] = [];
    if (config.jupiterApiKey) apiKeys.push(config.jupiterApiKey);
    if (config.jupiterApiKey2) apiKeys.push(config.jupiterApiKey2);
    if (config.jupiterApiKey3) apiKeys.push(config.jupiterApiKey3);
    if (config.jupiterApiKey4) apiKeys.push(config.jupiterApiKey4);

    this.keyPool = new KeyPool(apiKeys);

    if (apiKeys.length === 0) {
      executionLog.warn('CircularScanner: No Jupiter API keys configured — scanner disabled');
    }

    // Dynamic sizing: 5% of capital, capped at risk manager max (0.5 SOL)
    const maxFromCapital = config.capitalSol * 0.05;
    const maxFromRisk = 0.5; // MAX_SINGLE_TRADE_SOL in riskManager
    const tradeSol = Math.min(maxFromCapital, maxFromRisk, 0.5);
    const baseLamports = BigInt(Math.round(tradeSol * LAMPORTS_PER_SOL));
    this.scanAmounts = [baseLamports, baseLamports / 2n];

    executionLog.info(
      {
        apiKeys: apiKeys.length,
        tokens: SCAN_TOKENS.length,
        pairs: SCAN_TOKENS.map(t => `SOL→${t.symbol}→SOL`),
        scanAmounts: this.scanAmounts.map(a => `${Number(a) / LAMPORTS_PER_SOL} SOL`),
        rateLimit: `${RATE_LIMIT_PER_KEY} req/min per key`,
      },
      'CircularScanner initialized',
    );
  }

  /**
   * Set the connection manager and wallet for execution.
   * Must be called before start() if you want the scanner to execute trades.
   * Without these, the scanner only detects opportunities (dry-run mode).
   */
  setExecutionContext(connMgr: ConnectionManager, wallet: Keypair): void {
    this.connectionManager = connMgr;
    this.wallet = wallet;
    executionLog.info('CircularScanner: execution context set — will execute profitable trades');
  }

  /** Clear execution context — scanner continues monitoring but stops executing */
  clearExecutionContext(): void {
    this.connectionManager = null;
    this.wallet = null;
    executionLog.info('CircularScanner: execution context cleared — monitoring only');
  }

  /** Register a callback for when profitable circular routes are found */
  onOpportunity(cb: CircularCallback): void {
    this.callbacks.push(cb);
  }

  /** Start the background scanning loop */
  start(): void {
    if (this.running || this.keyPool.size === 0) return;
    this.running = true;
    executionLog.info('CircularScanner STARTED — background Jupiter scanning active');
    this.runCycle();
  }

  /** Stop the scanner */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    executionLog.info(
      {
        totalScans: this.totalScans,
        totalOpportunities: this.totalOpportunities,
        totalExecutions: this.totalExecutions,
        skippedRateLimit: this.skippedRateLimit,
        cycles: this.cycleCount,
      },
      'CircularScanner STOPPED',
    );
  }

  /** Run one complete scan cycle through all tokens */
  private async runCycle(): Promise<void> {
    if (!this.running) return;

    const cycleStart = Date.now();
    this.cycleCount++;

    for (const token of SCAN_TOKENS) {
      if (!this.running) break;

      for (const amount of this.scanAmounts) {
        if (!this.running) break;

        try {
          await this.scanCircularRoute(token, amount);
        } catch (err: any) {
          executionLog.debug(
            { err: err?.message, token: token.symbol },
            'CircularScanner: scan error',
          );
        }

        // Wait between scans to respect rate limits across 4 keys
        await sleep(this.SCAN_INTERVAL_MS);
      }
    }

    this.lastCycleMs = Date.now() - cycleStart;

    if (this.cycleCount % 10 === 0) {
      executionLog.info(
        {
          cycle: this.cycleCount,
          cycleMs: this.lastCycleMs,
          scans: this.totalScans,
          opportunities: this.totalOpportunities,
          executions: this.totalExecutions,
          skippedRateLimit: this.skippedRateLimit,
          keyStats: this.keyPool.getStats(),
        },
        'CircularScanner: cycle stats',
      );
    }

    // Schedule next cycle immediately (50ms gap for GC breathing room)
    if (this.running) {
      this.timer = setTimeout(() => this.runCycle(), 50);
    }
  }

  /**
   * Scan a single circular route: SOL → Token → SOL
   * Uses two Jupiter quotes: forward (buy) and reverse (sell).
   * If profitable: execute via /swap → deserialize → replace blockhash → tip → send.
   */
  private async scanCircularRoute(token: TokenInfo, inputLamports: bigint): Promise<void> {
    // ── Acquire a key (skip if all keys rate-limited) ──────────
    const forwardKey = this.keyPool.acquire();
    if (!forwardKey) {
      this.skippedRateLimit++;
      return; // All keys at limit — skip, don't block
    }

    this.totalScans++;

    // ── Forward quote: SOL → Token ─────────────────────────────
    const forwardParams = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: token.mint,
      amount: inputLamports.toString(),
      slippageBps: '50',
      maxAccounts: String(JUPITER_MAX_ACCOUNTS),
    });

    const forwardResp = await fetch(`${JUPITER_QUOTE_URL}?${forwardParams}`, {
      headers: buildHeaders(forwardKey.key),
      signal: AbortSignal.timeout(5000),
    });

    if (!forwardResp.ok) return;
    const forwardQuote = await forwardResp.json() as any;
    if (!forwardQuote?.outAmount) return;

    const tokenAmount = forwardQuote.outAmount; // string from Jupiter

    // ── Reverse quote: Token → SOL ─────────────────────────────
    // Acquire another request on a key — prefer the SAME key for affinity,
    // but if it's full, try another. If all full, skip.
    const reverseKey = this.keyPool.acquire();
    if (!reverseKey) {
      this.skippedRateLimit++;
      return;
    }

    const reverseParams = new URLSearchParams({
      inputMint: token.mint,
      outputMint: SOL_MINT,
      amount: tokenAmount,
      slippageBps: '50',
      maxAccounts: String(JUPITER_MAX_ACCOUNTS),
    });

    const reverseResp = await fetch(`${JUPITER_QUOTE_URL}?${reverseParams}`, {
      headers: buildHeaders(reverseKey.key),
      signal: AbortSignal.timeout(5000),
    });

    if (!reverseResp.ok) return;
    const reverseQuote = await reverseResp.json() as any;
    if (!reverseQuote?.outAmount) return;

    // ── Profitability check (all BigInt) ───────────────────────
    const outputLamports = BigInt(reverseQuote.outAmount);
    const grossProfit = outputLamports - inputLamports;
    const feeLamports = BigInt(TWO_LEG_FEE_LAMPORTS);
    const netProfit = grossProfit - feeLamports;
    const spreadBps = Number(grossProfit * 10_000n / inputLamports);

    // Extract route labels for logging
    const buyRoute = (forwardQuote.routePlan || [])
      .map((r: any) => r?.swapInfo?.label || '?')
      .join(' → ');
    const sellRoute = (reverseQuote.routePlan || [])
      .map((r: any) => r?.swapInfo?.label || '?')
      .join(' → ');

    if (netProfit <= 0n) return;

    // ══════════════════════════════════════════════════════════
    // PROFITABLE! Execute.
    // ══════════════════════════════════════════════════════════

    this.totalOpportunities++;

    const opp: CircularOpportunity = {
      tokenSymbol: token.symbol,
      tokenMint: token.mint,
      inputLamports,
      outputLamports,
      grossProfitLamports: grossProfit,
      netProfitLamports: netProfit,
      spreadBps,
      buyRoute,
      sellRoute,
      timestamp: Date.now(),
    };

    executionLog.info(
      {
        token: token.symbol,
        inputSol: (Number(inputLamports) / LAMPORTS_PER_SOL).toFixed(3),
        grossProfitSol: (Number(grossProfit) / LAMPORTS_PER_SOL).toFixed(6),
        netProfitSol: (Number(netProfit) / LAMPORTS_PER_SOL).toFixed(6),
        spreadBps: spreadBps.toFixed(1),
        buy: buyRoute,
        sell: sellRoute,
      },
      `CIRCULAR: ${token.symbol} +${spreadBps.toFixed(1)}bps — PROFITABLE`,
    );

    // Fire callbacks (e.g., risk manager, metrics)
    for (const cb of this.callbacks) {
      try { cb(opp); } catch (err: any) {
        executionLog.warn({ err: err?.message }, 'CircularScanner: callback error');
      }
    }

    // ── Execute: /swap → deserialize → patch → sign → send ───
    await this.executeOpportunity(opp, reverseKey, forwardQuote, reverseQuote);
  }

  /**
   * Execute a profitable opportunity ATOMICALLY — both legs in ONE transaction.
   * NEVER hold an intermediate token position. SOL in, SOL out, one TX.
   *
   * Flow:
   *   1. Call /swap-instructions for BOTH legs (2 API calls, same key)
   *   2. Parse returned instruction sets (setup, swap, cleanup for each leg)
   *   3. Combine all instructions into ONE atomic transaction
   *   4. Replace blockhash with getCachedBlockhash() (fresher)
   *   5. Append dynamic Jito tip as LAST instruction
   *   6. Resolve all address lookup tables (union of both legs)
   *   7. Sign with wallet
   *   8. Send via Helius Sender (fire-and-forget)
   *   9. Enqueue signature for background confirmation tracking
   *
   * If combined TX exceeds 1232 bytes → skip (don't send non-atomic fallback).
   */
  private async executeOpportunity(
    opp: CircularOpportunity,
    executionKey: KeyState,
    forwardQuote: any,
    reverseQuote: any,
  ): Promise<void> {
    if (!this.connectionManager || !this.wallet) {
      executionLog.debug('CircularScanner: no execution context — dry run only');
      return;
    }

    try {
      const walletPubkey = this.wallet.publicKey.toString();
      const swapIxHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': executionKey.key,
      };

      // ── Step 1: Call /swap-instructions for BOTH legs ─────
      // Charge both calls against this key's rate limit
      this.keyPool.record(executionKey);
      this.keyPool.record(executionKey);

      const swapIxBody = (quoteResponse: any) => JSON.stringify({
        quoteResponse,
        userPublicKey: walletPubkey,
        wrapAndUnwrapSol: true,
        dynamicSlippage: { minBps: 1, maxBps: 300 },
      });

      // Fire both /swap-instructions calls in parallel
      const [forwardResp, reverseResp] = await Promise.all([
        fetch(JUPITER_SWAP_IX_URL, {
          method: 'POST',
          headers: swapIxHeaders,
          body: swapIxBody(forwardQuote),
          signal: AbortSignal.timeout(8000),
        }),
        fetch(JUPITER_SWAP_IX_URL, {
          method: 'POST',
          headers: swapIxHeaders,
          body: swapIxBody(reverseQuote),
          signal: AbortSignal.timeout(8000),
        }),
      ]);

      if (!forwardResp.ok || !reverseResp.ok) {
        executionLog.warn(
          { fwd: forwardResp.status, rev: reverseResp.status, token: opp.tokenSymbol },
          'CircularScanner: /swap-instructions failed',
        );
        return;
      }

      const fwdIx = await forwardResp.json() as SwapInstructionsResponse;
      const revIx = await reverseResp.json() as SwapInstructionsResponse;

      if (!fwdIx.swapInstruction || !revIx.swapInstruction) {
        executionLog.warn({ token: opp.tokenSymbol }, 'CircularScanner: missing swapInstruction');
        return;
      }

      // ── Step 2: Parse instructions from both legs ─────────
      const fwdSetup = (fwdIx.setupInstructions || []).map(deserializeIx);
      const fwdSwap = deserializeIx(fwdIx.swapInstruction);
      const fwdCleanup = fwdIx.cleanupInstruction ? [deserializeIx(fwdIx.cleanupInstruction)] : [];

      const revSetup = (revIx.setupInstructions || []).map(deserializeIx);
      const revSwap = deserializeIx(revIx.swapInstruction);
      const revCleanup = revIx.cleanupInstruction ? [deserializeIx(revIx.cleanupInstruction)] : [];

      // ── Step 3: Compute dynamic Jito tip ──────────────────
      // min(max(profit * 40%, 1000), 200000) — pure BigInt
      const rawTip = opp.grossProfitLamports * 40n / 100n;
      const dynamicTip = rawTip < 1_000n ? 1_000n : rawTip > 200_000n ? 200_000n : rawTip;

      const jitoTipIx = SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: new PublicKey(getRandomTipAccount()),
        lamports: dynamicTip,
      });

      // ── Step 4: Combine all instructions into ONE TX ──────
      // Order: ComputeBudget → fwd setup → fwd swap → rev setup → rev swap
      //        → fwd cleanup → rev cleanup → Jito tip (LAST)
      //
      // Compute budget: use the higher of the two leg estimates, or 400k default.
      // Filter out any ComputeBudget IXs from Jupiter — we set our own.
      const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toString();

      const filterCB = (ix: TransactionInstruction) =>
        ix.programId.toString() !== COMPUTE_BUDGET_PROGRAM;

      const instructions: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: getCachedPriorityFee() }),
        ...fwdSetup.filter(filterCB),
        fwdSwap,
        ...revSetup.filter(filterCB),
        revSwap,
        ...fwdCleanup.filter(filterCB),
        ...revCleanup.filter(filterCB),
        jitoTipIx,
      ];

      // ── Step 5: Resolve ALL address lookup tables ─────────
      const connection = this.connectionManager.getConnection();
      const allAltAddresses = new Set<string>();
      for (const addr of (fwdIx.addressLookupTableAddresses || [])) allAltAddresses.add(addr);
      for (const addr of (revIx.addressLookupTableAddresses || [])) allAltAddresses.add(addr);

      const lookupTableAccounts: AddressLookupTableAccount[] = [];
      for (const addr of allAltAddresses) {
        try {
          const info = await connection.getAddressLookupTable(new PublicKey(addr));
          if (info.value) lookupTableAccounts.push(info.value);
        } catch (err: any) {
          executionLog.debug({ err: err?.message, alt: addr }, 'CircularScanner: ALT fetch error');
        }
      }

      // ── Step 6: Build V0 message with fresh blockhash ─────
      const freshBlockhash = getCachedBlockhash();
      if (!freshBlockhash) {
        executionLog.warn('CircularScanner: no cached blockhash — skipping execution');
        return;
      }

      const message = new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: freshBlockhash,
        instructions,
      }).compileToV0Message(lookupTableAccounts);

      const tx = new VersionedTransaction(message);

      // ── Step 7: Sign ──────────────────────────────────────
      tx.sign([this.wallet]);

      // ── Step 8: Check TX size (must fit in 1232 bytes) ────
      const serialized = Buffer.from(tx.serialize());
      if (serialized.length > 1232) {
        executionLog.warn(
          { txSize: serialized.length, token: opp.tokenSymbol },
          'CircularScanner: combined TX exceeds 1232 bytes — skipping (no non-atomic fallback)',
        );
        return;
      }

      // ── Step 9: Send via Helius Sender (fire-and-forget) ──
      const signature = await this.connectionManager.sendSmartTransaction(serialized);

      this.totalExecutions++;

      executionLog.info(
        {
          token: opp.tokenSymbol,
          signature,
          tipLamports: dynamicTip.toString(),
          netProfitLamports: opp.netProfitLamports.toString(),
          spreadBps: opp.spreadBps,
          txSize: serialized.length,
          ixCount: instructions.length,
          altCount: lookupTableAccounts.length,
        },
        `CIRCULAR EXECUTED: ${opp.tokenSymbol} — atomic 2-leg TX sent via Helius Sender`,
      );

      // ── Step 10: Enqueue for background confirmation ──────
      enqueueSignature({
        signature,
        enqueuedAt: Date.now(),
        expectedProfitLamports: opp.netProfitLamports,
        tipLamports: dynamicTip,
        buyPool: `jupiter:${opp.buyRoute}`,
        sellPool: `jupiter:${opp.sellRoute}`,
        solPrice: this.config.solPriceUsd || 0,
        preBalanceLamports: null,
      });

    } catch (err: any) {
      executionLog.warn(
        { err: err?.message, token: opp.tokenSymbol },
        'CircularScanner: execution failed',
      );
    }
  }

  /** Get scanner stats */
  getStats() {
    return {
      running: this.running,
      apiKeys: this.keyPool.size,
      totalScans: this.totalScans,
      totalOpportunities: this.totalOpportunities,
      totalExecutions: this.totalExecutions,
      skippedRateLimit: this.skippedRateLimit,
      cycleCount: this.cycleCount,
      lastCycleMs: this.lastCycleMs,
      keyStats: this.keyPool.getStats(),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Deserialize a Jupiter instruction payload into a Solana TransactionInstruction.
 * Jupiter /swap-instructions returns instructions as JSON objects with:
 *   programId (string), accounts (array), data (base64 string)
 */
function deserializeIx(ix: JupiterIxPayload): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
