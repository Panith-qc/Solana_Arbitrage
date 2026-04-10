// POOL STATE MONITOR
// WebSocket-based real-time monitoring of DEX pool reserves via Connection.onAccountChange.
// Maintains an in-memory cache of pool states with configurable TTL and detects
// significant reserve movements (>1% change) to emit events for strategy evaluation.

import { PublicKey, AccountInfo, Context } from '@solana/web3.js';
import { dataLog } from './logger.js';
import { BotConfig, TOKEN_DECIMALS, SOL_MINT, LAMPORTS_PER_SOL } from './config.js';
import { ConnectionManager } from './connectionManager.js';
import { updatePool as updatePriceBook } from './priceBook.js';
import { getCachedWhirlpoolPool } from './whirlpoolSwapBuilder.js';
import { getCachedCpmmPool, cpmmSolPerToken } from './cpmmSwapBuilder.js';
import { getCachedDlmmPool, dlmmSolPerToken } from './dlmmSwapBuilder.js';
import { getCachedDammPool, dammSolPerToken } from './dammSwapBuilder.js';
import { getCachedPumpSwapPool, pumpSwapSolPerToken } from './pumpSwapBuilder.js';
import { resolvePool, quoteBuy, quoteSell } from './hotPathBuilder.js';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Represents the current state of a liquidity pool */
export interface PoolUpdate {
  /** On-chain address of the pool */
  poolAddress: string;
  /** Mint address of token A */
  tokenA: string;
  /** Mint address of token B */
  tokenB: string;
  /** Current reserves of token A (raw u64) */
  reserveA: bigint;
  /** Current reserves of token B (raw u64) */
  reserveB: bigint;
  /** Unix timestamp (ms) when this update was received */
  timestamp: number;
  /** Slot at which the account was observed */
  slot: number;
}

/** Cached pool state with metadata for TTL and change detection */
export interface CachedPoolState {
  update: PoolUpdate;
  /** When this entry was last refreshed */
  cachedAt: number;
  /** Previous reserve values for change detection */
  previousReserveA: bigint;
  previousReserveB: bigint;
}

/** Configuration for a monitored pool */
export interface PoolConfig {
  address: string;
  tokenA: string;
  tokenB: string;
  /** Label for logging (e.g. "SOL/USDC Raydium") */
  label: string;
  /** Token B decimals (non-SOL token). Needed for AMM V4 price calculation. */
  tokenDecimals?: number;
}

/** Callback type for pool update events */
export type PoolUpdateCallback = (update: PoolUpdate) => void;

/** Cross-pool spread event — executable spread verified with swap math */
export interface SpreadEvent {
  tokenMint: string;
  tokenSymbol: string;
  /** Mid-price spread in bps (indicative only) */
  spreadBps: number;
  buyPoolAddress: string;
  sellPoolAddress: string;
  buyPrice: number;
  sellPrice: number;
  timestamp: number;
  slot: number;
  /** Optimal trade size in lamports (maximises net profit) */
  optimalSizeLamports: bigint;
  /** Net profit at optimal size AFTER fees + tip (lamports) */
  expectedNetProfitLamports: bigint;
  /** Actual spread in bps accounting for price impact at optimal size */
  executableSpreadBps: number;
}

/** Callback type for spread detection events */
export type SpreadCallback = (event: SpreadEvent) => void;

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Default cache time-to-live in milliseconds (30 seconds) */
const DEFAULT_CACHE_TTL_MS = 30_000;

/** Minimum reserve change ratio to emit an event (0.05% = 5 bps).
 *  At 5-10bps arb spreads, even tiny reserve shifts can create/destroy opportunities.
 *  Previous 1% threshold was missing most opportunities. */
const SIGNIFICANT_CHANGE_THRESHOLD = 0.0005;

/** Maximum number of pools that can be monitored simultaneously */
const MAX_MONITORED_POOLS = 200;

// ═══════════════════════════════════════════════════════════════
// Raydium AMM V4 pool layout (AmmInfo struct, 752 bytes)
// IMPORTANT: Reserves are NOT stored in the AMM account directly.
// The AMM account stores vault pubkeys — actual reserves are in
// the SPL Token vault accounts pointed to by baseVault/quoteVault.
// ═══════════════════════════════════════════════════════════════

const RAYDIUM_AMM_V4_LAYOUT = {
  /** baseMint (token A / coin) — 32-byte pubkey */
  BASE_MINT_OFFSET: 400,
  /** quoteMint (token B / pc) — 32-byte pubkey */
  QUOTE_MINT_OFFSET: 432,
  /** baseVault — SPL Token account holding base token reserves */
  BASE_VAULT_OFFSET: 336,
  /** quoteVault — SPL Token account holding quote token reserves */
  QUOTE_VAULT_OFFSET: 368,
  /** baseNeedTakePnl — subtract from vault amount for effective reserve */
  BASE_NEED_TAKE_PNL_OFFSET: 192,
  /** quoteNeedTakePnl — subtract from vault amount for effective reserve */
  QUOTE_NEED_TAKE_PNL_OFFSET: 200,
  /** Minimum account data length for valid AMM V4 account */
  MIN_DATA_LENGTH: 752,
} as const;

// ═══════════════════════════════════════════════════════════════
// Raydium CLMM pool layout (PoolState struct, Anchor program)
// Price can be derived from sqrtPriceX64 without vault subscriptions.
// ═══════════════════════════════════════════════════════════════

const RAYDIUM_CLMM_LAYOUT = {
  /** tokenMint0 (token A) — 32-byte pubkey */
  TOKEN_MINT_0_OFFSET: 73,
  /** tokenMint1 (token B) — 32-byte pubkey */
  TOKEN_MINT_1_OFFSET: 105,
  /** sqrtPriceX64 — u128 LE, Q64.64 fixed-point sqrt(price) */
  SQRT_PRICE_X64_OFFSET: 253,
  /** tickCurrent — i32 LE */
  TICK_CURRENT_OFFSET: 269,
  /** mintDecimals0 — u8 */
  MINT_DECIMALS_0_OFFSET: 233,
  /** mintDecimals1 — u8 */
  MINT_DECIMALS_1_OFFSET: 234,
  /** Minimum account data length (includes Anchor discriminator) */
  MIN_DATA_LENGTH: 400,
} as const;

// ═══════════════════════════════════════════════════════════════
// Orca Whirlpool layout (Phase B)
// Whirlpool stores sqrtPrice (Q64.64) and tokenMintA/B but NOT decimals.
// We read decimals from the cached Whirlpool entry populated at startup
// by whirlpoolSwapBuilder.cacheWhirlpoolPoolData().
// Mint A/B are sorted lexicographically, so SOL may be on either side.
// ═══════════════════════════════════════════════════════════════
const WHIRLPOOL_LAYOUT = {
  /** sqrtPrice — u128 LE, Q64.64 */
  SQRT_PRICE_OFFSET: 65,
  /** tickCurrentIndex — i32 LE */
  TICK_CURRENT_INDEX_OFFSET: 81,
  /** tokenMintA — 32-byte pubkey */
  TOKEN_MINT_A_OFFSET: 101,
  /** tokenMintB — 32-byte pubkey */
  TOKEN_MINT_B_OFFSET: 181,
  /** Minimum account data length (incl. discriminator + reward infos) */
  MIN_DATA_LENGTH: 261,
} as const;

// SPL Token account layout — amount field is at offset 64
const SPL_TOKEN_AMOUNT_OFFSET = 64;

