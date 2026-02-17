// ═══════════════════════════════════════════════════════════════════
// SOLANA MEV BOT - PRODUCTION SERVER
// Unified engine with: cyclic arb, multi-hop, cross-DEX, sandwich,
// frontrun, backrun, liquidation, JIT liquidity
// All trades: SOL → [route] → SOL
// ═══════════════════════════════════════════════════════════════════

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

// Engine imports (these are the compiled .js files from src/engine/)
import { BotEngine } from './src/engine/botEngine.js';
import { createRoutes } from './src/engine/api/routes.js';
import { WebSocketServer as WebSocketBroadcaster } from './src/engine/api/websocket.js';
import { engineLog } from './src/engine/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════

async function main() {
  engineLog.info('╔════════════════════════════════════════════════════════╗');
  engineLog.info('║         SOLANA MEV BOT - PRODUCTION ENGINE             ║');
  engineLog.info('╚════════════════════════════════════════════════════════╝');

  // 1. Create and initialize the bot engine
  const engine = new BotEngine();

  try {
    await engine.initialize();
  } catch (err) {
    engineLog.fatal({ err }, 'Failed to initialize bot engine');
    process.exit(1);
  }

  const config = engine.getConfig();

  // 2. Create Express app
  const app = express();
  app.use(express.json());

  // CORS - restrictive in production
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [`http://localhost:${config.port}`];

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }));

  // 3. Mount API routes
  const router = createRoutes({
    database: engine.getDatabase(),
    metrics: engine.getMetrics(),
    botEngine: engine,
    config,
  });
  app.use(router);

  // 4. Serve React frontend (production build)
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(distPath, 'index.html'));
    } catch {
      res.status(500).send('Frontend not available - run: npm run build');
    }
  });

  // 5. Create HTTP server + WebSocket
  const httpServer = createServer(app);

  const wsBroadcaster = new WebSocketBroadcaster(httpServer, config);
  engine.setWebSocketBroadcaster(wsBroadcaster);

  // 6. Start listening
  httpServer.listen(config.port, '0.0.0.0', () => {
    const status = engine.getStatus();
    engineLog.info({
      port: config.port,
      riskLevel: config.riskLevel,
      jitoEnabled: config.jitoEnabled,
      geyser: config.geyserUrl ? 'configured' : 'not configured',
      strategies: status.activeStrategies,
    }, `Server running on port ${config.port}`);

    engineLog.info(`  Dashboard: http://localhost:${config.port}`);
    engineLog.info(`  API:       http://localhost:${config.port}/api/*`);
    engineLog.info(`  WebSocket: ws://localhost:${config.port}`);
    engineLog.info(`  Metrics:   http://localhost:${config.port}/api/metrics`);
  });

  // 7. Auto-start bot if configured
  if (process.env.AUTO_START === 'true') {
    engineLog.info('Auto-starting bot...');
    try {
      await engine.start();
    } catch (err) {
      engineLog.error({ err }, 'Auto-start failed');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // GRACEFUL SHUTDOWN
  // ═══════════════════════════════════════════════════════════════

  async function gracefulShutdown(signal) {
    engineLog.info({ signal }, 'Shutdown signal received');

    // Stop accepting new connections
    httpServer.close(() => {
      engineLog.info('HTTP server closed');
    });

    // Stop the bot (waits for in-flight trades)
    try {
      await engine.shutdown();
    } catch (err) {
      engineLog.error({ err }, 'Error during engine shutdown');
    }

    // Close WebSocket
    wsBroadcaster.close();

    // Force exit after 30s
    const forceTimeout = setTimeout(() => {
      engineLog.warn('Forced exit after timeout');
      process.exit(1);
    }, 30000);
    forceTimeout.unref();

    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    engineLog.fatal({ err }, 'Uncaught exception');
    gracefulShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    engineLog.error({ reason }, 'Unhandled rejection');
  });
}

// Run
main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
