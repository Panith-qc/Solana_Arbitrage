// WEBSOCKET SERVER
// Real-time event broadcasting for the dashboard via ws

import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';
import { apiLog } from '../logger.js';
import { BotConfig } from '../config.js';

// ═══════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════

/** Channels that clients can subscribe to for filtered events. */
type Channel = 'trades' | 'opportunities' | 'pnl' | 'status' | 'alerts' | 'metrics';

const VALID_CHANNELS: ReadonlySet<string> = new Set<Channel>([
  'trades',
  'opportunities',
  'pnl',
  'status',
  'alerts',
  'metrics',
]);

/** Outbound message envelope sent to every subscribed client. */
interface OutboundMessage {
  type: string;
  channel: Channel;
  data: unknown;
  timestamp: number;
}

/** Inbound messages that clients may send. */
interface InboundSubscribe {
  type: 'subscribe';
  channels: string[];
}

interface InboundPing {
  type: 'ping';
}

type InboundMessage = InboundSubscribe | InboundPing;

/** Per-connection metadata attached to each WebSocket instance. */
interface ClientMeta {
  id: string;
  subscribedChannels: Set<Channel>;
  isAlive: boolean;
  connectedAt: number;
}

// Extend WebSocket to carry metadata
type AugmentedWebSocket = WebSocket & { meta: ClientMeta };

// ═══════════════════════════════════════════════
// WEBSOCKET SERVER
// ═══════════════════════════════════════════════

export class WebSocketServer {
  private wss: WSServer;
  private config: BotConfig;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private clientIdCounter = 0;

  constructor(httpServer: any, config: BotConfig) {
    this.config = config;

    this.wss = new WSServer({
      server: httpServer,
      path: '/ws',
      // Reject connections at the protocol level before upgrade completes
      verifyClient: (info, callback) => {
        const authorized = this.verifyToken(info.req);
        if (!authorized) {
          apiLog.warn(
            { ip: info.req.socket.remoteAddress },
            'WebSocket connection rejected: invalid token'
          );
          callback(false, 403, 'Forbidden');
          return;
        }
        callback(true);
      },
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws as AugmentedWebSocket, req);
    });

    this.wss.on('error', (err) => {
      apiLog.error({ err }, 'WebSocket server error');
    });

    this.startHeartbeat();

