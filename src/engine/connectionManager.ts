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
