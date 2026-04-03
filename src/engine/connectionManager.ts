// SHARED CONNECTION MANAGER
// Single connection pool shared across all services
// Supports primary + backup RPC with automatic failover

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { engineLog } from './logger.js';
import { BotConfig } from './config.js';

export class ConnectionManager {
  private primaryConnection: Connection | null = null;
  private backupConnection: Connection | null = null;
  private activeConnection: Connection | null = null;
  private wallet: Keypair | null = null;
  private config: BotConfig;

  // Health tracking
  private primaryFailures = 0;
  private backupFailures = 0;
  private lastPrimaryCheck = 0;
  private readonly MAX_FAILURES_BEFORE_FAILOVER = 3;
  private readonly HEALTH_CHECK_INTERVAL = 30000; // 30s

  constructor(config: BotConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Initialize primary RPC (with explicit WebSocket URL if configured)
    if (this.config.rpcUrl) {
      const connectionOpts: any = {
        commitment: this.config.rpcCommitment,
        confirmTransactionInitialTimeout: 30000,
      };
      // Use explicit WebSocket URL for enhanced WebSocket on paid Helius tiers
      if (this.config.rpcWsUrl) {
        connectionOpts.wsEndpoint = this.config.rpcWsUrl;
      }
      this.primaryConnection = new Connection(this.config.rpcUrl, connectionOpts);
      this.activeConnection = this.primaryConnection;
      engineLog.info(
        { rpc: this.maskUrl(this.config.rpcUrl), ws: this.config.rpcWsUrl ? 'explicit' : 'auto' },
        'Primary RPC initialized',
      );
    }

    // Initialize backup RPC
    if (this.config.rpcBackupUrl) {
      this.backupConnection = new Connection(this.config.rpcBackupUrl, {
        commitment: this.config.rpcCommitment,
        confirmTransactionInitialTimeout: 30000,
      });
      engineLog.info({ rpc: this.maskUrl(this.config.rpcBackupUrl) }, 'Backup RPC initialized');
    }

    // Wallet is NOT loaded from env. Private key must be provided via
    // POST /api/wallet/connect at runtime — never touches disk.
    // The bot starts in monitoring-only mode until a wallet is connected.

    if (!this.activeConnection) {
      throw new Error('No RPC connection available - set HELIUS_RPC_URL');
    }

    // Validate connection
    try {
      const slot = await this.activeConnection.getSlot();
      engineLog.info({ slot }, 'RPC connection validated');
    } catch (err) {
      engineLog.error({ err }, 'RPC connection validation failed');
      throw err;
    }
  }

  getConnection(): Connection {
    if (!this.activeConnection) {
      throw new Error('ConnectionManager not initialized');
    }
    return this.activeConnection;
  }

  getWallet(): Keypair {
    if (!this.wallet) {
      throw new Error('No wallet configured');
    }
    return this.wallet;
  }

  getPublicKey(): PublicKey {
    return this.getWallet().publicKey;
  }

  hasWallet(): boolean {
    return this.wallet !== null;
  }

  /**
   * Dynamically set the wallet from a bs58-encoded private key.
   * Used when the user connects via the web UI instead of .env.
   * Returns the public key on success.
   */
  setWallet(bs58PrivateKey: string): string {
    try {
      const keyBytes = bs58.decode(bs58PrivateKey);
      this.wallet = Keypair.fromSecretKey(keyBytes);
      const publicKey = this.wallet.publicKey.toString();
      engineLog.info({ publicKey }, 'Wallet connected dynamically');
      return publicKey;
    } catch (err) {
      throw new Error('Invalid private key format — expected a bs58-encoded Solana private key');
    }
  }

  /**
   * Disconnect the current wallet (for security — clear from memory).
   */
  disconnectWallet(): void {
    if (this.wallet) {
      engineLog.info('Wallet disconnected');
      this.wallet = null;
    }
  }

  /**
   * Check if RPC is initialized (server can start without RPC, wallet connects later).
   */
  isInitialized(): boolean {
    return this.activeConnection !== null;
  }

  // Report a connection failure - triggers failover if threshold exceeded
  async reportFailure(): Promise<void> {
    if (this.activeConnection === this.primaryConnection) {
      this.primaryFailures++;
      if (this.primaryFailures >= this.MAX_FAILURES_BEFORE_FAILOVER && this.backupConnection) {
        engineLog.warn(
          { failures: this.primaryFailures },
          'Primary RPC exceeded failure threshold, failing over to backup'
        );
        this.activeConnection = this.backupConnection;
        this.primaryFailures = 0;
      }
    } else {
      this.backupFailures++;
      if (this.backupFailures >= this.MAX_FAILURES_BEFORE_FAILOVER && this.primaryConnection) {
        engineLog.warn(
          { failures: this.backupFailures },
          'Backup RPC exceeded failure threshold, failing back to primary'
        );
        this.activeConnection = this.primaryConnection;
        this.backupFailures = 0;
      }
    }
  }

  // Report success - resets failure counter
  reportSuccess(): void {
    if (this.activeConnection === this.primaryConnection) {
      this.primaryFailures = 0;
    } else {
      this.backupFailures = 0;
    }
  }