    apiLog.info({ path: '/ws' }, 'WebSocket server initialized');
  }

  // ─────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────

  private verifyToken(req: IncomingMessage): boolean {
    // Admin token must be configured
    if (!this.config.adminToken || this.config.adminToken.length === 0) {
      return false;
    }

    try {
      // Parse the token from the query string (?token=...)
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const token = url.searchParams.get('token');
      return token === this.config.adminToken;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────
  // CONNECTION HANDLING
  // ─────────────────────────────────────────────

  private handleConnection(ws: AugmentedWebSocket, req: IncomingMessage): void {
    const clientId = `ws-${++this.clientIdCounter}-${Date.now().toString(36)}`;

    ws.meta = {
      id: clientId,
      subscribedChannels: new Set<Channel>(['trades', 'pnl', 'status', 'alerts']),
      isAlive: true,
      connectedAt: Date.now(),
    };

    apiLog.info(
      { clientId, ip: req.socket.remoteAddress, clients: this.getClientCount() },
      'WebSocket client connected'
    );

    ws.on('pong', () => {
      ws.meta.isAlive = true;
    });

    ws.on('message', (raw: Buffer | string) => {
      this.handleMessage(ws, raw);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      apiLog.info(
        { clientId, code, reason: reason.toString(), clients: this.getClientCount() - 1 },
        'WebSocket client disconnected'
      );
    });

    ws.on('error', (err) => {
      apiLog.error({ err, clientId }, 'WebSocket client error');
    });

    // Acknowledge the connection
    this.sendToClient(ws, {
      type: 'connected',
      channel: 'status' as Channel,
      data: {
        clientId,
        subscribedChannels: Array.from(ws.meta.subscribedChannels),
        message: 'Connected to Solana MEV Bot WebSocket',
      },
      timestamp: Date.now(),
    });
  }

  // ─────────────────────────────────────────────
  // CLIENT MESSAGE HANDLING
  // ─────────────────────────────────────────────

  private handleMessage(ws: AugmentedWebSocket, raw: Buffer | string): void {
    let parsed: InboundMessage;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      parsed = JSON.parse(text);
    } catch {
      this.sendToClient(ws, {
        type: 'error',
        channel: 'status' as Channel,
        data: { message: 'Invalid JSON' },
        timestamp: Date.now(),
      });
      return;
    }

    switch (parsed.type) {
      case 'ping': {
        this.sendToClient(ws, {
          type: 'pong',
          channel: 'status' as Channel,
          data: null,
          timestamp: Date.now(),
        });
        break;
      }

      case 'subscribe': {
        const msg = parsed as InboundSubscribe;
        if (!Array.isArray(msg.channels)) {
          this.sendToClient(ws, {
            type: 'error',
            channel: 'status' as Channel,
            data: { message: 'channels must be an array' },
            timestamp: Date.now(),
          });
          return;
        }

        // Replace subscriptions entirely
        ws.meta.subscribedChannels.clear();
        for (const ch of msg.channels) {
          if (VALID_CHANNELS.has(ch)) {
            ws.meta.subscribedChannels.add(ch as Channel);
          }
        }

        apiLog.debug(
          { clientId: ws.meta.id, channels: Array.from(ws.meta.subscribedChannels) },
          'Client updated subscriptions'
        );

        this.sendToClient(ws, {
          type: 'subscribed',
          channel: 'status' as Channel,
          data: { channels: Array.from(ws.meta.subscribedChannels) },
          timestamp: Date.now(),
        });
        break;
      }

      default: {
        this.sendToClient(ws, {
          type: 'error',
          channel: 'status' as Channel,
          data: { message: `Unknown message type: ${(parsed as any).type}` },
          timestamp: Date.now(),
        });
      }
    }
  }

  // ─────────────────────────────────────────────
  // HEARTBEAT
  // ─────────────────────────────────────────────

  private startHeartbeat(): void {
    // Every 30 seconds: send a ping to each client.
    // If a client has not responded to the previous ping (isAlive still false),
    // give it a 10-second grace window before terminating.
    this.heartbeatInterval = setInterval(() => {
      for (const raw of this.wss.clients) {
        const ws = raw as AugmentedWebSocket;
        if (!ws.meta) continue;

        if (!ws.meta.isAlive) {
          // Client missed the last ping. Give a 10-second grace period
          // before terminating, in case the pong is just delayed.
          setTimeout(() => {
            if (!ws.meta?.isAlive && ws.readyState === WebSocket.OPEN) {
              apiLog.info({ clientId: ws.meta.id }, 'Terminating unresponsive WebSocket client');
              ws.terminate();
            }
          }, 10_000);
          continue;
        }

        // Mark as not-alive, then ping. The pong handler sets isAlive = true.
        ws.meta.isAlive = false;
        ws.ping();
      }
    }, 30_000);
  }

  // ─────────────────────────────────────────────
  // BROADCAST METHODS
  // ─────────────────────────────────────────────

  /**
   * Broadcast a message to all clients subscribed to the given channel.
   */
  broadcast(channel: Channel, data: unknown): void {
    const message: OutboundMessage = {
      type: channel,
      channel,
      data,
      timestamp: Date.now(),
    };

    const payload = JSON.stringify(message);
    let sent = 0;

    for (const raw of this.wss.clients) {
      const ws = raw as AugmentedWebSocket;
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!ws.meta?.subscribedChannels.has(channel)) continue;

      try {
        ws.send(payload);
        sent++;
      } catch (err) {
        apiLog.error({ err, clientId: ws.meta?.id }, 'Failed to send message to client');
      }
    }

    if (sent > 0) {
      apiLog.debug({ channel, clients: sent }, 'Broadcast sent');
    }
  }

  /** Broadcast a trade execution event. */
  broadcastTrade(trade: unknown): void {
    this.broadcast('trades', trade);
  }

  /** Broadcast a detected arbitrage opportunity. */
  broadcastOpportunity(opportunity: unknown): void {
    this.broadcast('opportunities', opportunity);
  }

  /** Broadcast a periodic P&L update. */
  broadcastPnLUpdate(pnl: unknown): void {
    this.broadcast('pnl', pnl);
  }

  /** Broadcast a bot status change event. */
  broadcastStatus(status: unknown): void {
    this.broadcast('status', status);
  }

  /** Broadcast a critical alert. */
  broadcastAlert(alert: unknown): void {
    this.broadcast('alerts', alert);
  }

  /** Broadcast a periodic metrics snapshot. */
  broadcastMetrics(metricsData: unknown): void {
    this.broadcast('metrics', metricsData);
  }

  // ─────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────

  /** Number of currently connected clients. */
  getClientCount(): number {
    return this.wss.clients.size;
  }

  /** Send a message to a single client. */
  private sendToClient(ws: AugmentedWebSocket, message: OutboundMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      apiLog.error({ err, clientId: ws.meta?.id }, 'Failed to send message to client');
    }
  }

  /** Gracefully shut down the WebSocket server. */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      // Close all client connections
      for (const raw of this.wss.clients) {
        const ws = raw as AugmentedWebSocket;
        try {
          ws.close(1001, 'Server shutting down');
        } catch {
          ws.terminate();
        }
      }

      this.wss.close((err) => {
        if (err) {
          apiLog.error({ err }, 'Error closing WebSocket server');
          reject(err);
        } else {
          apiLog.info('WebSocket server closed');
          resolve();
        }
      });
    });
  }
}
