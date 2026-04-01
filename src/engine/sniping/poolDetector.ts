// POOL DETECTOR
// Polls Raydium and Pump.fun for newly created liquidity pools.
// Emits 'newPool' events when a new pool is detected.

import { Connection, PublicKey } from '@solana/web3.js';
import { strategyLog } from '../logger.js';
import { BotConfig } from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// Program IDs
const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const PUMPFUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
// Raydium pool initialization discriminator (initialize2 instruction)
const RAYDIUM_INIT_DISCRIMINATOR = 1;

export interface NewPoolInfo {
  /** Pool address */
  poolAddress: string;
  /** Base token mint (the new token) */
  baseMint: string;
  /** Quote token mint (usually SOL or USDC) */
  quoteMint: string;
  /** Estimated initial liquidity in lamports */
  initialLiquidityLamports: number;
  /** Source: 'raydium' or 'pumpfun' */
  source: 'raydium' | 'pumpfun';
  /** Transaction signature that created the pool */
  signature: string;
  /** Slot the pool was created in */
  slot: number;
  /** Timestamp of detection */
  detectedAt: number;
  /** LP mint address if available */
  lpMint: string | null;
}

type PoolCallback = (pool: NewPoolInfo) => void;

export class PoolDetector {
  private connectionManager: ConnectionManager;
  private config: BotConfig;
  private callbacks: PoolCallback[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastProcessedSlot: number = 0;
  private seenSignatures: Set<string> = new Set();
  private isRunning: boolean = false;

  // Rate limit tracking
  private rpcCallCount: number = 0;
  private rpcCallWindowStart: number = 0;
  private readonly MAX_RPC_PER_SECOND = 8; // Stay under Helius free tier 10/sec

  constructor(connectionManager: ConnectionManager, config: BotConfig) {
    this.connectionManager = connectionManager;
    this.config = config;
  }

  onNewPool(callback: PoolCallback): void {
    this.callbacks.push(callback);
  }

  private emit(pool: NewPoolInfo): void {
    for (const cb of this.callbacks) {
      try {
        cb(pool);
      } catch (err) {
        strategyLog.error({ err }, 'Pool callback error');
      }
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Get current slot as baseline
    try {
      const conn = this.connectionManager.getConnection();
      this.lastProcessedSlot = await conn.getSlot('confirmed');
      strategyLog.info({ startSlot: this.lastProcessedSlot }, 'PoolDetector started');
    } catch (err) {
      strategyLog.error({ err }, 'Failed to get initial slot');
      this.lastProcessedSlot = 0;
    }

    // Poll every 500ms
    this.pollTimer = setInterval(() => this.poll(), 500);
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    strategyLog.info('PoolDetector stopped');
  }

  private async rateLimit(): Promise<boolean> {
    const now = Date.now();
    if (now - this.rpcCallWindowStart > 1000) {
      this.rpcCallCount = 0;
      this.rpcCallWindowStart = now;
    }
    if (this.rpcCallCount >= this.MAX_RPC_PER_SECOND) {
      return false; // Skip this poll cycle
    }
    this.rpcCallCount++;
    return true;
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      // Poll Raydium and Pump.fun in parallel
      await Promise.allSettled([
        this.pollRaydiumPools(),
        this.pollPumpfunGraduations(),
      ]);
    } catch (err) {
      strategyLog.error({ err }, 'Pool detection poll error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RAYDIUM NEW POOL DETECTION
  // Uses getSignaturesForAddress on the Raydium AMM program to
  // find recent transactions, then parses them for pool init events.
  // ═══════════════════════════════════════════════════════════════

  private async pollRaydiumPools(): Promise<void> {
    if (!(await this.rateLimit())) return;

    const conn = this.connectionManager.getConnection();

    try {
      // Get recent signatures for the Raydium AMM program
      const signatures = await conn.getSignaturesForAddress(
        RAYDIUM_AMM_V4,
        { limit: 10 },
        'confirmed',
      );

      if (signatures.length === 0) return;

      for (const sigInfo of signatures) {
        // Skip already seen
        if (this.seenSignatures.has(sigInfo.signature)) continue;
        this.seenSignatures.add(sigInfo.signature);

        // Skip if before our start slot
        if (sigInfo.slot <= this.lastProcessedSlot) continue;

        // Skip errors
        if (sigInfo.err) continue;

        // Rate limit the transaction parsing
        if (!(await this.rateLimit())) break;

        try {
          const tx = await conn.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          if (!tx || !tx.meta || tx.meta.err) continue;

          // Look for Raydium AMM initialize instruction
          const poolInfo = this.parseRaydiumPoolCreation(tx, sigInfo.signature, sigInfo.slot);
          if (poolInfo) {
            strategyLog.info(
              { pool: poolInfo.poolAddress, base: poolInfo.baseMint, liq: poolInfo.initialLiquidityLamports / 1e9 },
              'New Raydium pool detected',
            );
            this.emit(poolInfo);
          }
        } catch (err) {
          // Individual tx parse failure is non-fatal
          strategyLog.debug({ err, sig: sigInfo.signature }, 'Failed to parse Raydium tx');
        }
      }

      // Update processed slot
      if (signatures.length > 0 && signatures[0].slot > this.lastProcessedSlot) {
        this.lastProcessedSlot = signatures[0].slot;
      }
    } catch (err) {
      strategyLog.debug({ err }, 'Raydium poll error');
    }
  }

  private parseRaydiumPoolCreation(tx: any, signature: string, slot: number): NewPoolInfo | null {
    const instructions = tx.transaction?.message?.instructions || [];

    // Find Raydium AMM instruction
    for (const ix of instructions) {
      if (ix.programId?.toString() !== RAYDIUM_AMM_V4.toString()) continue;

      // CRITICAL: Distinguish pool initialization from regular swaps.
      // Raydium AMM V4 initialize2 instruction requires exactly 21 accounts.
      // Regular swaps (swapBaseIn/swapBaseOut) have fewer (typically 17-18 accounts).
      // Also check that the instruction data starts with the init discriminator.
      const accounts = ix.accounts || [];

      // Initialize2 needs exactly 21 accounts; swaps have fewer
      if (accounts.length < 20) continue;

      // If we have raw instruction data, check the discriminator byte
      // Raydium AMM V4: initialize2 = discriminator 1
      if (ix.data) {
        try {
          const dataBytes = Buffer.from(ix.data, 'base64');
          if (dataBytes.length > 0 && dataBytes[0] !== RAYDIUM_INIT_DISCRIMINATOR) {
            continue; // Not an initialize instruction
          }
        } catch {
          // If we can't parse data, fall through to account-based checks
        }
      }

      // Additional validation: known program IDs should not be baseMint
      // (prevents detecting swaps involving Serum/OpenBook as "new pools")
      const baseMint = accounts[8]?.toString();
      const quoteMint = accounts[9]?.toString();
      const lpMint = accounts[7]?.toString() || null;
      const poolAddress = accounts[4]?.toString();

      if (!poolAddress || !baseMint || !quoteMint) continue;

      // Reject if baseMint is a known program ID (not a token)
      const KNOWN_PROGRAMS = new Set([
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',       // Token Program
        '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',      // Serum DEX v3
        'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',       // SRM token (often mistaken)
        '11111111111111111111111111111111',                     // System Program
        'So11111111111111111111111111111111111111112',          // Wrapped SOL
      ]);
      if (KNOWN_PROGRAMS.has(baseMint) || KNOWN_PROGRAMS.has(quoteMint)) continue;
      if (KNOWN_PROGRAMS.has(poolAddress)) continue;

      // Extract initial liquidity from SOL balance changes
      let initialLiquidity = 0;
      const preTokenBalances = tx.meta?.preTokenBalances || [];
      const postTokenBalances = tx.meta?.postTokenBalances || [];
      for (const post of postTokenBalances) {
        if (post.mint === 'So11111111111111111111111111111111111111112') {
          const pre = preTokenBalances.find(
            (p: any) => p.accountIndex === post.accountIndex,
          );
          const preAmount = pre ? parseInt(pre.uiTokenAmount?.amount || '0') : 0;
          const postAmount = parseInt(post.uiTokenAmount?.amount || '0');
          if (postAmount > preAmount) {
            initialLiquidity = Math.max(initialLiquidity, postAmount - preAmount);
          }
        }
      }

      // Fallback: use raw SOL balance changes
      if (initialLiquidity === 0) {
        const preBalances = tx.meta?.preBalances || [];
        const postBalances = tx.meta?.postBalances || [];
        // Look for the largest SOL deposit (likely the quote vault)
        for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
          const diff = postBalances[i] - preBalances[i];
          if (diff > initialLiquidity) initialLiquidity = diff;
        }
      }

      return {
        poolAddress,
        baseMint,
        quoteMint,
        initialLiquidityLamports: initialLiquidity,
        source: 'raydium',
        signature,
        slot,
        detectedAt: Date.now(),
        lpMint,
      };
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // PUMP.FUN GRADUATION DETECTION
  // Pump.fun tokens "graduate" to Raydium when they hit the bonding
  // curve threshold. We detect the migration transaction.
  // ═══════════════════════════════════════════════════════════════

  private async pollPumpfunGraduations(): Promise<void> {
    if (!(await this.rateLimit())) return;

    const conn = this.connectionManager.getConnection();

    try {
      // Get recent signatures for the Pump.fun program
      const signatures = await conn.getSignaturesForAddress(
        PUMPFUN_PROGRAM,
        { limit: 5 },
        'confirmed',
      );

      for (const sigInfo of signatures) {
        if (this.seenSignatures.has(sigInfo.signature)) continue;
        this.seenSignatures.add(sigInfo.signature);
        if (sigInfo.slot <= this.lastProcessedSlot) continue;
        if (sigInfo.err) continue;

        if (!(await this.rateLimit())) break;

        try {
          const tx = await conn.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });

          if (!tx || !tx.meta || tx.meta.err) continue;

          // Look for Pump.fun migration: the TX will include both Pump.fun
          // and Raydium AMM program invocations (graduation creates a Raydium pool)
          const programs = new Set<string>();
          const allIx = [
            ...(tx.transaction?.message?.instructions || []),
          ];
          // Also check inner instructions
          for (const inner of tx.meta?.innerInstructions || []) {
            allIx.push(...(inner.instructions || []));
          }
          for (const ix of allIx) {
            programs.add(ix.programId?.toString() || '');
          }

          // A graduation TX touches both Pump.fun AND Raydium
          if (programs.has(PUMPFUN_PROGRAM.toString()) && programs.has(RAYDIUM_AMM_V4.toString())) {
            const poolInfo = this.parsePumpfunGraduation(tx, sigInfo.signature, sigInfo.slot);
            if (poolInfo) {
              strategyLog.info(
                { pool: poolInfo.poolAddress, base: poolInfo.baseMint, liq: poolInfo.initialLiquidityLamports / 1e9 },
                'Pump.fun graduation detected',
              );
              this.emit(poolInfo);
            }
          }
        } catch (err) {
          strategyLog.debug({ err, sig: sigInfo.signature }, 'Failed to parse Pump.fun tx');
        }
      }
    } catch (err) {
      strategyLog.debug({ err }, 'Pump.fun poll error');
    }
  }

  private parsePumpfunGraduation(tx: any, signature: string, slot: number): NewPoolInfo | null {
    // In a graduation TX, Raydium pool creation happens as an inner instruction.
    // We look for the Raydium AMM accounts in inner instructions.
    const innerInstructions = tx.meta?.innerInstructions || [];

    for (const inner of innerInstructions) {
      for (const ix of inner.instructions || []) {
        if (ix.programId?.toString() !== RAYDIUM_AMM_V4.toString()) continue;

        const accounts = ix.accounts || [];
        if (accounts.length < 10) continue;

        const poolAddress = accounts[0]?.toString();
        const baseMint = accounts[6]?.toString();
        const quoteMint = accounts[7]?.toString();

        if (!poolAddress || !baseMint || !quoteMint) continue;

        // Estimate liquidity from SOL balance changes
        let initialLiquidity = 0;
        const preBalances = tx.meta?.preBalances || [];
        const postBalances = tx.meta?.postBalances || [];
        for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
          const diff = postBalances[i] - preBalances[i];
          if (diff > initialLiquidity && diff > 1_000_000_000) { // > 1 SOL deposit
            initialLiquidity = diff;
          }
        }

        return {
          poolAddress,
          baseMint,
          quoteMint,
          initialLiquidityLamports: initialLiquidity,
          source: 'pumpfun',
          signature,
          slot,
          detectedAt: Date.now(),
          lpMint: null,
        };
      }
    }

    return null;
  }

  // Housekeeping: prevent seenSignatures from growing unbounded
  pruneSeenSignatures(): void {
    if (this.seenSignatures.size > 10_000) {
      const arr = Array.from(this.seenSignatures);
      this.seenSignatures = new Set(arr.slice(-5_000));
    }
  }

  get running(): boolean {
    return this.isRunning;
  }
}
