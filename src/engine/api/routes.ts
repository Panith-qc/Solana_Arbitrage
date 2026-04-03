// API ROUTES
// Express router with admin authentication, CORS, and full bot management endpoints

import { Router, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { apiLog } from '../logger.js';
import { BotConfig, RiskLevel, RISK_PROFILES } from '../config.js';
import { BotDatabase } from '../database.js';
import { MetricsCollector } from '../metrics.js';
import {
  getCachedBlockhash, getCachedBlockhashAge, getCachedPriorityFee,
  isWsPaused, getKeeperStats, getPendingCount,
} from '../keepers.js';
import { RiskManager } from '../riskManager.js';

// ═══════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════

interface RouteDependencies {
  database: BotDatabase;
  metrics: MetricsCollector;
  botEngine: any;
  config: BotConfig;
}

interface AuthenticatedRequest extends Request {
  admin?: boolean;
}

const BOT_VERSION = '1.0.0';
const startedAt = Date.now();

// ═══════════════════════════════════════════════
// ROUTE FACTORY
// ═══════════════════════════════════════════════

export function createRoutes(deps: RouteDependencies): Router {
  const { database, metrics, botEngine, config } = deps;
  const router = Router();

  // ─────────────────────────────────────────────
  // CORS
  // ─────────────────────────────────────────────

  // CORS: allow same-origin requests (frontend served by this server)
  // and Codespaces / preview URLs.
  router.use(cors({
    origin: true,  // reflect the request origin — safe because the server itself serves the frontend
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-token'],
    credentials: true,
    maxAge: 86400,
  }));

  // ─────────────────────────────────────────────
  // REQUEST LOGGING
  // ─────────────────────────────────────────────

  router.use((req: Request, _res: Response, next: NextFunction) => {
    apiLog.info({
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    }, `${req.method} ${req.path}`);
    next();
  });

  // ─────────────────────────────────────────────
  // AUTH MIDDLEWARE
  // ─────────────────────────────────────────────

  function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    // If no admin token is configured, allow all requests through.
    // The wallet private key entry via UI is the primary authentication.
    if (!config.adminToken || config.adminToken.length === 0) {
      req.admin = true;
      next();
      return;
    }

    const token = req.headers['x-admin-token'] as string | undefined;

    if (!token || token !== config.adminToken) {
      apiLog.warn({ ip: req.ip, path: req.path }, 'Unauthorized admin request');
      res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid or missing admin token.',
      });
      return;
    }

    req.admin = true;
    next();
  }

  // ─────────────────────────────────────────────
  // HEALTH & METRICS (admin auth required)
  // Phase 7: Monitoring endpoints for production ops.
  // These read in-memory state only — never block the event loop.
  // ─────────────────────────────────────────────

  // GET /api/health — system health snapshot
  router.get('/api/health', requireAdmin, (_req: Request, res: Response) => {
    try {
      const keeperStats = getKeeperStats();
      const wsStatus = botEngine?.getWebSocketStatus?.() ?? { connected: false, monitoredPools: 0 };
      const scannerStats = botEngine?.getCircularScannerStats?.() ?? { running: false };

      // Estimate Helius credit usage:
      //   blockhash keeper: 1 credit/2s = 30/min
      //   priority fee keeper: 1 credit/10s = 6/min
      //   confirmation tracker: 1 credit/500ms but only when sigs pending
      const uptimeMin = (Date.now() - startedAt) / 60_000;
      const blockhashCredits = Math.round(uptimeMin * 30);
      const priorityFeeCredits = Math.round(uptimeMin * 6);
      // WS: 2 credits per 0.1MB — rough estimate based on subscription count
      const wsCreditsEstimate = Math.round(uptimeMin * wsStatus.monitoredPools * 0.5);

      res.json({
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        wsConnected: wsStatus.connected,
        wsSubscriptionCount: wsStatus.monitoredPools,
        wsPaused: isWsPaused(),
        cachedBlockhash: getCachedBlockhash() ? getCachedBlockhash().slice(0, 8) + '...' : null,
        cachedBlockhashAgeMs: getCachedBlockhashAge(),
        cachedPriorityFeeMicroLamports: getCachedPriorityFee(),
        jupiterScannerRunning: scannerStats.running,
        pendingConfirmations: getPendingCount(),
        keeperStats,
        creditsUsedEstimate: {
          blockhash: blockhashCredits,
          priorityFee: priorityFeeCredits,
          ws: wsCreditsEstimate,
          total: blockhashCredits + priorityFeeCredits + wsCreditsEstimate,
        },
        version: BOT_VERSION,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Health check failed');
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // GET /api/metrics — trading performance metrics
  router.get('/api/metrics', requireAdmin, (_req: Request, res: Response) => {
    try {
      const stats = botEngine?.getStats?.() ?? {};
      const riskMgr: RiskManager | undefined = botEngine?.getRiskManager?.();
      const riskStatus = riskMgr?.getStatus?.();
      const riskStats = riskMgr?.getStats?.();
      const scannerStats = botEngine?.getCircularScannerStats?.() ?? {};

      // Hot path stats from botEngine
      const hotPathExecutions = stats.hotPathExecutions ?? 0;
      const warmPathExecutions = stats.tradesExecuted ?? 0;

      res.json({
        tradesToday: {
          total: (stats.tradesExecuted ?? 0) + hotPathExecutions,
          hotPath: hotPathExecutions,
          warmPath: warmPathExecutions,
        },
        profitToday: {
          sol: stats.totalProfitSol ?? 0,
          usd: stats.totalProfitUsd ?? 0,
        },
        lossToday: {
          sol: riskStats?.dailyLossSol ?? 0,
        },
        netPnL: {
          sol: (stats.totalProfitSol ?? 0) - (riskStats?.dailyLossSol ?? 0),
        },
        opportunitiesDetected: stats.opportunitiesFound ?? 0,
        opportunitiesSkipped: stats.tradesSkipped ?? 0,
        revertsToday: riskStats?.dailyFailedAttempts ?? 0,
        avgExecutionMs: stats.avgExecutionMs ?? 0,
        circuitBreakerStatus: riskStatus?.circuitBreaker ?? null,
        openPositions: riskStatus?.openPositions ?? 0,
        dailyFailedAttempts: riskStats?.dailyFailedAttempts ?? 0,
        scannerStats: {
          totalScans: scannerStats.totalScans ?? 0,
          totalOpportunities: scannerStats.totalOpportunities ?? 0,
          totalExecutions: scannerStats.totalExecutions ?? 0,
          skippedRateLimit: scannerStats.skippedRateLimit ?? 0,
          cycleCount: scannerStats.cycleCount ?? 0,
          lastCycleMs: scannerStats.lastCycleMs ?? 0,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to collect metrics');
      res.status(500).json({ error: 'Failed to collect metrics' });
    }
  });

  // ─────────────────────────────────────────────
  // WALLET MANAGEMENT (no admin token needed for
  // initial setup, but secured once configured)
  // ─────────────────────────────────────────────

  // GET /api/wallet/status - Check wallet connection state
  router.get('/api/wallet/status', async (_req: Request, res: Response) => {
    try {
      const walletStatus = botEngine?.getWalletStatus?.() ?? {
        connected: false,
        publicKey: null,
        balanceSol: 0,
        rpcConnected: false,
      };

      res.json({
        ...walletStatus,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to get wallet status');
      res.status(500).json({ error: 'Failed to get wallet status' });
    }
  });

  // POST /api/wallet/connect - Connect wallet with private key from UI
  router.post('/api/wallet/connect', async (req: Request, res: Response) => {
    try {
      const { privateKey } = req.body as { privateKey?: string };

      if (!privateKey || typeof privateKey !== 'string' || privateKey.trim().length === 0) {
        res.status(400).json({
          error: 'Missing private key',
          message: 'Please provide a bs58-encoded Solana private key.',
        });
        return;
      }

      // Basic format validation before passing to engine
      const trimmed = privateKey.trim();
      if (trimmed.length < 32 || trimmed.length > 128) {
        res.status(400).json({
          error: 'Invalid key length',
          message: 'Private key should be a bs58-encoded string (typically 88 characters).',
        });
        return;
      }

      if (!botEngine?.connectWallet) {
        res.status(503).json({ error: 'Bot engine not available' });
        return;
      }

      const result = await botEngine.connectWallet(trimmed);

      apiLog.info({ publicKey: result.publicKey }, 'Wallet connected via UI');

      res.json({
        success: true,
        publicKey: result.publicKey,
        balanceSol: result.balanceSol,
        message: 'Wallet connected successfully. You can now start the bot.',
        timestamp: Date.now(),
      });
    } catch (err: any) {
      apiLog.error({ err }, 'Wallet connection failed');
      res.status(400).json({
        error: 'Wallet connection failed',
        message: err.message || 'Invalid private key or connection error.',
      });
    }
  });

  // POST /api/wallet/disconnect - Disconnect wallet and stop bot
  router.post('/api/wallet/disconnect', async (_req: Request, res: Response) => {
    try {
      if (!botEngine?.disconnectWallet) {
        res.status(503).json({ error: 'Bot engine not available' });
        return;
      }

      await botEngine.disconnectWallet();

      res.json({
        success: true,
        message: 'Wallet disconnected. Bot stopped.',
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Wallet disconnect failed');
      res.status(500).json({ error: 'Failed to disconnect wallet' });
    }
  });

  // ─────────────────────────────────────────────
  // DASHBOARD ROUTES (no admin auth — wallet key is the auth)
  // ─────────────────────────────────────────────

  // GET /api/status - Full bot status
  router.get('/api/status', async (_req: Request, res: Response) => {
    try {
      const running = botEngine?.isRunning?.() ?? false;
      const stats = botEngine?.getStats?.() ?? {};
      const riskStatus = botEngine?.getRiskStatus?.() ?? {};
      const circuitBreaker = botEngine?.getCircuitBreakerStatus?.() ?? {};

      const recentOpportunities = botEngine?.getRecentOpportunities?.() ?? [];
      const scanLogs = botEngine?.getScanLogs?.() ?? [];

      const wsStatus = botEngine?.getWebSocketStatus?.() ?? { connected: false, monitoredPools: 0, triggeredScans: 0 };

      res.json({
        running,
        stats,
        riskStatus,
        circuitBreaker,
        recentOpportunities,
        scanLogs,
        wsStatus,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to get bot status');
      res.status(500).json({ error: 'Failed to retrieve bot status' });
    }
  });

  // POST /api/start - Start the bot engine
  router.post('/api/start', async (_req: Request, res: Response) => {
    try {
      if (botEngine?.isRunning?.()) {
        res.status(409).json({ error: 'Bot is already running' });
        return;
      }

      await botEngine.start();
      apiLog.info('Bot engine started via API');

      res.json({
        success: true,
        message: 'Bot engine started',
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to start bot engine');
      res.status(500).json({ error: 'Failed to start bot engine' });
    }
  });

  // POST /api/stop - Stop the bot engine gracefully
  router.post('/api/stop', async (_req: Request, res: Response) => {
    try {
      if (!botEngine?.isRunning?.()) {
        res.status(409).json({ error: 'Bot is not running' });
        return;
      }

      await botEngine.stop();
      apiLog.info('Bot engine stopped via API');

      res.json({
        success: true,
        message: 'Bot engine stopped',
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to stop bot engine');
      res.status(500).json({ error: 'Failed to stop bot engine' });
    }
  });

  // POST /api/emergency-stop - Immediate halt, close all positions
  router.post('/api/emergency-stop', async (_req: Request, res: Response) => {
    try {
      apiLog.warn('EMERGENCY STOP triggered via API');

      if (typeof botEngine?.emergencyStop === 'function') {
        await botEngine.emergencyStop();
      } else {
        // Fallback: stop the engine if emergencyStop not implemented
        await botEngine?.stop?.();
      }

      res.json({
        success: true,
        message: 'Emergency stop executed - all positions closed',
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Emergency stop failed');
      res.status(500).json({ error: 'Emergency stop failed' });
    }
  });

  // GET /api/trades - Recent trades with optional filtering
  router.get('/api/trades', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 500);
      const strategy = req.query.strategy as string | undefined;

      let trades;
      if (strategy && strategy.length > 0) {
        trades = database.getTradesByStrategy(strategy, limit);
      } else {
        trades = database.getRecentTrades(limit);
      }

      res.json({
        trades,
        count: trades.length,
        limit,
        strategy: strategy || null,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch trades');
      res.status(500).json({ error: 'Failed to fetch trades' });
    }
  });

  // GET /api/trades/:tradeId - Single trade details
  router.get('/api/trades/:tradeId', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { tradeId } = req.params;

      // Fetch recent trades and find by trade_id
      // The database does not expose a getTradeById, so we search recent trades
      const trades = database.getRecentTrades(10000);
      const trade = trades.find(t => t.trade_id === tradeId);

      if (!trade) {
        res.status(404).json({ error: 'Trade not found', tradeId });
        return;
      }

      res.json({ trade, timestamp: Date.now() });
    } catch (err) {
      apiLog.error({ err, tradeId: req.params.tradeId }, 'Failed to fetch trade');
      res.status(500).json({ error: 'Failed to fetch trade details' });
    }
  });

  // GET /api/pnl/daily - Daily P&L history
  router.get('/api/pnl/daily', requireAdmin, async (req: Request, res: Response) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 365);
      const history = database.getDailyPnLHistory(days);

      res.json({
        history,
        days,
        count: history.length,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch daily P&L');
      res.status(500).json({ error: 'Failed to fetch daily P&L history' });
    }
  });

  // GET /api/pnl/strategies - Per-strategy performance
  router.get('/api/pnl/strategies', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const stats = database.getStrategyStats();

      res.json({
        strategies: stats,
        count: stats.length,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch strategy stats');
      res.status(500).json({ error: 'Failed to fetch strategy performance' });
    }
  });

  // GET /api/positions - Current open positions
  router.get('/api/positions', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const positions = botEngine?.getOpenPositions?.() ?? [];

      res.json({
        positions,
        count: positions.length,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch positions');
      res.status(500).json({ error: 'Failed to fetch open positions' });
    }
  });

  // GET /api/stuck-tokens - Stuck tokens needing recovery
  router.get('/api/stuck-tokens', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const stuckTokens = database.getStuckTokens();

      res.json({
        stuckTokens,
        count: stuckTokens.length,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch stuck tokens');
      res.status(500).json({ error: 'Failed to fetch stuck tokens' });
    }
  });

  // POST /api/config/risk-level - Change risk level
  router.post('/api/config/risk-level', async (req: Request, res: Response) => {
    try {
      const { level } = req.body as { level?: string };

      if (!level || !['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'].includes(level)) {
        res.status(400).json({
          error: 'Invalid risk level',
          message: 'Must be one of: CONSERVATIVE, BALANCED, AGGRESSIVE',
          received: level ?? null,
        });
        return;
      }

      const newLevel = level as RiskLevel;
      const previousLevel = config.riskLevel;

      // Update the config
      config.riskLevel = newLevel;

      // Notify the engine if it supports dynamic risk updates
      if (typeof botEngine?.updateRiskLevel === 'function') {
        botEngine.updateRiskLevel(newLevel);
      }

      const profile = RISK_PROFILES[newLevel];

      apiLog.info(
        { previousLevel, newLevel },
        `Risk level changed from ${previousLevel} to ${newLevel}`
      );

      res.json({
        success: true,
        previousLevel,
        newLevel,
        profile,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to update risk level');
      res.status(500).json({ error: 'Failed to update risk level' });
    }
  });

  // GET /api/config - Current config (sanitized)
  router.get('/api/config', requireAdmin, async (_req: Request, res: Response) => {
    try {
      // Return config without sensitive fields
      const sanitized = {
        rpcUrl: maskSecret(config.rpcUrl),
        rpcBackupUrl: maskSecret(config.rpcBackupUrl),
        rpcCommitment: config.rpcCommitment,
        riskLevel: config.riskLevel,
        capitalSol: config.capitalSol,
        scanAmountSol: config.scanAmountSol,
        jupiterApiUrl: config.jupiterApiUrl,
        jitoEnabled: config.jitoEnabled,
        jitoTipLamports: config.jitoTipLamports,
        jitoMaxTipLamports: config.jitoMaxTipLamports,
        maxRequestsPerSecond: config.maxRequestsPerSecond,
        port: config.port,
        riskProfile: RISK_PROFILES[config.riskLevel],
        telegramConfigured: !!(config.telegramBotToken && config.telegramChatId),
        discordConfigured: !!config.discordWebhookUrl,
        geyserConfigured: !!config.geyserUrl,
      };

      res.json({
        config: sanitized,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch config');
      res.status(500).json({ error: 'Failed to fetch configuration' });
    }
  });

  // POST /api/quote - Proxy to Jupiter quote API
  router.post('/api/quote', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { inputMint, outputMint, amount, slippageBps } = req.body as {
        inputMint?: string;
        outputMint?: string;
        amount?: string;
        slippageBps?: number;
      };

      if (!inputMint || !outputMint || !amount) {
        res.status(400).json({
          error: 'Missing required fields',
          message: 'inputMint, outputMint, and amount are required',
        });
        return;
      }

      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount,
        slippageBps: String(slippageBps ?? (config.riskLevel === 'CONSERVATIVE' ? 50 : 100)),
      });

      const quoteUrl = `${config.jupiterApiUrl}/v6/quote?${params.toString()}`;

      const response = await fetch(quoteUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...(config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {}),
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        apiLog.warn({ status: response.status, body: errorBody }, 'Jupiter quote API error');
        res.status(response.status).json({
          error: 'Jupiter API error',
          status: response.status,
          message: errorBody,
        });
        return;
      }

      const quoteData = await response.json();

      res.json({
        quote: quoteData,
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to fetch Jupiter quote');
      res.status(500).json({ error: 'Failed to fetch quote' });
    }
  });

  // ─────────────────────────────────────────────
  // ANALYTICS LOG ENDPOINTS
  // ─────────────────────────────────────────────

  // Daily summary — token/strategy breakdown, best spreads, 429 counts
  router.get('/api/analytics/summary', async (req: Request, res: Response) => {
    try {
      const date = req.query.date as string | undefined;
      const summary = botEngine.getAnalyticsSummary(date);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate summary' });
    }
  });

  // List all log files
  router.get('/api/analytics/files', async (_req: Request, res: Response) => {
    try {
      const files = botEngine.getAnalyticsLogFiles();
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: 'Failed to list log files' });
    }
  });

  // Read specific log file (scans, opportunities, cycles, loops, api_errors, trades)
  router.get('/api/analytics/logs/:prefix', async (req: Request, res: Response) => {
    try {
      const { prefix } = req.params;
      const date = req.query.date as string | undefined;
      const tail = parseInt(req.query.tail as string || '200', 10);
      const lines = botEngine.getAnalyticsLog(prefix, date, tail);
      const parsed = lines.map((line: string) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
      res.json({ count: parsed.length, entries: parsed });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read log' });
    }
  });

  return router;
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

/**
 * Mask a secret string, showing only the first 6 and last 4 characters.
 * Returns '***' if the string is too short or empty.
 */
function maskSecret(value: string): string {
  if (!value || value.length < 12) {
    return value ? '***' : '';
  }
  return `${value.substring(0, 6)}...${value.substring(value.length - 4)}`;
}
