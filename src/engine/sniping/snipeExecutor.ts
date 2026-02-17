// SNIPE EXECUTOR + TIERED EXIT MANAGER
// Handles snipe entry execution and multi-tier profit-taking exits.
//
// Entry: Buy 0.1 SOL of a new token via Jupiter swap
// Exit tiers:
//   50% at 2x entry price
//   25% at 5x entry price
//   25% at 10x OR stop-loss
//
// Stop-loss triggers:
//   - Price drops 40% from entry
//   - No 2x within 10 minutes
//   - Pool liquidity drops 50%

import crypto from 'crypto';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { strategyLog } from '../logger.js';
import { BotConfig, SOL_MINT, LAMPORTS_PER_SOL } from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const SNIPE_SLIPPAGE_BPS = 1500;              // 15% slippage for new tokens
const PRIORITY_FEE_LAMPORTS = 1_000_000;      // 0.001 SOL priority fee
const CONFIRM_TIMEOUT_MS = 30_000;
const EXIT_POLL_INTERVAL_MS = 3_000;          // Check exit conditions every 3s
const TIER1_MULTIPLIER = 2;                   // Sell 50% at 2x
const TIER2_MULTIPLIER = 5;                   // Sell 25% at 5x
const TIER3_MULTIPLIER = 10;                  // Sell 25% at 10x
const STOP_LOSS_PERCENT = 40;                 // Stop-loss at -40%
const MAX_TIME_TO_2X_MS = 10 * 60 * 1000;    // 10 minutes to reach 2x
const LIQUIDITY_DROP_PERCENT = 50;            // Rug signal: -50% liquidity

export type ExitTier = 'tier1' | 'tier2' | 'tier3' | 'stop_loss' | 'timeout' | 'rug_detected';

export interface SnipePosition {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  entryAmountSol: number;
  entryTokenAmount: bigint;
  entryPricePerToken: number;      // SOL per token
  entryTimestamp: number;
  entrySolPrice: number;           // USD price of SOL at entry
  entrySignature: string;
  initialPoolLiquidityLamports: number;
  status: 'open' | 'partial' | 'closed';
  // Tier tracking
  tier1Sold: boolean;              // 50% sold at 2x
  tier1Signature: string | null;
  tier2Sold: boolean;              // 25% sold at 5x
  tier2Signature: string | null;
  tier3Sold: boolean;              // 25% sold at 10x or stop-loss
  tier3Signature: string | null;
  // P&L
  totalSolRecovered: number;
  realizedProfitSol: number;
  exitReason: ExitTier | null;
}

export interface SnipeResult {
  success: boolean;
  position: SnipePosition | null;
  error: string | null;
  signature: string | null;
}

type PositionUpdateCallback = (position: SnipePosition) => void;

export class SnipeExecutor {
  private connectionManager: ConnectionManager;
  private config: BotConfig;
  private openPositions: Map<string, SnipePosition> = new Map();
  private exitTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private callbacks: PositionUpdateCallback[] = [];

  constructor(connectionManager: ConnectionManager, config: BotConfig) {
    this.connectionManager = connectionManager;
    this.config = config;
  }

  onPositionUpdate(callback: PositionUpdateCallback): void {
    this.callbacks.push(callback);
  }

  private emitUpdate(position: SnipePosition): void {
    for (const cb of this.callbacks) {
      try { cb(position); } catch {}
    }
  }

  getOpenPositions(): SnipePosition[] {
    return Array.from(this.openPositions.values()).filter(p => p.status !== 'closed');
  }

  getOpenPositionCount(): number {
    return this.getOpenPositions().length;
  }

  // ═══════════════════════════════════════════════════════════════
  // SNIPE ENTRY
  // ═══════════════════════════════════════════════════════════════

