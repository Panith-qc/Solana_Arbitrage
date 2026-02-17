// STRUCTURED LOGGING ENGINE
// JSON-formatted logs with levels, context, and trade correlation IDs

import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level: LOG_LEVEL,
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  } : undefined,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'solana-mev-bot' },
});

// Child loggers for each subsystem
export const engineLog = logger.child({ module: 'engine' });
export const executionLog = logger.child({ module: 'execution' });
export const strategyLog = logger.child({ module: 'strategy' });
export const riskLog = logger.child({ module: 'risk' });
export const dataLog = logger.child({ module: 'data' });
export const apiLog = logger.child({ module: 'api' });
export const monitorLog = logger.child({ module: 'monitor' });

// Trade-specific logger with correlation ID
export function tradeLogger(tradeId: string, strategy: string) {
  return logger.child({ tradeId, strategy, module: 'trade' });
}

export type Logger = pino.Logger;