  // Periodic health check - try to recover primary if on backup
  async healthCheck(): Promise<{ primary: boolean; backup: boolean; active: string }> {
    const now = Date.now();
    if (now - this.lastPrimaryCheck < this.HEALTH_CHECK_INTERVAL) {
      return {
        primary: this.primaryConnection !== null,
        backup: this.backupConnection !== null,
        active: this.activeConnection === this.primaryConnection ? 'primary' : 'backup',
      };
    }
    this.lastPrimaryCheck = now;

    let primaryOk = false;
    let backupOk = false;

    if (this.primaryConnection) {
      try {
        await this.primaryConnection.getSlot();
        primaryOk = true;
        // If we were on backup, switch back to primary
        if (this.activeConnection !== this.primaryConnection) {
          engineLog.info('Primary RPC recovered, switching back');
          this.activeConnection = this.primaryConnection;
          this.backupFailures = 0;
        }
      } catch {
        primaryOk = false;
      }
    }

    if (this.backupConnection) {
      try {
        await this.backupConnection.getSlot();
        backupOk = true;
      } catch {
        backupOk = false;
      }
    }

    return {
      primary: primaryOk,
      backup: backupOk,
      active: this.activeConnection === this.primaryConnection ? 'primary' : 'backup',
    };
  }

  // Get SOL balance for the wallet
  async getBalance(): Promise<number> {
    const conn = this.getConnection();
    const balance = await conn.getBalance(this.getPublicKey());
    return balance / 1e9;
  }

  // Get token balance for a specific mint
  async getTokenBalance(mintAddress: string): Promise<bigint> {
    const conn = this.getConnection();
    const tokenAccounts = await conn.getTokenAccountsByOwner(this.getPublicKey(), {
      mint: new PublicKey(mintAddress),
    });

    if (tokenAccounts.value.length === 0) return 0n;

    const balance = await conn.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
    return BigInt(balance.value.amount);
  }

  // ═══════════════════════════════════════════════════════════════
  // HELIUS PAID TIER: DYNAMIC PRIORITY FEES
  // ═══════════════════════════════════════════════════════════════

  private cachedPriorityFee: number = 10_000; // default micro-lamports
  private lastPriorityFeeFetchMs: number = 0;
  private readonly PRIORITY_FEE_CACHE_TTL_MS = 10_000; // refresh every 10s

