// SHARED CONNECTION MANAGER
// Single connection pool shared across all services
// Supports primary + backup RPC with automatic failover

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
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

    // Initialize wallet from env (optional — can be connected later via UI)
    if (this.config.privateKey && this.config.privateKey.length > 10) {
      try {
        const keyBytes = bs58.decode(this.config.privateKey);
        this.wallet = Keypair.fromSecretKey(keyBytes);
        engineLog.info({ publicKey: this.wallet.publicKey.toString() }, 'Wallet loaded from environment');
      } catch (err) {
        engineLog.warn('PRIVATE_KEY in .env is invalid — ignoring. Connect your wallet via the dashboard instead.');
        // Don't crash — wallet can be connected later via POST /api/wallet/connect
      }
    }

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
   */
  async getDynamicPriorityFee(): Promise<number> {
    const now = Date.now();
    if (now - this.lastPriorityFeeFetchMs < this.PRIORITY_FEE_CACHE_TTL_MS) {
      return this.cachedPriorityFee;
    }

    if (!this.config.rpcUrl) return this.cachedPriorityFee;

    try {
      const response = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'priority-fee',
          method: 'getPriorityFeeEstimate',
          params: [{
            options: {
              recommended: true,
            },
          }],
        }),
        signal: AbortSignal.timeout(3000),
      });

      const data = await response.json() as any;
      if (data?.result?.priorityFeeEstimate) {
        const fee = Math.ceil(data.result.priorityFeeEstimate);
        // Clamp between 1,000 and 100,000 micro-lamports
        this.cachedPriorityFee = Math.max(1_000, Math.min(100_000, fee));
        this.lastPriorityFeeFetchMs = now;
        engineLog.debug(
          { priorityFeeMicroLamports: this.cachedPriorityFee },
          'Dynamic priority fee updated from Helius',
        );
      }
    } catch (err: any) {
      engineLog.debug({ err: err?.message }, 'Priority fee API failed — using cached value');
    }

    return this.cachedPriorityFee;
  }

  // ═══════════════════════════════════════════════════════════════
  // HELIUS PAID TIER: SMART TRANSACTION SEND
  // Dual-routes via staked validators AND Jito simultaneously
  // Higher landing rate than plain sendRawTransaction
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a serialized transaction via Helius sendTransaction RPC method.
   * On paid Helius tiers, this automatically routes through staked connections.
   * Falls back to standard sendRawTransaction if the enhanced method fails.
   */
  async sendSmartTransaction(serializedTx: Buffer): Promise<string> {
    const connection = this.getConnection();

    // Helius paid tier: sendTransaction via RPC auto-routes through staked validators
    // Use base58 encoding as required by Solana RPC spec
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
        return data.result as string;
      }
      if (data?.error) {
        throw new Error(`Helius sendTransaction: ${JSON.stringify(data.error)}`);
      }
      throw new Error('No result from sendTransaction');
    } catch (err: any) {
      engineLog.warn({ err: err?.message }, 'Helius smart send failed — falling back to sendRawTransaction');
      // Fallback to standard SDK method
      const signature = await connection.sendRawTransaction(serializedTx, {
        skipPreflight: true,
        maxRetries: 2,
        preflightCommitment: 'processed',
      });
      return signature;
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
