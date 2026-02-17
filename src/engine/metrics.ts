// PROMETHEUS METRICS COLLECTION
// Exposes bot performance, trade, and infrastructure metrics for monitoring

import * as promClient from 'prom-client';
import { monitorLog } from './logger.js';

export class MetricsCollector {
  private registry: promClient.Registry;

  // Counters
  private tradesTotal: promClient.Counter<'strategy' | 'status'>;
  private scansTotal: promClient.Counter<'strategy'>;
  private rpcRequestsTotal: promClient.Counter<'endpoint' | 'status'>;
  private jitoBundlesTotal: promClient.Counter<'status'>;

  // Histograms
  private tradeProfitSol: promClient.Histogram<'strategy'>;
  private tradeLatencyMs: promClient.Histogram<'strategy' | 'phase'>;

  // Gauges
  private botBalanceSol: promClient.Gauge;
  private openPositionsCount: promClient.Gauge;
  private dailyPnlSol: promClient.Gauge;
  private dailyPnlUsd: promClient.Gauge;
  private circuitBreakerStatus: promClient.Gauge;
  private consecutiveFailures: promClient.Gauge;

  constructor() {
    this.registry = new promClient.Registry();
    this.registry.setDefaultLabels({ app: 'solana-mev-bot' });

    // ═══════════════════════════════════════════════
    // COUNTERS
    // ═══════════════════════════════════════════════

    this.tradesTotal = new promClient.Counter({
      name: 'trades_total',
      help: 'Total number of trades executed',
      labelNames: ['strategy', 'status'] as const,
      registers: [this.registry],
    });

    this.scansTotal = new promClient.Counter({
      name: 'scans_total',
      help: 'Total number of opportunity scans performed',
      labelNames: ['strategy'] as const,
      registers: [this.registry],
    });

    this.rpcRequestsTotal = new promClient.Counter({
      name: 'rpc_requests_total',
      help: 'Total number of RPC requests made',
      labelNames: ['endpoint', 'status'] as const,
      registers: [this.registry],
    });

    this.jitoBundlesTotal = new promClient.Counter({
      name: 'jito_bundles_total',
      help: 'Total number of Jito bundles by outcome',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    // ═══════════════════════════════════════════════
    // HISTOGRAMS
    // ═══════════════════════════════════════════════

    this.tradeProfitSol = new promClient.Histogram({
      name: 'trade_profit_sol',
      help: 'Distribution of trade profits in SOL',
      labelNames: ['strategy'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry],
    });

    this.tradeLatencyMs = new promClient.Histogram({
      name: 'trade_latency_ms',
      help: 'Trade execution latency by phase in milliseconds',
      labelNames: ['strategy', 'phase'] as const,
      buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
      registers: [this.registry],
    });

    // ═══════════════════════════════════════════════
    // GAUGES
    // ═══════════════════════════════════════════════

    this.botBalanceSol = new promClient.Gauge({
      name: 'bot_balance_sol',
      help: 'Current bot wallet balance in SOL',
      registers: [this.registry],
    });

    this.openPositionsCount = new promClient.Gauge({
      name: 'open_positions_count',
      help: 'Number of currently open positions',
      registers: [this.registry],
    });

    this.dailyPnlSol = new promClient.Gauge({
      name: 'daily_pnl_sol',
      help: 'Daily profit and loss in SOL',
      registers: [this.registry],
    });

    this.dailyPnlUsd = new promClient.Gauge({
      name: 'daily_pnl_usd',
      help: 'Daily profit and loss in USD',
      registers: [this.registry],
    });

    this.circuitBreakerStatus = new promClient.Gauge({
      name: 'circuit_breaker_status',
      help: 'Circuit breaker status (0 = normal, 1 = triggered)',
      registers: [this.registry],
    });

    this.consecutiveFailures = new promClient.Gauge({
      name: 'consecutive_failures',
      help: 'Current count of consecutive trade failures',
      registers: [this.registry],
    });

    monitorLog.info('MetricsCollector initialized');
  }

  // ═══════════════════════════════════════════════
  // RECORDING METHODS
  // ═══════════════════════════════════════════════

  recordTrade(
    strategy: string,
    status: 'success' | 'failed' | 'skipped',
    profitSol: number,
    latencyMs: number
  ): void {
    try {
      this.tradesTotal.labels(strategy, status).inc();

      if (status === 'success' && profitSol > 0) {
        this.tradeProfitSol.labels(strategy).observe(profitSol);
      }

      if (latencyMs > 0) {
        this.tradeLatencyMs.labels(strategy, 'execute').observe(latencyMs);
      }
    } catch (error) {
      monitorLog.error({ error, strategy, status }, 'Failed to record trade metric');
    }
  }

  recordScan(strategy: string): void {
    try {
      this.scansTotal.labels(strategy).inc();
    } catch (error) {
      monitorLog.error({ error, strategy }, 'Failed to record scan metric');
    }
  }

  recordRpcCall(endpoint: string, success: boolean): void {
    try {
      this.rpcRequestsTotal.labels(endpoint, success ? 'success' : 'error').inc();
    } catch (error) {
      monitorLog.error({ error, endpoint }, 'Failed to record RPC metric');
    }
  }

  recordJitoBundle(status: 'submitted' | 'landed' | 'failed'): void {
    try {
      this.jitoBundlesTotal.labels(status).inc();
    } catch (error) {
      monitorLog.error({ error, status }, 'Failed to record Jito bundle metric');
    }
  }

  // ═══════════════════════════════════════════════
  // GAUGE UPDATES
  // ═══════════════════════════════════════════════

  updateBalance(sol: number): void {
    try {
      this.botBalanceSol.set(sol);
    } catch (error) {
      monitorLog.error({ error }, 'Failed to update balance metric');
    }
  }

  updatePositions(count: number): void {
    try {
      this.openPositionsCount.set(count);
    } catch (error) {
      monitorLog.error({ error }, 'Failed to update positions metric');
    }
  }

  updateDailyPnL(sol: number, usd: number): void {
    try {
      this.dailyPnlSol.set(sol);
      this.dailyPnlUsd.set(usd);
    } catch (error) {
      monitorLog.error({ error }, 'Failed to update daily PnL metric');
    }
  }

  updateCircuitBreaker(triggered: boolean, failures: number): void {
    try {
      this.circuitBreakerStatus.set(triggered ? 1 : 0);
      this.consecutiveFailures.set(failures);
    } catch (error) {
      monitorLog.error({ error }, 'Failed to update circuit breaker metric');
    }
  }

  // ═══════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════

  async getMetrics(): Promise<string> {
    try {
      return await this.registry.metrics();
    } catch (error) {
      monitorLog.error({ error }, 'Failed to generate Prometheus metrics');
      throw error;
    }
  }

  getRegistry(): promClient.Registry {
    return this.registry;
  }
}
