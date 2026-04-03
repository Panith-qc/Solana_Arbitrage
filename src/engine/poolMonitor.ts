// POOL STATE MONITOR
// WebSocket-based real-time monitoring of DEX pool reserves via Connection.onAccountChange.
// Maintains an in-memory cache of pool states with configurable TTL and detects
// significant reserve movements (>1% change) to emit events for strategy evaluation.

import { PublicKey, AccountInfo, Context } from '@solana/web3.js';
import { dataLog } from './logger.js';
import { BotConfig } from './config.js';
import { ConnectionManager } from './connectionManager.js';

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
}

/** Callback type for pool update events */
export type PoolUpdateCallback = (update: PoolUpdate) => void;

/** Cross-pool spread event — detected entirely in memory, no RPC calls */
export interface SpreadEvent {
  tokenMint: string;
  spreadBps: number;
  buyPoolAddress: string;
  sellPoolAddress: string;
  buyPrice: number;
  sellPrice: number;
  timestamp: number;
  slot: number;
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
// Raydium AMM pool layout offsets (V4 liquidity pool state)
// These byte offsets locate the reserve fields within the account data.
// ═══════════════════════════════════════════════════════════════

const RAYDIUM_POOL_LAYOUT = {
  /** Offset to token A (coin) mint pubkey */
  TOKEN_A_MINT_OFFSET: 400,
  /** Offset to token B (pc) mint pubkey */
  TOKEN_B_MINT_OFFSET: 432,
  /** Offset to token A reserve (u64, little-endian) */
  RESERVE_A_OFFSET: 208,
  /** Offset to token B reserve (u64, little-endian) */
  RESERVE_B_OFFSET: 216,
  /** Minimum expected account data length for a valid Raydium pool */
  MIN_DATA_LENGTH: 680,
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

  constructor(connectionManager: ConnectionManager, config: BotConfig) {
    this.connectionManager = connectionManager;
    this.config = config;
    this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
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
      'Starting pool monitoring'
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

        const subId = connection.onAccountChange(
          pubkey,
          (accountInfo: AccountInfo<Buffer>, context: Context) => {
            this.handleAccountChange(address, accountInfo, context);
          },
          this.config.rpcCommitment
        );

        this.subscriptions.set(address, subId);

        dataLog.debug(
          { pool: address, subId },
          'Subscribed to pool account changes'
        );
      } catch (err) {
        dataLog.error(
          { err, pool: address },
          'Failed to subscribe to pool account changes'
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
    context: Context
  ): PoolUpdate | null {
    const data = accountInfo.data;

    if (!data || data.length < RAYDIUM_POOL_LAYOUT.MIN_DATA_LENGTH) {
      // Attempt a generic parse for smaller accounts (e.g. Orca pools)
      return this.parseGenericPoolData(poolAddress, data, context);
    }

    try {
      // Read reserves as little-endian u64
      const reserveA = data.readBigUInt64LE(RAYDIUM_POOL_LAYOUT.RESERVE_A_OFFSET);
      const reserveB = data.readBigUInt64LE(RAYDIUM_POOL_LAYOUT.RESERVE_B_OFFSET);

      // Read token mint pubkeys (32 bytes each)
      const tokenA = new PublicKey(
        data.subarray(
          RAYDIUM_POOL_LAYOUT.TOKEN_A_MINT_OFFSET,
          RAYDIUM_POOL_LAYOUT.TOKEN_A_MINT_OFFSET + 32
        )
      ).toString();

      const tokenB = new PublicKey(
        data.subarray(
          RAYDIUM_POOL_LAYOUT.TOKEN_B_MINT_OFFSET,
          RAYDIUM_POOL_LAYOUT.TOKEN_B_MINT_OFFSET + 32
        )
      ).toString();

      // Use pool config overrides if available
      const poolCfg = this.poolConfigs.get(poolAddress);

      return {
        poolAddress,
        tokenA: poolCfg?.tokenA || tokenA,
        tokenB: poolCfg?.tokenB || tokenB,
        reserveA,
        reserveB,
        timestamp: Date.now(),
        slot: context.slot,
      };
    } catch (err) {
      dataLog.error(
        { err, pool: poolAddress, dataLen: data.length },
        'Failed to parse Raydium pool data'
      );
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
   * Calculate implied price from reserves: price of tokenB in terms of tokenA.
   * For a constant-product AMM: price = reserveA / reserveB
   * (how many units of A per unit of B)
   */
  private calculatePrice(reserveA: bigint, reserveB: bigint): number {
    if (reserveB === 0n) return 0;
    return Number(reserveA) / Number(reserveB);
  }

  /**
   * After a pool update, check if there's a cross-pool spread for the same token.
   * Compares the updated pool's price against ALL other cached pools for the same token.
   * If spread > threshold, emits a spread event (no Jupiter call needed for detection).
   */
  private detectCrossPoolSpread(updatedPool: PoolUpdate): void {
    if (this.spreadCallbacks.size === 0) return;

    // Find all other pools with the same tokenB (the non-SOL token)
    const updatedConfig = this.poolConfigs.get(updatedPool.poolAddress);
    if (!updatedConfig) return;

    const updatedPrice = this.calculatePrice(updatedPool.reserveA, updatedPool.reserveB);
    if (updatedPrice <= 0) return;

    // Compare against all other cached pools for the same token
    for (const [address, cached] of this.poolCache) {
      if (address === updatedPool.poolAddress) continue;

      const otherConfig = this.poolConfigs.get(address);
      if (!otherConfig) continue;

      // Same token pair? (tokenB is the non-SOL token)
      if (otherConfig.tokenB !== updatedConfig.tokenB) continue;

      // Check staleness — other pool must have been updated recently
      if (Date.now() - cached.cachedAt > 10_000) continue;

      const otherPrice = this.calculatePrice(cached.update.reserveA, cached.update.reserveB);
      if (otherPrice <= 0) continue;

      // Calculate spread in bps: (highPrice - lowPrice) / lowPrice * 10000
      const highPrice = Math.max(updatedPrice, otherPrice);
      const lowPrice = Math.min(updatedPrice, otherPrice);
      const spreadBps = ((highPrice - lowPrice) / lowPrice) * 10_000;

      // Only emit if spread is meaningful (> 3 bps to cover fees)
      if (spreadBps >= 3) {
        // Determine direction: buy from cheaper pool, sell to expensive pool
        const buyPool = updatedPrice < otherPrice ? updatedPool.poolAddress : address;
        const sellPool = updatedPrice < otherPrice ? address : updatedPool.poolAddress;

        const spreadEvent: SpreadEvent = {
          tokenMint: updatedConfig.tokenB,
          spreadBps,
          buyPoolAddress: buyPool,
          sellPoolAddress: sellPool,
          buyPrice: Math.min(updatedPrice, otherPrice),
          sellPrice: Math.max(updatedPrice, otherPrice),
          timestamp: Date.now(),
          slot: updatedPool.slot,
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