  /**
   * Get optimal priority fee from Helius getPriorityFeeEstimate API.
   * Returns micro-lamports. Cached for 10s to avoid hammering.
   * Falls back to default 10,000 if API fails.
   *
   * When a serialized transaction is provided, Helius returns fees
   * specific to the accounts in that transaction (much more accurate).
   */
  async getDynamicPriorityFee(serializedTxBase64?: string): Promise<number> {
    const now = Date.now();
    // Only use cache for global (non-TX-specific) requests
    if (!serializedTxBase64 && now - this.lastPriorityFeeFetchMs < this.PRIORITY_FEE_CACHE_TTL_MS) {
      return this.cachedPriorityFee;
    }

    if (!this.config.rpcUrl) return this.cachedPriorityFee;

    try {
      // Build params: if we have a TX, pass it for account-specific fees
      const params: any = serializedTxBase64
        ? [{
            transaction: serializedTxBase64,
            options: {
              priorityLevel: 'High',
              transactionEncoding: 'base64',
            },
          }]
        : [{
            options: { recommended: true },
          }];

      const response = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'priority-fee',
          method: 'getPriorityFeeEstimate',
          params,
        }),
        signal: AbortSignal.timeout(3000),
      });

      const data = await response.json() as any;
      if (data?.result?.priorityFeeEstimate) {
        const fee = Math.ceil(data.result.priorityFeeEstimate);
        // Clamp between 1,000 and 500,000 micro-lamports (higher cap for competitive arb)
        const clampedFee = Math.max(1_000, Math.min(500_000, fee));

        if (!serializedTxBase64) {
          this.cachedPriorityFee = clampedFee;
          this.lastPriorityFeeFetchMs = now;
        }

        engineLog.debug(
          { priorityFeeMicroLamports: clampedFee, txSpecific: !!serializedTxBase64 },
          'Dynamic priority fee from Helius',
        );
        return clampedFee;
      }
    } catch (err: any) {
      engineLog.debug({ err: err?.message }, 'Priority fee API failed — using cached value');
    }

    return this.cachedPriorityFee;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELIUS PAID TIER: SEND VIA SENDER ENDPOINT
  // sender.helius-rpc.com/fast is a SEPARATE endpoint from regular RPC.
  // It dual-routes through:
  //   1. SWQoS (Staked Weighted Quality of Service) — staked connections
  //   2. Jito auction — MEV-aware block builders
  // This gives the HIGHEST landing rate for time-sensitive arb TXs.
  // Requires a Jito tip in the TX (min 200,000 lamports = 0.0002 SOL).
  // Free on all Helius paid plans, 50 TPS default limit.
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build the Helius Sender URL.
   * This is a DEDICATED send endpoint, separate from the RPC URL.
   * Format: https://sender.helius-rpc.com/fast?api-key=KEY
   * The API key is extracted from the configured Helius RPC URL.
   */
  private getHeliusSenderUrl(): string {
    // Extract API key from RPC URL (e.g., https://mainnet.helius-rpc.com/?api-key=abc123)
    const apiKey = this.config.heliusApiKey;
    if (apiKey) {
      return `https://sender.helius-rpc.com/fast?api-key=${apiKey}`;
    }
    // Try to extract from RPC URL query params
    try {
      const url = new URL(this.config.rpcUrl);
      const key = url.searchParams.get('api-key') || url.pathname.slice(1);
      if (key && key.length > 10) {
        return `https://sender.helius-rpc.com/fast?api-key=${key}`;
      }
    } catch {}
    // Fallback: no Sender available, will use regular RPC
    return '';
  }

  /**
   * Send a serialized transaction via Helius Sender (sender.helius-rpc.com/fast).
   * Dual-routes through SWQoS + Jito simultaneously for maximum landing rate.
   *
   * The TX MUST include a Jito tip >= 200,000 lamports (0.0002 SOL) for
   * dual routing. Without it, only SWQoS is used.
   *
   * Falls back to regular RPC sendTransaction if Sender is unavailable.
   */
  async sendSmartTransaction(serializedTx: Buffer): Promise<string> {
    const connection = this.getConnection();
    const senderUrl = this.getHeliusSenderUrl();

    // PRIMARY: Helius Sender endpoint (SWQoS + Jito dual-routing)
    if (senderUrl) {
      try {
        const response = await fetch(senderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'send-tx',
            method: 'sendTransaction',
            params: [
              Buffer.from(serializedTx).toString('base64'),
              {
                encoding: 'base64',
                skipPreflight: true,
                maxRetries: 0,  // Sender requires 0 — we handle retries ourselves
              },
            ],
          }),
          signal: AbortSignal.timeout(10000),
        });

        const data = await response.json() as any;
        if (data?.result) {
          engineLog.info('TX sent via Helius Sender (sender.helius-rpc.com/fast — SWQoS + Jito)');
          return data.result as string;
        }
        if (data?.error) {
          throw new Error(`Helius Sender: ${JSON.stringify(data.error)}`);
        }
        throw new Error('No result from Sender');
      } catch (err: any) {
        engineLog.warn({ err: err?.message }, 'Helius Sender failed — falling back to regular RPC');
      }
    }

    // FALLBACK: Regular Helius RPC sendTransaction (still has staked connections on paid tier)
    try {
      const response = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'send-tx',
          method: 'sendTransaction',
          params: [
            Buffer.from(serializedTx).toString('base64'),
            {
              encoding: 'base64',
              skipPreflight: true,
              maxRetries: 2,
              preflightCommitment: 'processed',
            },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await response.json() as any;
      if (data?.result) {
        engineLog.info('TX sent via Helius RPC fallback');
        return data.result as string;
      }
      if (data?.error) {
        throw new Error(`Helius RPC: ${JSON.stringify(data.error)}`);
      }
    } catch (err: any) {
      engineLog.warn({ err: err?.message }, 'Helius RPC send failed — falling back to SDK');
    }

    // LAST RESORT: Standard SDK sendRawTransaction
    const signature = await connection.sendRawTransaction(serializedTx, {
      skipPreflight: true,
      maxRetries: 2,
      preflightCommitment: 'processed',
    });
    return signature;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELIUS PAID TIER: SIMULATION + CU OPTIMIZATION
  // Simulate the TX to get actual CU usage, then rebuild with
  // tight CU limit = higher effective priority fee per CU.
  // Also gates unprofitable TXs — if simulation fails, don't send.
  // ═══════════════════════════════════════════════════════════════

  /**
   * Simulate a VersionedTransaction and return the actual CU consumed.
   * Returns null if simulation fails (TX would revert on-chain).
   * Used to:
   *   1. Gate: don't send TXs that will revert (saves fees)
   *   2. Optimize: set CU limit to actual + 10% margin
   */
  async simulateForCU(transaction: VersionedTransaction): Promise<{
    success: boolean;
    unitsConsumed: number;
    error: string | null;
    logs: string[];
  }> {
    const connection = this.getConnection();

    try {
      const result = await connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment: 'processed',
      });

      const logs = result.value.logs || [];
      const unitsConsumed = result.value.unitsConsumed || 0;

      if (result.value.err) {
        return {
          success: false,
          unitsConsumed,
          error: JSON.stringify(result.value.err),
          logs,
        };
      }

      return { success: true, unitsConsumed, error: null, logs };
    } catch (err: any) {
      return {
        success: false,
        unitsConsumed: 0,
        error: err?.message || 'Simulation RPC error',
        logs: [],
      };
    }
  }

  getRpcUrl(): string {
    return this.config.rpcUrl;
  }

  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.pathname.length > 10) {
        return `${u.protocol}//${u.host}/***`;
      }
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return '***';
    }
  }
}
