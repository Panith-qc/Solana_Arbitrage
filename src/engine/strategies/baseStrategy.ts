// BASE STRATEGY
// Abstract base class and shared interfaces for all MEV strategies.
// Every strategy extends BaseStrategy and implements scan() + getName().

import crypto from 'crypto';

export interface Opportunity {
  id: string;
  strategy: string;
  tokenPath: string[];       // e.g. ['SOL', 'BONK', 'SOL']
  mintPath: string[];        // mint addresses for each leg
  inputAmountLamports: bigint;
  expectedOutputLamports: bigint;
  expectedProfitSol: number;
  expectedProfitUsd: number;
  confidence: number;        // 0-1
  quotes: any[];             // Jupiter quote responses for each leg
  metadata: Record<string, any>;
  timestamp: number;
  expiresAt: number;         // opportunity expires (quotes go stale)
}

export interface StrategyConfig {
  name: string;
  enabled: boolean;
  scanIntervalMs: number;
  minProfitUsd: number;
  maxPositionSol: number;
  slippageBps: number;
}

export abstract class BaseStrategy {
  name: string;
  config: StrategyConfig;
  protected isRunning: boolean = false;
  protected scanCount: number = 0;
  protected opportunitiesFound: number = 0;

  constructor(config: StrategyConfig) {
    this.name = config.name;
    this.config = config;
  }

  /** Scan for opportunities. Poll-based strategies return results; event-driven return []. */
  abstract scan(): Promise<Opportunity[]>;

  /** Human-readable strategy name. */
  abstract getName(): string;

  /** Mark strategy as active. */
  start(): void {
    this.isRunning = true;
  }

  /** Mark strategy as inactive. */
  stop(): void {
    this.isRunning = false;
  }

  /** Whether the strategy should be scanned. */
  isActive(): boolean {
    return this.isRunning && this.config.enabled;
  }

  /** Return current runtime statistics. */
  getStats(): { name: string; scanCount: number; opportunitiesFound: number; isRunning: boolean } {
    return {
      name: this.name,
      scanCount: this.scanCount,
      opportunitiesFound: this.opportunitiesFound,
      isRunning: this.isRunning,
    };
  }

  /** Generate a unique opportunity ID. */
  protected generateId(): string {
    return crypto.randomUUID();
  }
}