// Legacy alias for backward compatibility with parsePoolData
const RAYDIUM_POOL_LAYOUT = {
  TOKEN_A_MINT_OFFSET: RAYDIUM_AMM_V4_LAYOUT.BASE_MINT_OFFSET,
  TOKEN_B_MINT_OFFSET: RAYDIUM_AMM_V4_LAYOUT.QUOTE_MINT_OFFSET,
  RESERVE_A_OFFSET: RAYDIUM_AMM_V4_LAYOUT.BASE_NEED_TAKE_PNL_OFFSET, // fallback — not actual reserves
  RESERVE_B_OFFSET: RAYDIUM_AMM_V4_LAYOUT.QUOTE_NEED_TAKE_PNL_OFFSET,
  MIN_DATA_LENGTH: RAYDIUM_AMM_V4_LAYOUT.MIN_DATA_LENGTH,
} as const;

// ═══════════════════════════════════════════════════════════════
// PoolMonitor
// ═══════════════════════════════════════════════════════════════

export class PoolMonitor {
  private connectionManager: ConnectionManager;
  private config: BotConfig;

  /** Active WebSocket subscription IDs mapped by pool address */
  private subscriptions: Map<string, number> = new Map();

  /** Cached pool states keyed by pool address */
  private poolCache: Map<string, CachedPoolState> = new Map();

  /** Pool configurations keyed by pool address */
  private poolConfigs: Map<string, PoolConfig> = new Map();

  /** Registered update callbacks */
  private updateCallbacks: Map<string, PoolUpdateCallback> = new Map();
  private callbackCounter = 0;

  /** Raw pool-account callbacks fired BEFORE parsing — used by hot-path
   *  swap builders (e.g. clmmSwapBuilder) to refresh cached state from the
   *  exact same WebSocket buffer that drives spread detection. */
  private rawAccountCallbacks: Map<string, (poolAddress: string, data: Buffer) => void> = new Map();

  /** Cache TTL in milliseconds */
  private cacheTtlMs: number;

  /** Whether monitoring is currently active */
  private isMonitoring = false;

  /** Timer for periodic cache cleanup */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Timer for WebSocket health check / reconnection */
  private wsHealthTimer: ReturnType<typeof setInterval> | null = null;

  /** Addresses being monitored (for reconnection) */
  private monitoredAddresses: string[] = [];

  /** Last time we received ANY account change event */
  private lastEventReceivedMs: number = 0;

  /** How long without events before we assume WS is dead */
  private readonly WS_DEAD_THRESHOLD_MS = 60_000; // 60s no events = reconnect

  /** Reconnection state */
  private reconnecting = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  // ── HTTP polling fallback (when WSS is blocked) ──────────────
  /** Timer for HTTP polling loop */
  private httpPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Whether we're in HTTP poll mode (WSS unavailable) */
  private httpPollMode = false;
  /** Poll interval in ms — 2s balances freshness vs RPC credits */
  private readonly HTTP_POLL_INTERVAL_MS = 2_000;

  // ── Vault tracking for accurate reserves ──────────────────────
  // Raydium AMM V4 stores reserves in separate SPL Token vault accounts.
  // We subscribe to vaults and map them back to pool addresses.

  /** Maps vault address → { poolAddress, side: 'base'|'quote' } */
  private vaultToPool: Map<string, { poolAddress: string; side: 'base' | 'quote' }> = new Map();

  /** Maps pool address → { baseVault, quoteVault, baseReserve, quoteReserve, basePnl, quotePnl } */
  private poolVaultState: Map<string, {
    baseVault: string;
    quoteVault: string;
    baseMint: string;
    quoteMint: string;
    baseReserve: bigint;
    quoteReserve: bigint;
    basePnl: bigint;
    quotePnl: bigint;
    poolType: 'amm-v4' | 'clmm';
  }> = new Map();

  constructor(connectionManager: ConnectionManager, config: BotConfig) {
    this.connectionManager = connectionManager;
    this.config = config;
    this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
  }

  // ─────────────────────────────────────────────
  // Vault subscription (for accurate AMM V4 reserves)
  // ─────────────────────────────────────────────

