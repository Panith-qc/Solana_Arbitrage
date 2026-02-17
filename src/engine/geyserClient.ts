// GEYSER / YELLOWSTONE gRPC CLIENT
// Real-time mempool access for MEV detection.
// Uses WebSocket transport as a fallback when @triton-one/yellowstone-grpc is unavailable.
// When the geyserUrl config is empty, the client provides a safe no-op implementation
// so callers can subscribe without runtime errors.

import { dataLog } from './logger.js';
import { BotConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════
// Known DEX Program IDs
// ═══════════════════════════════════════════════════════════════

/** Raydium AMM V4 program */
export const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/** Orca Whirlpool program */
export const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/** Jupiter Aggregator V6 program */
export const JUPITER_AGGREGATOR_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** All tracked DEX program IDs */
export const DEX_PROGRAM_IDS = [
  RAYDIUM_AMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  JUPITER_AGGREGATOR_PROGRAM,
] as const;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Parsed transaction data received from the Geyser stream */
export interface ParsedTransactionData {
  /** Base-58 encoded transaction signature */
  signature: string;
  /** Slot the transaction was observed in */
  slot: number;
  /** Account public keys involved in the transaction */
  accounts: string[];
  /** Instruction summaries (program + data) */
  instructions: InstructionSummary[];
  /** Whether this is a vote transaction (should be filtered) */
  isVote: boolean;
  /** Unix timestamp (seconds) when the transaction was observed */
  timestamp: number;
}

/** Minimal instruction representation from the Geyser feed */
export interface InstructionSummary {
  programId: string;
  accounts: string[];
  /** Base-64 encoded instruction data */
  data: string;
}

/** Subscription handle returned by subscribe methods */
export interface GeyserSubscription {
  id: string;
  unsubscribe: () => void;
}

/** Callback type for transaction events */
export type TransactionCallback = (tx: ParsedTransactionData) => void;

// ═══════════════════════════════════════════════════════════════
// Internal WebSocket transport (fallback when gRPC is unavailable)
// ═══════════════════════════════════════════════════════════════

interface WebSocketTransport {
  ws: WebSocket | null;
  url: string;
  token: string;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
}

// ═══════════════════════════════════════════════════════════════
// GeyserClient
// ═══════════════════════════════════════════════════════════════

export class GeyserClient {
  private config: BotConfig;
  private transport: WebSocketTransport;
  private transactionHandlers: Map<string, TransactionCallback> = new Map();
  private subscriptionCounter = 0;
  private isConnected = false;
  private isConfigured = false;

  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly BASE_RECONNECT_DELAY_MS = 1000;
  private readonly MAX_RECONNECT_DELAY_MS = 30000;

  constructor(config: BotConfig) {
    this.config = config;
    this.isConfigured = Boolean(config.geyserUrl);

    this.transport = {
      ws: null,
      url: config.geyserUrl || '',
      token: config.geyserToken || '',
      connected: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
    };

    if (!this.isConfigured) {
      dataLog.warn(
        'Geyser URL not configured (GEYSER_URL env). ' +
        'GeyserClient will operate in no-op mode. ' +
        'Set GEYSER_URL and GEYSER_TOKEN for real-time mempool access.'
      );
    }
  }

  // ─────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────

  /** Connect to the Geyser endpoint. No-op if not configured. */
  async connect(): Promise<void> {
    if (!this.isConfigured) {
      dataLog.info('GeyserClient: no-op mode (geyserUrl not set)');
      return;
    }

    dataLog.info({ url: this.maskUrl(this.transport.url) }, 'Connecting to Geyser endpoint');

    try {
      await this.connectWebSocket();
      dataLog.info('Geyser WebSocket connected');
    } catch (err) {
      dataLog.error({ err }, 'Failed to connect to Geyser endpoint');
      this.scheduleReconnect();
    }
  }

  /** Disconnect and clean up all resources. */
  disconnect(): void {
    dataLog.info('Disconnecting GeyserClient');

    if (this.transport.reconnectTimer) {
      clearTimeout(this.transport.reconnectTimer);
      this.transport.reconnectTimer = null;
    }

    if (this.transport.ws) {
      try {
        this.transport.ws.close(1000, 'Client disconnecting');
      } catch {
        // Ignore close errors
      }
      this.transport.ws = null;
    }

    this.transport.connected = false;
    this.isConnected = false;
    this.transactionHandlers.clear();
    this.transport.reconnectAttempts = 0;

    dataLog.info('GeyserClient disconnected');
  }

  /** Whether the client is currently connected and receiving data. */
  get connected(): boolean {
    return this.isConnected;
  }

  /** Whether the client has a valid configuration (non-empty geyserUrl). */
  get configured(): boolean {
    return this.isConfigured;
  }

  // ─────────────────────────────────────────────
  // Subscriptions
  // ─────────────────────────────────────────────

  /**
   * Subscribe to confirmed transactions involving specific program IDs.
   * Useful for monitoring DEX activity (swaps, liquidity adds, etc.).
   */
  subscribeTransactions(
    programIds: string[],
    callback: TransactionCallback
  ): GeyserSubscription {
    const subId = this.nextSubscriptionId('tx');

    if (!this.isConfigured) {
      dataLog.debug({ subId, programIds }, 'subscribeTransactions: no-op (not configured)');
      return { id: subId, unsubscribe: () => {} };
    }

    // Wrap callback with program-ID filter
    const filteredCallback: TransactionCallback = (tx) => {
      const involvedPrograms = tx.instructions.map((ix) => ix.programId);
      const matches = programIds.some((pid) => involvedPrograms.includes(pid));
      if (matches) {
        callback(tx);
      }
    };

    this.transactionHandlers.set(subId, filteredCallback);

    // Send subscription message to Geyser if connected
    this.sendSubscriptionRequest('transactions', {
      subscriptionId: subId,
      programIds,
      includeVotes: false,
    });

    dataLog.info(
      { subId, programCount: programIds.length },
      'Subscribed to program transactions'
    );

    return {
      id: subId,
      unsubscribe: () => this.removeSubscription(subId),
    };
  }

  /**
   * Subscribe to pending (unconfirmed) transactions from the mempool.
   * This is the core feed for MEV detection - front-running, sandwich attacks, etc.
   */
  subscribePendingTransactions(callback: TransactionCallback): GeyserSubscription {
    const subId = this.nextSubscriptionId('pending');

    if (!this.isConfigured) {
      dataLog.debug({ subId }, 'subscribePendingTransactions: no-op (not configured)');
      return { id: subId, unsubscribe: () => {} };
    }

    this.transactionHandlers.set(subId, callback);

    this.sendSubscriptionRequest('pending_transactions', {
      subscriptionId: subId,
      includeVotes: false,
    });

    dataLog.info({ subId }, 'Subscribed to pending transactions');

    return {
      id: subId,
      unsubscribe: () => this.removeSubscription(subId),
    };
  }

  /**
   * Register a general transaction handler.
   * All received transactions (from any subscription) are forwarded to this callback.
   */
  onTransaction(callback: TransactionCallback): GeyserSubscription {
    const subId = this.nextSubscriptionId('handler');

    if (!this.isConfigured) {
      dataLog.debug({ subId }, 'onTransaction: no-op (not configured)');
      return { id: subId, unsubscribe: () => {} };
    }

    this.transactionHandlers.set(subId, callback);

    dataLog.info({ subId }, 'Registered transaction handler');

    return {
      id: subId,
      unsubscribe: () => this.removeSubscription(subId),
    };
  }

  // ─────────────────────────────────────────────
  // WebSocket transport
  // ─────────────────────────────────────────────

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.buildWsUrl();

      try {
        // Use the ws package (already in dependencies) for Node.js environments
        // In browser environments, the native WebSocket is used automatically
        const ws = new WebSocket(url);
        this.transport.ws = ws;

        const connectionTimeout = setTimeout(() => {
          if (!this.transport.connected) {
            ws.close();
            reject(new Error('WebSocket connection timeout (10s)'));
          }
        }, 10000);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          this.transport.connected = true;
          this.isConnected = true;
          this.transport.reconnectAttempts = 0;

          // Authenticate if token is provided
          if (this.transport.token) {
            this.sendMessage({
              type: 'authenticate',
              token: this.transport.token,
            });
          }

          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event.data);
        };

        ws.onerror = (event: Event) => {
          dataLog.error('Geyser WebSocket error');
          if (!this.transport.connected) {
            clearTimeout(connectionTimeout);
            reject(new Error('WebSocket connection error'));
          }
        };

        ws.onclose = (event: CloseEvent) => {
          const wasConnected = this.transport.connected;
          this.transport.connected = false;
          this.isConnected = false;

          dataLog.warn(
            { code: event.code, reason: event.reason, wasConnected },
            'Geyser WebSocket closed'
          );

          if (wasConnected && event.code !== 1000) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleMessage(rawData: string | ArrayBuffer | Blob): void {
    try {
      const data = typeof rawData === 'string' ? rawData : rawData.toString();
      const message = JSON.parse(data);

      if (message.type === 'transaction' || message.type === 'pending_transaction') {
        const tx = this.parseTransactionMessage(message);
        if (tx && !tx.isVote) {
          this.dispatchTransaction(tx);
        }
      } else if (message.type === 'error') {
        dataLog.error({ error: message.error }, 'Geyser stream error');
      } else if (message.type === 'heartbeat') {
        // Heartbeat acknowledged
      } else if (message.type === 'authenticated') {
        dataLog.info('Geyser authentication successful');
      }
    } catch (err) {
      dataLog.error({ err }, 'Failed to parse Geyser message');
    }
  }

  private parseTransactionMessage(message: Record<string, unknown>): ParsedTransactionData | null {
    try {
      const payload = message.data as Record<string, unknown> | undefined;
      if (!payload) return null;

      const accounts = (payload.accounts as string[]) || [];
      const rawInstructions = (payload.instructions as Array<Record<string, unknown>>) || [];

      const instructions: InstructionSummary[] = rawInstructions.map((ix) => ({
        programId: (ix.programId as string) || '',
        accounts: (ix.accounts as string[]) || [],
        data: (ix.data as string) || '',
      }));

      // Detect vote transactions by checking for the Vote program
      const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';
      const isVote = instructions.some((ix) => ix.programId === VOTE_PROGRAM_ID);

      return {
        signature: (payload.signature as string) || '',
        slot: (payload.slot as number) || 0,
        accounts,
        instructions,
        isVote,
        timestamp: (payload.timestamp as number) || Math.floor(Date.now() / 1000),
      };
    } catch (err) {
      dataLog.error({ err }, 'Failed to parse transaction message');
      return null;
    }
  }

  private dispatchTransaction(tx: ParsedTransactionData): void {
    for (const [subId, handler] of this.transactionHandlers) {
      try {
        handler(tx);
      } catch (err) {
        dataLog.error({ err, subId }, 'Transaction handler threw an error');
      }
    }
  }

  // ─────────────────────────────────────────────
  // Reconnection
  // ─────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.transport.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      dataLog.error(
        { attempts: this.transport.reconnectAttempts },
        'Max reconnect attempts reached. Geyser stream unavailable.'
      );
      return;
    }

    const delay = Math.min(
      this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.transport.reconnectAttempts),
      this.MAX_RECONNECT_DELAY_MS
    );

    this.transport.reconnectAttempts++;

    dataLog.info(
      { attempt: this.transport.reconnectAttempts, delayMs: delay },
      'Scheduling Geyser reconnect'
    );

    this.transport.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectWebSocket();
        dataLog.info('Geyser reconnected successfully');

        // Re-send active subscription requests after reconnect
        this.resubscribeAll();
      } catch (err) {
        dataLog.error({ err }, 'Geyser reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  private resubscribeAll(): void {
    dataLog.info(
      { subscriptions: this.transactionHandlers.size },
      'Re-subscribing after reconnect'
    );

    // After reconnect, send a generic subscribe to resume the stream.
    // Specific filtering happens client-side in the wrapped callbacks.
    if (this.transactionHandlers.size > 0) {
      this.sendSubscriptionRequest('transactions', {
        subscriptionId: 'reconnect-all',
        programIds: [...DEX_PROGRAM_IDS],
        includeVotes: false,
      });
    }
  }

  // ─────────────────────────────────────────────
  // Messaging helpers
  // ─────────────────────────────────────────────

  private sendMessage(message: Record<string, unknown>): void {
    if (!this.transport.ws || !this.transport.connected) {
      dataLog.debug('Cannot send message: WebSocket not connected');
      return;
    }

    try {
      this.transport.ws.send(JSON.stringify(message));
    } catch (err) {
      dataLog.error({ err }, 'Failed to send WebSocket message');
    }
  }

  private sendSubscriptionRequest(
    type: string,
    params: Record<string, unknown>
  ): void {
    this.sendMessage({
      type: 'subscribe',
      stream: type,
      ...params,
    });
  }

  private removeSubscription(subId: string): void {
    this.transactionHandlers.delete(subId);
    dataLog.debug({ subId }, 'Subscription removed');
  }

  private nextSubscriptionId(prefix: string): string {
    this.subscriptionCounter++;
    return `${prefix}-${this.subscriptionCounter}-${Date.now()}`;
  }

  private buildWsUrl(): string {
    let url = this.transport.url;

    // Normalise http(s) to ws(s)
    if (url.startsWith('https://')) {
      url = 'wss://' + url.slice(8);
    } else if (url.startsWith('http://')) {
      url = 'ws://' + url.slice(7);
    } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'wss://' + url;
    }

    return url;
  }

  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/***`;
    } catch {
      return '***';
    }
  }
}
