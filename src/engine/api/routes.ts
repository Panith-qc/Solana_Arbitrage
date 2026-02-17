// API ROUTES
// Express router with admin authentication, CORS, and full bot management endpoints

import { Router, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { apiLog } from '../logger.js';
import { BotConfig, RiskLevel, RISK_PROFILES } from '../config.js';
import { BotDatabase } from '../database.js';
import { MetricsCollector } from '../metrics.js';

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

  // Restrictive CORS: only allow specific origins.
  // In production, replace or extend this list with your actual dashboard domain.
  const allowedOrigins: string[] = [
    `http://localhost:${config.port}`,
    'https://dashboard.yourdomain.com',
  ];

  router.use(cors({
    origin(origin, callback) {
      // Allow requests with no origin (server-to-server, curl, etc.)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
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
    const token = req.headers['x-admin-token'] as string | undefined;

    if (!config.adminToken || config.adminToken.length === 0) {
      apiLog.warn('Admin token is not configured - rejecting request');
      res.status(403).json({
        error: 'Forbidden',
        message: 'Admin token is not configured. Set ADMIN_TOKEN environment variable.',
      });
      return;
    }

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
  // PUBLIC ROUTES (no auth required)
  // ─────────────────────────────────────────────

  // GET /api/health - Basic health check
  router.get('/api/health', async (_req: Request, res: Response) => {
    try {
      let rpcHealth = false;
      try {
        // Attempt a lightweight check via the bot engine if available
        rpcHealth = botEngine?.isRpcHealthy?.() ?? true;
      } catch {
        rpcHealth = false;
      }

      res.json({
        status: 'ok',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        wallet: config.privateKey ? 'configured' : 'not_configured',
        rpcHealth,
        version: BOT_VERSION,
      });
    } catch (err) {
      apiLog.error({ err }, 'Health check failed');
      res.status(500).json({ error: 'Health check failed' });
    }
  });

  // GET /api/metrics - Prometheus text format metrics
  router.get('/api/metrics', async (_req: Request, res: Response) => {
    try {
      const metricsText = await metrics.getMetrics();
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(metricsText);
    } catch (err) {
      apiLog.error({ err }, 'Failed to collect metrics');
      res.status(500).json({ error: 'Failed to collect metrics' });
    }
  });

  // ─────────────────────────────────────────────
  // PROTECTED ROUTES (admin auth required)
  // ─────────────────────────────────────────────

  // GET /api/status - Full bot status
  router.get('/api/status', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const running = botEngine?.isRunning?.() ?? false;
      const stats = botEngine?.getStats?.() ?? {};
      const riskStatus = botEngine?.getRiskStatus?.() ?? {};
      const circuitBreaker = botEngine?.getCircuitBreakerStatus?.() ?? {};

      res.json({
        running,
        stats,
        riskStatus,
        circuitBreaker,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: Date.now(),
      });
    } catch (err) {
      apiLog.error({ err }, 'Failed to get bot status');
      res.status(500).json({ error: 'Failed to retrieve bot status' });
    }
  });

  // POST /api/start - Start the bot engine
  router.post('/api/start', requireAdmin, async (_req: Request, res: Response) => {
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
  router.post('/api/stop', requireAdmin, async (_req: Request, res: Response) => {
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
  router.post('/api/emergency-stop', requireAdmin, async (_req: Request, res: Response) => {
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
  router.get('/api/trades', requireAdmin, async (req: Request, res: Response) => {
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
  router.post('/api/config/risk-level', requireAdmin, async (req: Request, res: Response) => {
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
          ...(config.jupiterApiKey ? { 'Authorization': `Bearer ${config.jupiterApiKey}` } : {}),
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