  /**
   * Read an AMM V4 pool account to extract vault pubkeys, then subscribe
   * to those vault SPL Token accounts for real-time reserve updates.
   */
  private async subscribeToVaults(
    connection: import('@solana/web3.js').Connection,
    poolAddress: string,
    poolPubkey: PublicKey,
  ): Promise<void> {
    try {
      // Fetch the AMM account data to get vault pubkeys
      const accountInfo = await connection.getAccountInfo(poolPubkey);
      if (!accountInfo?.data || accountInfo.data.length < RAYDIUM_AMM_V4_LAYOUT.MIN_DATA_LENGTH) {
        dataLog.debug({ pool: poolAddress, len: accountInfo?.data?.length }, 'AMM account too small for V4');
        return;
      }

      const data = accountInfo.data;

      // Read vault pubkeys
      const baseVault = new PublicKey(
        data.subarray(RAYDIUM_AMM_V4_LAYOUT.BASE_VAULT_OFFSET, RAYDIUM_AMM_V4_LAYOUT.BASE_VAULT_OFFSET + 32),
      );
      const quoteVault = new PublicKey(
        data.subarray(RAYDIUM_AMM_V4_LAYOUT.QUOTE_VAULT_OFFSET, RAYDIUM_AMM_V4_LAYOUT.QUOTE_VAULT_OFFSET + 32),
      );

      // Read mint pubkeys to determine SOL/token orientation
      const baseMint = new PublicKey(
        data.subarray(RAYDIUM_AMM_V4_LAYOUT.BASE_MINT_OFFSET, RAYDIUM_AMM_V4_LAYOUT.BASE_MINT_OFFSET + 32),
      );
      const quoteMint = new PublicKey(
        data.subarray(RAYDIUM_AMM_V4_LAYOUT.QUOTE_MINT_OFFSET, RAYDIUM_AMM_V4_LAYOUT.QUOTE_MINT_OFFSET + 32),
      );

      // Read PnL values to subtract from vault amounts
      const basePnl = data.readBigUInt64LE(RAYDIUM_AMM_V4_LAYOUT.BASE_NEED_TAKE_PNL_OFFSET);
      const quotePnl = data.readBigUInt64LE(RAYDIUM_AMM_V4_LAYOUT.QUOTE_NEED_TAKE_PNL_OFFSET);

      const baseVaultStr = baseVault.toString();
      const quoteVaultStr = quoteVault.toString();

      // Initialize vault state
      this.poolVaultState.set(poolAddress, {
        baseVault: baseVaultStr,
        quoteVault: quoteVaultStr,
        baseMint: baseMint.toString(),
        quoteMint: quoteMint.toString(),
        baseReserve: 0n,
        quoteReserve: 0n,
        basePnl,
        quotePnl,
        poolType: 'amm-v4',
      });

      // Map vaults back to pool
      this.vaultToPool.set(baseVaultStr, { poolAddress, side: 'base' });
      this.vaultToPool.set(quoteVaultStr, { poolAddress, side: 'quote' });

      // Subscribe to base vault token account
      const baseSubId = connection.onAccountChange(
        baseVault,
        (info: AccountInfo<Buffer>, ctx: Context) => {
          this.handleVaultChange(baseVaultStr, info, ctx);
        },
        this.config.rpcCommitment,
      );
      this.subscriptions.set(baseVaultStr, baseSubId);

      // Subscribe to quote vault token account
      const quoteSubId = connection.onAccountChange(
        quoteVault,
        (info: AccountInfo<Buffer>, ctx: Context) => {
          this.handleVaultChange(quoteVaultStr, info, ctx);
        },
        this.config.rpcCommitment,
      );
      this.subscriptions.set(quoteVaultStr, quoteSubId);

      // Read initial vault balances
      const [baseAcct, quoteAcct] = await Promise.all([
        connection.getAccountInfo(baseVault),
        connection.getAccountInfo(quoteVault),
      ]);

      if (baseAcct?.data && baseAcct.data.length >= SPL_TOKEN_AMOUNT_OFFSET + 8) {
        const state = this.poolVaultState.get(poolAddress)!;
        state.baseReserve = baseAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
      }
      if (quoteAcct?.data && quoteAcct.data.length >= SPL_TOKEN_AMOUNT_OFFSET + 8) {
        const state = this.poolVaultState.get(poolAddress)!;
        state.quoteReserve = quoteAcct.data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);
      }

      const poolCfg = this.poolConfigs.get(poolAddress);
      dataLog.info(
        {
          pool: poolCfg?.label || poolAddress,
          baseVault: baseVaultStr.slice(0, 8),
          quoteVault: quoteVaultStr.slice(0, 8),
          baseReserve: this.poolVaultState.get(poolAddress)?.baseReserve.toString(),
          quoteReserve: this.poolVaultState.get(poolAddress)?.quoteReserve.toString(),
        },
        'Subscribed to vault token accounts for accurate reserves',
      );
    } catch (err) {
      dataLog.error({ err, pool: poolAddress }, 'Failed to subscribe to vaults');
    }
  }

  /**
   * Handle a vault SPL Token account change — updates reserves for the parent pool.
   */
  private handleVaultChange(
    vaultAddress: string,
    accountInfo: AccountInfo<Buffer>,
    context: Context,
  ): void {
    this.lastEventReceivedMs = Date.now();

    const mapping = this.vaultToPool.get(vaultAddress);
    if (!mapping) return;

    const { poolAddress, side } = mapping;
    const state = this.poolVaultState.get(poolAddress);
    if (!state) return;

    const data = accountInfo.data;
    if (!data || data.length < SPL_TOKEN_AMOUNT_OFFSET + 8) return;

    const newAmount = data.readBigUInt64LE(SPL_TOKEN_AMOUNT_OFFSET);

    if (side === 'base') {
      state.baseReserve = newAmount;
    } else {
      state.quoteReserve = newAmount;
    }

    // Compute effective reserves (vault amount - PnL)
    const effectiveBase = state.baseReserve > state.basePnl ? state.baseReserve - state.basePnl : 0n;
    const effectiveQuote = state.quoteReserve > state.quotePnl ? state.quoteReserve - state.quotePnl : 0n;

    // Build a PoolUpdate with raw reserves (base/quote order from AMM account).
    // These raw reserves feed directSwapBuilder via emitUpdate → updateCachedReserves.
    const poolCfg = this.poolConfigs.get(poolAddress);
    const update: PoolUpdate = {
      poolAddress,
      tokenA: poolCfg?.tokenA || '',
      tokenB: poolCfg?.tokenB || '',
      reserveA: effectiveBase,
      reserveB: effectiveQuote,
      timestamp: Date.now(),
      slot: context.slot,
    };

    // Update cache and detect significance
    const previousState = this.poolCache.get(poolAddress);
    const isSignificant = this.isSignificantChange(previousState, update);

    this.poolCache.set(poolAddress, {
      update,
      cachedAt: Date.now(),
      previousReserveA: previousState?.update.reserveA ?? 0n,
      previousReserveB: previousState?.update.reserveB ?? 0n,
    });

    if (isSignificant) {
      this.emitUpdate(update);
    }

    // Feed the price book with pseudo-reserves (solPerToken * 1e9 / 1e9)
    // so priceBook treats all pool types uniformly.
    const solPerToken = this.ammV4SolPerToken(poolAddress, effectiveBase, effectiveQuote);
    if (solPerToken > 0) {
      const SCALE = 1_000_000_000n;
      updatePriceBook(poolAddress, BigInt(Math.round(solPerToken * 1e9)), SCALE, update.slot, update.timestamp);
    }

    // Cross-pool spread detection (calculatePrice handles AMM V4 via ammV4SolPerToken)
    this.detectCrossPoolSpread(update);
  }

  // ─────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────

  /**
   * Start monitoring a set of pool addresses.
   * Subscribes to on-chain account changes via WebSocket for each address.
   */
  async startMonitoring(poolAddresses: string[]): Promise<void> {
    if (poolAddresses.length > MAX_MONITORED_POOLS) {
      dataLog.warn(
        { requested: poolAddresses.length, max: MAX_MONITORED_POOLS },
        'Pool count exceeds maximum; truncating to limit'
      );
      poolAddresses = poolAddresses.slice(0, MAX_MONITORED_POOLS);
    }

    dataLog.info(
      { poolCount: poolAddresses.length },
      'Starting pool monitoring (vault-based reserves)',
    );

    this.isMonitoring = true;

    const connection = this.connectionManager.getConnection();

    for (const address of poolAddresses) {
      if (this.subscriptions.has(address)) {
        dataLog.debug({ pool: address }, 'Pool already monitored, skipping');
        continue;
      }

      try {
        const pubkey = new PublicKey(address);
        const poolConfig = this.poolConfigs.get(address);

        // Determine pool type from config label
        const labelLower = poolConfig?.label?.toLowerCase() ?? '';
        const isAmmV4 = labelLower.includes('amm') &&
          !labelLower.includes('clmm') &&
          !labelLower.includes('damm') &&
          !labelLower.includes('cpmm');

        // Subscribe to the pool account itself (for CLMM sqrtPriceX64 or AMM PnL fields)
        const subId = connection.onAccountChange(
          pubkey,
          (accountInfo: AccountInfo<Buffer>, context: Context) => {
            this.handleAccountChange(address, accountInfo, context);
          },
          this.config.rpcCommitment,
        );
        this.subscriptions.set(address, subId);

        // Only AMM V4 pools store reserves in separate SPL Token vault accounts.
        // CLMM/Whirlpool use sqrtPriceX64; CPMM/DLMM/DAMM/PumpSwap use cached
        // swap-builder state refreshed via raw-account callbacks.
        if (isAmmV4) {
          await this.subscribeToVaults(connection, address, pubkey);
        }

        dataLog.debug(
          { pool: address, subId, isAmmV4, label: poolConfig?.label },
          'Subscribed to pool account changes',
        );
      } catch (err) {
        dataLog.error(
          { err, pool: address },
          'Failed to subscribe to pool account changes',
        );
      }
    }

    // Start periodic cache cleanup
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.evictStaleEntries(), this.cacheTtlMs);
    }

    // Save addresses for reconnection
    this.monitoredAddresses = [...new Set([...this.monitoredAddresses, ...poolAddresses])];
    this.lastEventReceivedMs = Date.now();
    this.reconnectAttempts = 0;

    // Start WebSocket health check timer (detects dead connections)
    if (!this.wsHealthTimer) {
      this.wsHealthTimer = setInterval(() => this.checkWsHealth(), 15_000);
    }

    dataLog.info(
      { activeSubscriptions: this.subscriptions.size },
      'Pool monitoring started — WebSocket health check active'
    );
  }

  /**
   * Stop all pool monitoring subscriptions and clean up resources.
   */
  async stopMonitoring(): Promise<void> {
    dataLog.info(
      { activeSubscriptions: this.subscriptions.size },
      'Stopping pool monitoring'
    );

    const connection = this.connectionManager.getConnection();

    for (const [address, subId] of this.subscriptions) {
      try {
        await connection.removeAccountChangeListener(subId);
        dataLog.debug({ pool: address, subId }, 'Unsubscribed from pool');
      } catch (err) {
        dataLog.error({ err, pool: address }, 'Failed to unsubscribe from pool');
      }
    }

    this.subscriptions.clear();
    this.isMonitoring = false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.wsHealthTimer) {
      clearInterval(this.wsHealthTimer);
      this.wsHealthTimer = null;
    }

    dataLog.info('Pool monitoring stopped');
  }

  // ─────────────────────────────────────────────
  // WebSocket health check & auto-reconnection
  // ─────────────────────────────────────────────

  /**
   * Periodic check: if no account change events received within threshold,
   * assume WebSocket is dead and reconnect all subscriptions.
   */
  private async checkWsHealth(): Promise<void> {
    if (!this.isMonitoring || this.reconnecting) return;
    if (this.monitoredAddresses.length === 0) return;

    const silenceMs = Date.now() - this.lastEventReceivedMs;

    if (silenceMs < this.WS_DEAD_THRESHOLD_MS) return;

    // WebSocket appears dead
    dataLog.warn(
      { silenceMs, subscriptions: this.subscriptions.size, attempt: this.reconnectAttempts + 1 },
      'WebSocket appears dead — no events received, reconnecting...',
    );

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      dataLog.error(
        { attempts: this.reconnectAttempts },
        'WebSocket reconnection failed after max attempts — falling back to poll-only mode',
      );
      return;
    }

    await this.reconnectSubscriptions();
  }

  /**
   * Tear down all existing subscriptions and re-subscribe.
   * This forces the Solana Connection to open a fresh WebSocket.
   */
  private async reconnectSubscriptions(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempts++;

    try {
      const connection = this.connectionManager.getConnection();

      // Unsubscribe all existing
      for (const [address, subId] of this.subscriptions) {
        try {
          await connection.removeAccountChangeListener(subId);
        } catch {
          // Ignore — connection may already be dead
        }
      }
      this.subscriptions.clear();

      // Brief pause to let old WS close
      await new Promise(r => setTimeout(r, 1000));

      // Re-subscribe all addresses
      for (const address of this.monitoredAddresses) {
        try {
          const pubkey = new PublicKey(address);
          const subId = connection.onAccountChange(
            pubkey,
            (accountInfo: AccountInfo<Buffer>, context: Context) => {
              this.handleAccountChange(address, accountInfo, context);
            },
            this.connectionManager.getConnection() ? 'confirmed' : 'confirmed',
          );
          this.subscriptions.set(address, subId);
        } catch (err) {
          dataLog.error({ err, pool: address }, 'Failed to re-subscribe pool');
        }
      }

      this.lastEventReceivedMs = Date.now(); // Reset timer
      dataLog.info(
        { resubscribed: this.subscriptions.size, attempt: this.reconnectAttempts },
        'WebSocket reconnected — pool subscriptions restored',
      );
    } catch (err) {
      dataLog.error({ err, attempt: this.reconnectAttempts }, 'WebSocket reconnection failed');
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Check if WebSocket monitoring is alive and receiving events.
   */
  isWsAlive(): boolean {
    if (!this.isMonitoring || this.subscriptions.size === 0) return false;
    return (Date.now() - this.lastEventReceivedMs) < this.WS_DEAD_THRESHOLD_MS;
  }

  /**
   * Dynamically add a pool to be monitored while the monitor is running.
   */
  async addPool(poolConfig: PoolConfig): Promise<void> {
    this.poolConfigs.set(poolConfig.address, poolConfig);

    if (this.isMonitoring && !this.subscriptions.has(poolConfig.address)) {
      await this.startMonitoring([poolConfig.address]);
    }

    dataLog.info(
      { pool: poolConfig.address, label: poolConfig.label },
      'Pool added to monitor'
    );
  }

  /**
   * Remove a pool from monitoring.
   */
  async removePool(poolAddress: string): Promise<void> {
    const subId = this.subscriptions.get(poolAddress);
    if (subId !== undefined) {
      try {
        const connection = this.connectionManager.getConnection();
        await connection.removeAccountChangeListener(subId);
      } catch (err) {
        dataLog.error({ err, pool: poolAddress }, 'Failed to unsubscribe during pool removal');
      }
      this.subscriptions.delete(poolAddress);
    }

    this.poolCache.delete(poolAddress);
    this.poolConfigs.delete(poolAddress);

    dataLog.info({ pool: poolAddress }, 'Pool removed from monitor');
  }

  // ─────────────────────────────────────────────
  // Event registration
  // ─────────────────────────────────────────────

  /**
   * Register a callback for pool state updates.
   * The callback fires on every significant reserve change.
   * Returns a subscription ID that can be used to unsubscribe.
   */
  onPoolUpdate(callback: PoolUpdateCallback): string {
    this.callbackCounter++;
    const callbackId = `pool-cb-${this.callbackCounter}-${Date.now()}`;
    this.updateCallbacks.set(callbackId, callback);

    dataLog.debug({ callbackId }, 'Pool update callback registered');

    return callbackId;
  }

  /**
   * Remove a previously registered pool update callback.
   */
  removePoolUpdateCallback(callbackId: string): void {
    this.updateCallbacks.delete(callbackId);
    dataLog.debug({ callbackId }, 'Pool update callback removed');
  }

  /**
   * Register a callback that fires with the raw account buffer on every
   * pool account change (NOT throttled, NOT parsed). Used by direct swap
   * builders to keep their own caches in sync with WebSocket data.
   */
  onRawPoolAccount(callback: (poolAddress: string, data: Buffer) => void): string {
    this.callbackCounter++;
    const id = `raw-cb-${this.callbackCounter}-${Date.now()}`;
    this.rawAccountCallbacks.set(id, callback);
    return id;
  }

  // ─────────────────────────────────────────────
  // State queries
  // ─────────────────────────────────────────────

  /**
   * Get the cached pool state for a given address.
   * Returns null if the pool is not cached or the cache entry has expired.
   */
  getPoolState(poolAddress: string): PoolUpdate | null {
    const cached = this.poolCache.get(poolAddress);
    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.cachedAt > this.cacheTtlMs) {
      this.poolCache.delete(poolAddress);
      return null;
    }

    return cached.update;
  }

  /**
   * Get all currently cached pool states (only non-expired entries).
   */
  getAllPoolStates(): Map<string, PoolUpdate> {
    const result = new Map<string, PoolUpdate>();
    const now = Date.now();

    for (const [address, cached] of this.poolCache) {
      if (now - cached.cachedAt <= this.cacheTtlMs) {
        result.set(address, cached.update);
      }
    }

    return result;
  }

  /**
   * Get monitoring statistics for observability.
   */
  getStats(): {
    monitoredPools: number;
    cachedPools: number;
    isMonitoring: boolean;
    registeredCallbacks: number;
  } {
    return {
      monitoredPools: this.subscriptions.size,
      cachedPools: this.poolCache.size,
      isMonitoring: this.isMonitoring,
      registeredCallbacks: this.updateCallbacks.size,
    };
  }

  /**
   * Set the cache TTL in milliseconds.
   */
  setCacheTtl(ttlMs: number): void {
    if (ttlMs < 1000) {
      dataLog.warn({ ttlMs }, 'Cache TTL below 1s is not recommended');
    }
    this.cacheTtlMs = ttlMs;
    dataLog.info({ ttlMs }, 'Cache TTL updated');
  }

  // ─────────────────────────────────────────────
  // Account change handling
  // ─────────────────────────────────────────────

  private handleAccountChange(
    poolAddress: string,
    accountInfo: AccountInfo<Buffer>,
    context: Context
  ): void {
    // Track that WS is alive
    this.lastEventReceivedMs = Date.now();
    this.reconnectAttempts = 0;

    // DEBUG: trace pipeline — remove after verifying hot path works
    const poolCfg = this.poolConfigs.get(poolAddress);
    dataLog.info(
      { pool: poolCfg?.label || poolAddress.slice(0, 8), slot: context.slot, dataLen: accountInfo?.data?.length ?? 0 },
      `WS CALLBACK: ${poolCfg?.label || poolAddress.slice(0, 8)}`,
    );

    // Fire raw-account callbacks BEFORE parsing so hot-path builders can
    // refresh their own state from the same buffer (e.g. CLMM sqrtPriceX64).
    if (this.rawAccountCallbacks.size > 0 && accountInfo?.data) {
      for (const cb of this.rawAccountCallbacks.values()) {
        try {
          cb(poolAddress, accountInfo.data);
        } catch (err) {
          dataLog.error({ err, pool: poolAddress }, 'Raw account callback error');
        }
      }
    }

    try {
      const update = this.parsePoolData(poolAddress, accountInfo, context);
      if (!update) return;

      const previousState = this.poolCache.get(poolAddress);
      const isSignificant = this.isSignificantChange(previousState, update);

      // Update cache
      this.poolCache.set(poolAddress, {
        update,
        cachedAt: Date.now(),
        previousReserveA: previousState?.update.reserveA ?? 0n,
        previousReserveB: previousState?.update.reserveB ?? 0n,
      });

      // Only emit events for significant changes to avoid callback flooding
      if (isSignificant) {
        this.emitUpdate(update);
      }

      // Feed the price book on every account change (Phase 3).
      // For AMM V4 pools (raw reserves), convert to pseudo-reserves so
      // priceBook treats all pool types uniformly.
      const vaultState = this.poolVaultState.get(update.poolAddress);
      if (vaultState && vaultState.poolType === 'amm-v4') {
        const solPerToken = this.ammV4SolPerToken(update.poolAddress, update.reserveA, update.reserveB);
        if (solPerToken > 0) {
          const SCALE = 1_000_000_000n;
          updatePriceBook(update.poolAddress, BigInt(Math.round(solPerToken * 1e9)), SCALE, update.slot, update.timestamp);
        }
      } else {
        // Non-AMM-V4: already pseudo-reserves from parsers
        updatePriceBook(update.poolAddress, update.reserveA, update.reserveB, update.slot, update.timestamp);
      }

      // Always check cross-pool spreads on ANY update (even small changes)
      // because a 0.01% change in one pool can create a 5bps+ spread vs another pool
      this.detectCrossPoolSpread(update);
    } catch (err) {
      dataLog.error(
        { err, pool: poolAddress },
        'Error processing pool account change'
      );
    }
  }

  private parsePoolData(
    poolAddress: string,
    accountInfo: AccountInfo<Buffer>,
    context: Context,
  ): PoolUpdate | null {
    const data = accountInfo.data;
    if (!data || data.length < 16) return null;

    const poolCfg = this.poolConfigs.get(poolAddress);
    const labelLower = poolCfg?.label?.toLowerCase() ?? '';
    const isClmm = labelLower.includes('clmm');
    const isWhirlpool = labelLower.includes('whirlpool');
    const isCpmm = labelLower.includes('cpmm');
    const isDlmm = labelLower.includes('dlmm');
    const isDamm = labelLower.includes('damm');
    const isPumpSwap = labelLower.includes('pumpswap');

    try {
      // ── PumpSwap pools: derive price from cached vault balances.
      // Checked first so the "pumpswap" label keyword wins over other
      // substring matches.
      if (isPumpSwap) {
        return this.parsePumpSwapPoolData(poolAddress, data, context, poolCfg);
      }

      // ── DAMM (Dynamic AMM v1) pools: derive price from cached
      // effective reserves (vault unlock-aware). Checked BEFORE DLMM
      // because both labels can contain "mm" — we match on substring.
      if (isDamm) {
        return this.parseDammPoolData(poolAddress, data, context, poolCfg);
      }

      // ── DLMM pools: derive price from active-bin formula ───────
      if (isDlmm) {
        return this.parseDlmmPoolData(poolAddress, data, context, poolCfg);
      }

      // ── CPMM pools: derive price from cached vault balances ────
      if (isCpmm) {
        return this.parseCpmmPoolData(poolAddress, data, context, poolCfg);
      }

      // ── Whirlpool pools: derive price from sqrtPrice ───────────
      if (isWhirlpool && data.length >= WHIRLPOOL_LAYOUT.MIN_DATA_LENGTH) {
        return this.parseWhirlpoolPoolData(poolAddress, data, context, poolCfg);
      }

      // ── CLMM pools: derive price from sqrtPriceX64 ─────────────
      if (isClmm && data.length >= RAYDIUM_CLMM_LAYOUT.MIN_DATA_LENGTH) {
        return this.parseClmmPoolData(poolAddress, data, context, poolCfg);
      }

      // ── AMM V4 pools: PnL fields updated on AMM account change ─
      // The actual reserves come from vault subscriptions (handleVaultChange).
      // When the AMM account changes, update PnL fields that affect effective reserves.
      if (data.length >= RAYDIUM_AMM_V4_LAYOUT.MIN_DATA_LENGTH) {
        const state = this.poolVaultState.get(poolAddress);
        if (state) {
          state.basePnl = data.readBigUInt64LE(RAYDIUM_AMM_V4_LAYOUT.BASE_NEED_TAKE_PNL_OFFSET);
          state.quotePnl = data.readBigUInt64LE(RAYDIUM_AMM_V4_LAYOUT.QUOTE_NEED_TAKE_PNL_OFFSET);

          // Recompute effective reserves
          const effectiveBase = state.baseReserve > state.basePnl ? state.baseReserve - state.basePnl : 0n;
          const effectiveQuote = state.quoteReserve > state.quotePnl ? state.quoteReserve - state.quotePnl : 0n;

          // Raw order: base=token, quote=SOL. calculatePrice() handles inversion.
          return {
            poolAddress,
            tokenA: poolCfg?.tokenA || '',
            tokenB: poolCfg?.tokenB || '',
            reserveA: effectiveBase,    // Token (base)
            reserveB: effectiveQuote,   // SOL (quote)
            timestamp: Date.now(),
            slot: context.slot,
          };
        }
      }

      // Fallback to generic parse
      return this.parseGenericPoolData(poolAddress, data, context);
    } catch (err) {
      dataLog.error(
        { err, pool: poolAddress, dataLen: data.length },
        'Failed to parse pool data',
      );
      return null;
    }
  }

  /**
   * Parse a Raydium CLMM pool — price derived from sqrtPriceX64.
   * sqrtPriceX64 is a Q64.64 fixed-point sqrt(price), where:
   *   price = (sqrtPriceX64 / 2^64)^2 = mint0_atomic / mint1_atomic
   * Decimal-adjusted: adjPrice = rawPrice * 10^(dec0-dec1) = mint1_human / mint0_human
   *
   * In our pool configs, tokenA=SOL (quote), tokenB=token (base).
   * In CLMM, mint0=SOL, mint1=token for all our pools.
   * So adjPrice = token_per_SOL. We want SOL_per_token = 1/adjPrice.
   *
   * We store as pseudo-reserves: reserveA = SOL_per_token * 1e9, reserveB = 1e9
   * so calculatePrice(reserveA, reserveB) = SOL_per_token.
   */
  private parseClmmPoolData(
    poolAddress: string,
    data: Buffer,
    context: Context,
    poolCfg: PoolConfig | undefined,
  ): PoolUpdate | null {
    // Read sqrtPriceX64 as u128 LE (16 bytes)
    const lo = data.readBigUInt64LE(RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64_OFFSET);
    const hi = data.readBigUInt64LE(RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64_OFFSET + 8);
    const sqrtPriceX64 = (hi << 64n) | lo;

    if (sqrtPriceX64 === 0n) return null;

    // rawPrice = (sqrtPriceX64 / 2^64)^2 = mint0_atomic per mint1_atomic
    const dec0 = data[RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_0_OFFSET];
    const dec1 = data[RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_1_OFFSET];
    const sqrtPrice = Number(sqrtPriceX64) / 2 ** 64;
    const adjPrice = sqrtPrice * sqrtPrice * (10 ** (dec0 - dec1));
    // adjPrice = how many mint1_human per mint0_human.
    // Token order varies per pool:
    //   mint0=SOL, mint1=token → adjPrice = token_per_SOL → invert to get SOL_per_token
    //   mint0=token, mint1=SOL → adjPrice = SOL_per_token → use directly
    const mint0 = new PublicKey(
      data.subarray(RAYDIUM_CLMM_LAYOUT.TOKEN_MINT_0_OFFSET, RAYDIUM_CLMM_LAYOUT.TOKEN_MINT_0_OFFSET + 32),
    );
    const mint0IsSol = mint0.toString() === SOL_MINT;
    const solPerToken = mint0IsSol
      ? (adjPrice > 0 ? 1 / adjPrice : 0)
      : adjPrice;

    // Store as pseudo-reserves: reserveA/reserveB = SOL_per_token
    const SCALE = 1_000_000_000n; // 1e9
    const scaledPrice = BigInt(Math.round(solPerToken * 1e9));

    return {
      poolAddress,
      tokenA: poolCfg?.tokenA || '',
      tokenB: poolCfg?.tokenB || '',
      reserveA: scaledPrice,    // SOL_per_token × 1e9
      reserveB: SCALE,          // 1e9 (denominator)
      timestamp: Date.now(),
      slot: context.slot,
    };
  }

  /**
   * Parse an Orca Whirlpool — price derived from sqrtPrice (Q64.64).
   * Whirlpool does NOT store mint decimals in the pool, so we read them
   * from the cached Whirlpool entry populated at startup by
   * whirlpoolSwapBuilder.cacheWhirlpoolPoolData(). If the cache is not
   * yet populated, returns null and the next account update will retry.
   *
   * Layout (post 8-byte Anchor discriminator):
   *   off  65  sqrtPrice         u128 LE Q64.64
   *   off  81  tickCurrentIndex  i32  LE
   *   off 101  tokenMintA        Pubkey (32)
   *   off 181  tokenMintB        Pubkey (32)
   *
   * Mint A/B are sorted lexicographically by Whirlpool, so SOL may be A
   * or B. Price math:
   *   ratio    = sqrtPrice / 2^64
   *   priceRaw = ratio^2                       // B-atomic per A-atomic
   *   priceAdj = priceRaw * 10^(decA - decB)   // human B per human A
   *   solPerToken = (A==SOL) ? 1/priceAdj : priceAdj
   *
   * Stored as pseudo-reserves: reserveA = SOL_per_token * 1e9, reserveB = 1e9
   * to match the CLMM convention so calculatePrice() returns SOL_per_token.
   */
  private parseWhirlpoolPoolData(
    poolAddress: string,
    data: Buffer,
    context: Context,
    poolCfg: PoolConfig | undefined,
  ): PoolUpdate | null {
    try {
      // Decimals must come from the swap-builder cache (Whirlpool does
      // not store them in the pool account itself). Skip until cached.
      const cached = getCachedWhirlpoolPool(poolAddress);
      if (!cached) return null;

      // sqrtPrice u128 LE
      const lo = data.readBigUInt64LE(WHIRLPOOL_LAYOUT.SQRT_PRICE_OFFSET);
      const hi = data.readBigUInt64LE(WHIRLPOOL_LAYOUT.SQRT_PRICE_OFFSET + 8);
      const sqrtPrice = (hi << 64n) | lo;
      if (sqrtPrice === 0n) return null;

      const mintA = new PublicKey(
        data.subarray(WHIRLPOOL_LAYOUT.TOKEN_MINT_A_OFFSET, WHIRLPOOL_LAYOUT.TOKEN_MINT_A_OFFSET + 32),
      );
      const aIsSol = mintA.toString() === SOL_MINT;

      const ratio = Number(sqrtPrice) / 2 ** 64;
      const priceRaw = ratio * ratio; // B per A, raw atomic
      const decAdj = Math.pow(10, cached.decimalsA - cached.decimalsB);
      const bPerA = priceRaw * decAdj; // human B per human A
      const solPerToken = aIsSol
        ? (bPerA > 0 ? 1 / bPerA : 0)
        : bPerA;

      const SCALE = 1_000_000_000n; // 1e9
      const scaledPrice = BigInt(Math.round(solPerToken * 1e9));

      return {
        poolAddress,
        tokenA: poolCfg?.tokenA || '',
        tokenB: poolCfg?.tokenB || '',
        reserveA: scaledPrice,
        reserveB: SCALE,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch (err) {
      dataLog.error(
        { err, pool: poolAddress },
        'Failed to parse Whirlpool data',
      );
      return null;
    }
  }

  /**
   * Parse a Raydium CPMM pool. Unlike CLMM/Whirlpool, CPMM doesn't store
   * a price field — reserves come from vault SPL Token accounts. This
   * parser doesn't decode the data buffer at all; instead it pulls the
   * already-cached effective reserves from cpmmSwapBuilder (which is kept
   * in sync via the bot engine's pool-account and vault WS hooks).
   *
   * Stored as pseudo-reserves matching the CLMM/Whirlpool convention so
   * priceBook.calculateDecimalPrice() can treat all three uniformly.
   */
  private parseCpmmPoolData(
    poolAddress: string,
    _data: Buffer,
    context: Context,
    poolCfg: PoolConfig | undefined,
  ): PoolUpdate | null {
    try {
      const cached = getCachedCpmmPool(poolAddress);
      if (!cached) return null;
      const solPerToken = cpmmSolPerToken(cached);
      if (solPerToken <= 0) return null;
      const SCALE = 1_000_000_000n;
      const scaledPrice = BigInt(Math.round(solPerToken * 1e9));
      return {
        poolAddress,
        tokenA: poolCfg?.tokenA || '',
        tokenB: poolCfg?.tokenB || '',
        reserveA: scaledPrice,
        reserveB: SCALE,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch (err) {
      dataLog.error({ err, pool: poolAddress }, 'Failed to parse CPMM data');
      return null;
    }
  }

  /**
   * Parse a Meteora DAMM (Dynamic AMM v1) pool. Like CPMM/DLMM we don't
   * decode the buffer here — dammSwapBuilder keeps the cached pool +
   * vaults fresh via botEngine's WS hooks. We just read SOL/token from
   * effective reserves (vault unlock-aware).
   */
  private parseDammPoolData(
    poolAddress: string,
    _data: Buffer,
    context: Context,
    poolCfg: PoolConfig | undefined,
  ): PoolUpdate | null {
    try {
      const cached = getCachedDammPool(poolAddress);
      if (!cached) return null;
      const solPerToken = dammSolPerToken(cached);
      if (solPerToken <= 0) return null;
      const SCALE = 1_000_000_000n;
      const scaledPrice = BigInt(Math.round(solPerToken * 1e9));
      return {
        poolAddress,
        tokenA: poolCfg?.tokenA || '',
        tokenB: poolCfg?.tokenB || '',
        reserveA: scaledPrice,
        reserveB: SCALE,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch (err) {
      dataLog.error({ err, pool: poolAddress }, 'Failed to parse DAMM data');
      return null;
    }
  }

  /**
   * Parse a PumpSwap AMM pool. Like CPMM/DLMM/DAMM, reserves live in the
   * cached pool state maintained by pumpSwapBuilder (refreshed via the
   * engine's vault WS hooks). We just compute SOL_per_token from the
   * cached vault balances and return the pseudo-reserve envelope.
   */
  private parsePumpSwapPoolData(
    poolAddress: string,
    _data: Buffer,
    context: Context,
    poolCfg: PoolConfig | undefined,
  ): PoolUpdate | null {
    try {
      const cached = getCachedPumpSwapPool(poolAddress);
      if (!cached) return null;
      const solPerToken = pumpSwapSolPerToken(cached);
      if (solPerToken <= 0) return null;
      const SCALE = 1_000_000_000n;
      const scaledPrice = BigInt(Math.round(solPerToken * 1e9));
      return {
        poolAddress,
        tokenA: poolCfg?.tokenA || '',
        tokenB: poolCfg?.tokenB || '',
        reserveA: scaledPrice,
        reserveB: SCALE,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch (err) {
      dataLog.error({ err, pool: poolAddress }, 'Failed to parse PumpSwap data');
      return null;
    }
  }

  /**
   * Parse a Meteora DLMM pool. Like CPMM, we don't decode the buffer here —
   * dlmmSwapBuilder keeps the cached LbPair fresh via botEngine's pool-account
   * and vault WS hooks. We just read the active-bin price from the cache.
   */
  private parseDlmmPoolData(
    poolAddress: string,
    _data: Buffer,
    context: Context,
    poolCfg: PoolConfig | undefined,
  ): PoolUpdate | null {
    try {
      const cached = getCachedDlmmPool(poolAddress);
      if (!cached) return null;
      const solPerToken = dlmmSolPerToken(cached);
      if (solPerToken <= 0) return null;
      const SCALE = 1_000_000_000n;
      const scaledPrice = BigInt(Math.round(solPerToken * 1e9));
      return {
        poolAddress,
        tokenA: poolCfg?.tokenA || '',
        tokenB: poolCfg?.tokenB || '',
        reserveA: scaledPrice,
        reserveB: SCALE,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch (err) {
      dataLog.error({ err, pool: poolAddress }, 'Failed to parse DLMM data');
      return null;
    }
  }

  private parseGenericPoolData(
    poolAddress: string,
    data: Buffer,
    context: Context
  ): PoolUpdate | null {
    // For pools with unknown layouts, use the PoolConfig if registered
    const poolCfg = this.poolConfigs.get(poolAddress);
    if (!poolCfg) {
      dataLog.debug(
        { pool: poolAddress, dataLen: data?.length ?? 0 },
        'Unknown pool layout and no config registered; skipping'
      );
      return null;
    }

    // Try to read the first two u64 values as reserves (common pattern)
    if (!data || data.length < 16) return null;

    try {
      const reserveA = data.readBigUInt64LE(0);
      const reserveB = data.readBigUInt64LE(8);

      return {
        poolAddress,
        tokenA: poolCfg.tokenA,
        tokenB: poolCfg.tokenB,
        reserveA,
        reserveB,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // Change detection
  // ─────────────────────────────────────────────

  private isSignificantChange(
    previous: CachedPoolState | undefined,
    current: PoolUpdate
  ): boolean {
    // First observation is always significant
    if (!previous) return true;

    const prevA = previous.update.reserveA;
    const prevB = previous.update.reserveB;

    // Avoid division by zero
    if (prevA === 0n || prevB === 0n) return true;

    const changeA = this.calculateChangeRatio(prevA, current.reserveA);
    const changeB = this.calculateChangeRatio(prevB, current.reserveB);

    return changeA >= SIGNIFICANT_CHANGE_THRESHOLD || changeB >= SIGNIFICANT_CHANGE_THRESHOLD;
  }

  private calculateChangeRatio(previous: bigint, current: bigint): number {
    if (previous === 0n) return current === 0n ? 0 : 1;

    // Convert to Number for ratio calculation (sufficient precision for % change)
    const prev = Number(previous);
    const curr = Number(current);

    return Math.abs(curr - prev) / prev;
  }

  // ─────────────────────────────────────────────
  // Event emission
  // ─────────────────────────────────────────────

  private emitUpdate(update: PoolUpdate): void {
    const label = this.poolConfigs.get(update.poolAddress)?.label ?? update.poolAddress;

    dataLog.debug(
      {
        pool: label,
        reserveA: update.reserveA.toString(),
        reserveB: update.reserveB.toString(),
        slot: update.slot,
      },
      'Significant pool reserve change detected'
    );

    for (const [callbackId, callback] of this.updateCallbacks) {
      try {
        callback(update);
      } catch (err) {
        dataLog.error(
          { err, callbackId },
          'Pool update callback threw an error'
        );
      }
    }
  }

  // ─────────────────────────────────────────────
  // Cross-pool spread detection (in-memory, no RPC)
  // ─────────────────────────────────────────────

  /** Callback for when a cross-pool spread exceeds threshold */
  private spreadCallbacks: Map<string, SpreadCallback> = new Map();
  private spreadCallbackCounter = 0;

  /** Register a callback for cross-pool spread opportunities */
  onSpreadDetected(callback: SpreadCallback): string {
    const id = `spread-${++this.spreadCallbackCounter}`;
    this.spreadCallbacks.set(id, callback);
    return id;
  }

  /** Unregister a spread callback */
  offSpreadDetected(id: string): void {
    this.spreadCallbacks.delete(id);
  }

  /**
   * Compute SOL-per-token for an AMM V4 pool from raw vault reserves.
   * Uses baseMint/quoteMint from vault state to determine which side is SOL,
   * and TOKEN_DECIMALS for correct decimal adjustment.
   * Same math as cpmmSolPerToken / pumpSwapSolPerToken:
   *   price = (solReserve / 10^9) / (tokenReserve / 10^tokenDecimals)
   */
  private ammV4SolPerToken(poolAddress: string, baseReserve: bigint, quoteReserve: bigint): number {
    if (baseReserve === 0n || quoteReserve === 0n) return 0;

    const state = this.poolVaultState.get(poolAddress);
    if (!state) return 0;

    const baseIsSol = state.baseMint === SOL_MINT;
    const quoteIsSol = state.quoteMint === SOL_MINT;
    if (!baseIsSol && !quoteIsSol) return 0;

    const solReserve = baseIsSol ? baseReserve : quoteReserve;
    const tokenReserve = baseIsSol ? quoteReserve : baseReserve;
    const tokenMint = baseIsSol ? state.quoteMint : state.baseMint;
    const tokenDecimals = TOKEN_DECIMALS[tokenMint] ?? 9;

    const solHuman = Number(solReserve) / 1e9;
    const tokenHuman = Number(tokenReserve) / (10 ** tokenDecimals);
    if (tokenHuman === 0) return 0;
    return solHuman / tokenHuman;
  }

  /**
   * Calculate price as SOL-per-token for cross-pool comparison.
   * - CLMM/Whirlpool/CPMM/DLMM/DAMM/PumpSwap: pseudo-reserves
   *   reserveA = solPerToken × 1e9, reserveB = 1e9
   *   → price = reserveA / reserveB = solPerToken ✓
   * - AMM V4: raw vault reserves — delegates to ammV4SolPerToken()
   *   which reads baseMint/quoteMint to determine SOL side ✓
   */
  private calculatePrice(reserveA: bigint, reserveB: bigint, poolAddress?: string): number {
    if (reserveA === 0n || reserveB === 0n) return 0;
    if (!poolAddress) return 0;

    const config = this.poolConfigs.get(poolAddress);
    const labelLower = config?.label?.toLowerCase() ?? '';
    const isAmmV4 = labelLower.includes('amm') &&
      !labelLower.includes('clmm') &&
      !labelLower.includes('damm') &&
      !labelLower.includes('cpmm');

    if (!isAmmV4) {
      // Pseudo-reserves: reserveA/reserveB already = SOL per token
      return Number(reserveA) / Number(reserveB);
    }

    // AMM V4: delegate to ammV4SolPerToken which handles SOL/token orientation
    return this.ammV4SolPerToken(poolAddress, reserveA, reserveB);
  }

  // ── Executable spread detection constants ──────────────────────
  // Same fee model as hotPathBuilder.ts buildMixedHotPathTransaction:
  //   baseFee = 5_000 (signature) + 10_000 (compute)
  //   tip = clamp(grossProfit * 40%, 1_000, 200_000)
  private static readonly BASE_FEE = 15_000n;
  private static readonly TRADE_SIZES: bigint[] = [
    500_000_000n,   // 0.5  SOL
    250_000_000n,   // 0.25 SOL
    100_000_000n,   // 0.1  SOL
    50_000_000n,    // 0.05 SOL
    25_000_000n,    // 0.025 SOL
    10_000_000n,    // 0.01 SOL
  ];

  /**
   * Compute net profit for a buy→sell arbitrage at a given SOL input size.
   * Uses the SAME quote math as hotPathBuilder (quoteBuy + quoteSell).
   * Returns net profit in lamports AFTER fees and tip, or 0n if unprofitable.
   */
  private static quoteNetProfit(
    buyResolved: ReturnType<typeof resolvePool>,
    sellResolved: ReturnType<typeof resolvePool>,
    solIn: bigint,
  ): bigint {
    if (!buyResolved || !sellResolved) return 0n;
    const tokenOut = quoteBuy(buyResolved, solIn);
    if (tokenOut === 0n) return 0n;
    // 0.5% safety margin — same as hotPathBuilder
    const sellAmountIn = (tokenOut * 995n) / 1000n;
    const solBack = quoteSell(sellResolved, sellAmountIn);
    if (solBack === 0n) return 0n;
    const grossProfit = solBack - solIn;
    if (grossProfit <= 0n) return 0n;
    // Dynamic tip: clamp(40%, 1k, 200k) — mirrors hotPathBuilder
    const rawTip = (grossProfit * 40n) / 100n;
    const tip = rawTip < 1_000n ? 1_000n : rawTip > 200_000n ? 200_000n : rawTip;
    return grossProfit - PoolMonitor.BASE_FEE - tip;
  }

  /**
   * After a pool update, check if there's a PROFITABLE cross-pool arbitrage
   * for the same token. Uses the SAME swap math as the hot path builder
   * (quoteBuy + quoteSell) to verify executable profitability at multiple
   * trade sizes. Only emits when net profit > 0 after fees + tip.
   *
   * Performance: ~6 sizes × 2 quote calls = 12 in-memory calculations (<10ms).
   */
  private detectCrossPoolSpread(updatedPool: PoolUpdate): void {
    if (this.spreadCallbacks.size === 0) return;

    const updatedConfig = this.poolConfigs.get(updatedPool.poolAddress);
    if (!updatedConfig) return;

    // Mid-price for logging (indicative only — not used for profitability)
    const updatedPrice = this.calculatePrice(updatedPool.reserveA, updatedPool.reserveB, updatedPool.poolAddress);
    if (updatedPrice <= 0) return;

    for (const [address, cached] of this.poolCache) {
      if (address === updatedPool.poolAddress) continue;

      const otherConfig = this.poolConfigs.get(address);
      if (!otherConfig) continue;
      if (otherConfig.tokenB !== updatedConfig.tokenB) continue;
      if (Date.now() - cached.cachedAt > 10_000) continue;

      const otherPrice = this.calculatePrice(cached.update.reserveA, cached.update.reserveB, address);
      if (otherPrice <= 0) continue;

      // Mid-price spread (indicative — for logging only)
      const highPrice = Math.max(updatedPrice, otherPrice);
      const lowPrice = Math.min(updatedPrice, otherPrice);
      const midSpreadBps = ((highPrice - lowPrice) / lowPrice) * 10_000;

      // Quick filter: skip if mid-price spread < 1 bps (no chance of profit)
      if (midSpreadBps < 1) continue;

      // Determine direction: buy from cheaper pool, sell to expensive pool
      const buyAddr = updatedPrice < otherPrice ? updatedPool.poolAddress : address;
      const sellAddr = updatedPrice < otherPrice ? address : updatedPool.poolAddress;

      // Resolve pools for executable quoting
      const buyR = resolvePool(buyAddr);
      const sellR = resolvePool(sellAddr);
      if (!buyR || !sellR) continue;

      // Find optimal trade size: try each size, pick highest net profit
      let bestProfit = 0n;
      let bestSize = 0n;
      for (const size of PoolMonitor.TRADE_SIZES) {
        const net = PoolMonitor.quoteNetProfit(buyR, sellR, size);
        if (net > bestProfit) {
          bestProfit = net;
          bestSize = size;
        }
      }

      // Only emit REAL executable opportunities
      if (bestProfit <= 0n || bestSize === 0n) continue;

      const execSpreadBps = Number(bestProfit * 10_000n / bestSize);
      const tokenSymbol = updatedConfig.label?.split('/')[0] ?? updatedConfig.tokenB.slice(0, 8);

      dataLog.info(
        {
          token: tokenSymbol,
          midSpreadBps: midSpreadBps.toFixed(1),
          execSpreadBps: execSpreadBps.toFixed(1),
          optimalSol: (Number(bestSize) / LAMPORTS_PER_SOL).toFixed(3),
          netProfitLamports: bestProfit.toString(),
          buyPool: buyAddr.slice(0, 8),
          sellPool: sellAddr.slice(0, 8),
        },
        `EXECUTABLE SPREAD: ${tokenSymbol} mid=${midSpreadBps.toFixed(1)}bps exec=${execSpreadBps.toFixed(1)}bps size=${(Number(bestSize) / LAMPORTS_PER_SOL).toFixed(3)} profit=${bestProfit}`,
      );

      const spreadEvent: SpreadEvent = {
        tokenMint: updatedConfig.tokenB,
        tokenSymbol,
        spreadBps: midSpreadBps,
        buyPoolAddress: buyAddr,
        sellPoolAddress: sellAddr,
        buyPrice: Math.min(updatedPrice, otherPrice),
        sellPrice: Math.max(updatedPrice, otherPrice),
        timestamp: Date.now(),
        slot: updatedPool.slot,
        optimalSizeLamports: bestSize,
        expectedNetProfitLamports: bestProfit,
        executableSpreadBps: execSpreadBps,
      };

      for (const [, cb] of this.spreadCallbacks) {
        try {
          cb(spreadEvent);
        } catch (err) {
          dataLog.error({ err }, 'Spread callback error');
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // Cache maintenance
  // ─────────────────────────────────────────────

  private evictStaleEntries(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [address, cached] of this.poolCache) {
      if (now - cached.cachedAt > this.cacheTtlMs) {
        this.poolCache.delete(address);
        evicted++;
      }
    }

    if (evicted > 0) {
      dataLog.debug({ evicted, remaining: this.poolCache.size }, 'Evicted stale pool cache entries');
    }
  }
}