  async executeSnipe(
    tokenMint: string,
    tokenSymbol: string,
    poolAddress: string,
    amountSol: number,
    initialPoolLiquidityLamports: number,
  ): Promise<SnipeResult> {
    const id = crypto.randomUUID();
    const amountLamports = Math.round(amountSol * LAMPORTS_PER_SOL);

    strategyLog.info(
      { id: id.slice(0, 8), token: tokenSymbol, mint: tokenMint.slice(0, 8), amountSol },
      'Executing snipe entry',
    );

    try {
      // 1. Get Jupiter quote for SOL → Token
      const quote = await this.getJupiterQuote(
        SOL_MINT, tokenMint, amountLamports.toString(),
      );
      if (!quote || !quote.outAmount) {
        return { success: false, position: null, error: 'No Jupiter quote available', signature: null };
      }

      // 2. Get swap transaction
      const swapTx = await this.getJupiterSwapTransaction(quote);
      if (!swapTx) {
        return { success: false, position: null, error: 'Failed to get swap transaction', signature: null };
      }

      // 3. Simulate before sending
      const conn = this.connectionManager.getConnection();
      const simResult = await conn.simulateTransaction(swapTx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });

      if (simResult.value.err) {
        return {
          success: false, position: null,
          error: `Simulation failed: ${JSON.stringify(simResult.value.err)}`,
          signature: null,
        };
      }

      // 4. Sign and send
      const wallet = this.connectionManager.getWallet();
      swapTx.sign([wallet]);

      const signature = await conn.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });

      // 5. Confirm
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const confirmResult = await Promise.race([
        conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'),
        new Promise<{ value: { err: string } }>(resolve =>
          setTimeout(() => resolve({ value: { err: 'TIMEOUT' } }), CONFIRM_TIMEOUT_MS),
        ),
      ]);

      if ((confirmResult as any).value?.err) {
        return {
          success: false, position: null,
          error: `Confirmation failed: ${JSON.stringify((confirmResult as any).value.err)}`,
          signature,
        };
      }

      // 6. Get actual token balance received
      let tokenBalance = 0n;
      try {
        // Small delay to let RPC catch up
        await new Promise(r => setTimeout(r, 1000));
        tokenBalance = await this.connectionManager.getTokenBalance(tokenMint);
      } catch {
        // Use expected from quote as fallback
        tokenBalance = BigInt(quote.outAmount);
      }

      if (tokenBalance <= 0n) {
        return {
          success: false, position: null,
          error: 'Token balance is 0 after swap',
          signature,
        };
      }

      // 7. Calculate entry price
      const entryPricePerToken = amountSol / Number(tokenBalance);

      // 8. Create position
      const position: SnipePosition = {
        id,
        tokenMint,
        tokenSymbol,
        poolAddress,
        entryAmountSol: amountSol,
        entryTokenAmount: tokenBalance,
        entryPricePerToken,
        entryTimestamp: Date.now(),
        entrySolPrice: this.config.solPriceUsd || 150,
        entrySignature: signature,
        initialPoolLiquidityLamports,
        status: 'open',
        tier1Sold: false,
        tier1Signature: null,
        tier2Sold: false,
        tier2Signature: null,
        tier3Sold: false,
        tier3Signature: null,
        totalSolRecovered: 0,
        realizedProfitSol: 0,
        exitReason: null,
      };

      this.openPositions.set(id, position);
      this.startExitMonitor(position);
      this.emitUpdate(position);

      strategyLog.info(
        {
          id: id.slice(0, 8), token: tokenSymbol,
          tokenBalance: tokenBalance.toString(),
          entryPrice: entryPricePerToken.toExponential(4),
          signature,
        },
        'Snipe entry SUCCESS',
      );

      return { success: true, position, error: null, signature };

    } catch (err) {
      strategyLog.error({ err, token: tokenSymbol }, 'Snipe execution error');
      return { success: false, position: null, error: (err as Error).message, signature: null };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TIERED EXIT MONITOR
  // ═══════════════════════════════════════════════════════════════

  private startExitMonitor(position: SnipePosition): void {
    const timer = setInterval(async () => {
      try {
        await this.checkExitConditions(position);
      } catch (err) {
        strategyLog.error({ err, id: position.id.slice(0, 8) }, 'Exit monitor error');
      }
    }, EXIT_POLL_INTERVAL_MS);

    this.exitTimers.set(position.id, timer);
  }

  private stopExitMonitor(positionId: string): void {
    const timer = this.exitTimers.get(positionId);
    if (timer) {
      clearInterval(timer);
      this.exitTimers.delete(positionId);
    }
  }

  private async checkExitConditions(position: SnipePosition): Promise<void> {
    if (position.status === 'closed') {
      this.stopExitMonitor(position.id);
      return;
    }

    // Get current token balance
    let currentBalance: bigint;
    try {
      currentBalance = await this.connectionManager.getTokenBalance(position.tokenMint);
    } catch {
      return; // Skip this cycle if RPC fails
    }

    if (currentBalance <= 0n) {
      // All tokens gone (maybe manual sell)
      position.status = 'closed';
      this.stopExitMonitor(position.id);
      this.emitUpdate(position);
      return;
    }

    // Get current price by quoting a small sell
    const currentPrice = await this.getCurrentPricePerToken(
      position.tokenMint, currentBalance,
    );

    if (currentPrice <= 0) return; // Quote failed, skip

    const priceMultiplier = currentPrice / position.entryPricePerToken;
    const timeSinceEntry = Date.now() - position.entryTimestamp;

    // ── STOP-LOSS CHECKS ─────────────────────────────────────

    // 1. Price dropped 40% from entry
    if (priceMultiplier < (1 - STOP_LOSS_PERCENT / 100)) {
      strategyLog.warn(
        { id: position.id.slice(0, 8), multiplier: priceMultiplier.toFixed(2) },
        'STOP-LOSS: Price dropped 40%',
      );
      await this.sellAll(position, 'stop_loss');
      return;
    }

    // 2. No 2x within 10 minutes
    if (!position.tier1Sold && timeSinceEntry > MAX_TIME_TO_2X_MS) {
      strategyLog.warn(
        { id: position.id.slice(0, 8), minutesElapsed: (timeSinceEntry / 60000).toFixed(1) },
        'STOP-LOSS: No 2x within 10 minutes',
      );
      await this.sellAll(position, 'timeout');
      return;
    }

    // 3. Pool liquidity dropped 50% (rug signal)
    try {
      const poolLiq = await this.getPoolLiquidity(position.poolAddress);
      if (poolLiq > 0 && poolLiq < position.initialPoolLiquidityLamports * (1 - LIQUIDITY_DROP_PERCENT / 100)) {
        strategyLog.warn(
          { id: position.id.slice(0, 8), currentLiq: poolLiq / 1e9, entryLiq: position.initialPoolLiquidityLamports / 1e9 },
          'STOP-LOSS: Pool liquidity dropped 50% (rug signal)',
        );
        await this.sellAll(position, 'rug_detected');
        return;
      }
    } catch {
      // Non-fatal: can't check liquidity
    }

    // ── TIERED PROFIT-TAKING ─────────────────────────────────

    // Tier 1: Sell 50% at 2x
    if (!position.tier1Sold && priceMultiplier >= TIER1_MULTIPLIER) {
      const sellAmount = currentBalance / 2n;
      strategyLog.info(
        { id: position.id.slice(0, 8), multiplier: priceMultiplier.toFixed(2) },
        'TIER 1: Selling 50% at 2x',
      );
      await this.executeSell(position, sellAmount, 'tier1');
    }

    // Tier 2: Sell 25% of ORIGINAL at 5x
    if (position.tier1Sold && !position.tier2Sold && priceMultiplier >= TIER2_MULTIPLIER) {
      const sellAmount = position.entryTokenAmount / 4n;
      const actual = sellAmount > currentBalance ? currentBalance : sellAmount;
      strategyLog.info(
        { id: position.id.slice(0, 8), multiplier: priceMultiplier.toFixed(2) },
        'TIER 2: Selling 25% at 5x',
      );
      await this.executeSell(position, actual, 'tier2');
    }

    // Tier 3: Sell remaining 25% at 10x
    if (position.tier1Sold && position.tier2Sold && !position.tier3Sold && priceMultiplier >= TIER3_MULTIPLIER) {
      strategyLog.info(
        { id: position.id.slice(0, 8), multiplier: priceMultiplier.toFixed(2) },
        'TIER 3: Selling remaining at 10x',
      );
      await this.sellAll(position, 'tier3');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SELL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  private async executeSell(
    position: SnipePosition,
    tokenAmount: bigint,
    tier: ExitTier,
  ): Promise<boolean> {
    try {
      // Get Jupiter quote for Token → SOL
      const quote = await this.getJupiterQuote(
        position.tokenMint, SOL_MINT, tokenAmount.toString(),
      );
      if (!quote || !quote.outAmount) {
        strategyLog.warn({ tier, id: position.id.slice(0, 8) }, 'No sell quote available');
        return false;
      }

      // Get swap transaction
      const swapTx = await this.getJupiterSwapTransaction(quote);
      if (!swapTx) return false;

      // Sign and send
      const conn = this.connectionManager.getConnection();
      const wallet = this.connectionManager.getWallet();
      swapTx.sign([wallet]);

      const signature = await conn.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });

      // Confirm
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      await Promise.race([
        conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'),
        new Promise(resolve => setTimeout(resolve, CONFIRM_TIMEOUT_MS)),
      ]);

      // Update position
      const solRecovered = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
      position.totalSolRecovered += solRecovered;
      position.realizedProfitSol = position.totalSolRecovered - position.entryAmountSol;

      if (tier === 'tier1') {
        position.tier1Sold = true;
        position.tier1Signature = signature;
        position.status = 'partial';
      } else if (tier === 'tier2') {
        position.tier2Sold = true;
        position.tier2Signature = signature;
      } else if (tier === 'tier3') {
        position.tier3Sold = true;
        position.tier3Signature = signature;
        position.status = 'closed';
        position.exitReason = tier;
        this.stopExitMonitor(position.id);
      }

      this.emitUpdate(position);

      strategyLog.info(
        {
          id: position.id.slice(0, 8), tier,
          solRecovered: solRecovered.toFixed(4),
          totalRecovered: position.totalSolRecovered.toFixed(4),
          profitSol: position.realizedProfitSol.toFixed(4),
          signature,
        },
        `Exit ${tier} executed`,
      );

      return true;
    } catch (err) {
      strategyLog.error({ err, tier, id: position.id.slice(0, 8) }, 'Sell execution error');
      return false;
    }
  }

  private async sellAll(position: SnipePosition, reason: ExitTier): Promise<void> {
    let currentBalance: bigint;
    try {
      currentBalance = await this.connectionManager.getTokenBalance(position.tokenMint);
    } catch {
      currentBalance = 0n;
    }

    if (currentBalance > 0n) {
      await this.executeSell(position, currentBalance, reason);
    }

    position.status = 'closed';
    position.exitReason = reason;
    position.realizedProfitSol = position.totalSolRecovered - position.entryAmountSol;
    this.stopExitMonitor(position.id);
    this.emitUpdate(position);
  }

  // ═══════════════════════════════════════════════════════════════
  // JUPITER HELPERS
  // ═══════════════════════════════════════════════════════════════

  private async getJupiterQuote(
    inputMint: string, outputMint: string, amount: string,
  ): Promise<any | null> {
    const url = new URL(`${this.config.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', SNIPE_SLIPPAGE_BPS.toString());

    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  private async getJupiterSwapTransaction(quote: any): Promise<VersionedTransaction | null> {
    try {
      const wallet = this.connectionManager.getWallet();
      const resp = await fetch(`${this.config.jupiterApiUrl}/swap/v1/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: false,
          prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
        }),
      });

      if (!resp.ok) return null;
      const data = await resp.json();

      if (!data.swapTransaction) return null;
      const txBuffer = Buffer.from(data.swapTransaction, 'base64');
      return VersionedTransaction.deserialize(txBuffer);
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PRICE & LIQUIDITY HELPERS
  // ═══════════════════════════════════════════════════════════════

  private async getCurrentPricePerToken(
    tokenMint: string, balance: bigint,
  ): Promise<number> {
    // Quote selling a small portion to get current price
    const quoteAmount = balance > 1000n ? balance / 100n : balance;
    if (quoteAmount <= 0n) return 0;

    const quote = await this.getJupiterQuote(
      tokenMint, SOL_MINT, quoteAmount.toString(),
    );

    if (!quote || !quote.outAmount) return 0;

    const solOut = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    return solOut / Number(quoteAmount);
  }

  private async getPoolLiquidity(poolAddress: string): Promise<number> {
    try {
      const conn = this.connectionManager.getConnection();
      const info = await conn.getAccountInfo(new PublicKey(poolAddress));
      if (!info) return 0;
      return info.lamports;
    } catch {
      return 0;
    }
  }

  // Cleanup all exit monitors on shutdown
  shutdown(): void {
    for (const [id, timer] of this.exitTimers) {
      clearInterval(timer);
    }
    this.exitTimers.clear();
    strategyLog.info('SnipeExecutor shutdown');
  }
}
