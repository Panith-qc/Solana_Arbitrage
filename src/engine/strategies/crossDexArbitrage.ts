// CROSS-DEX ARBITRAGE — Raydium-First Scanner
//
// Strategy: Buy on Raydium (FREE API, 300/min) → Sell via Jupiter aggregator.
// This is TRUE cross-DEX arbitrage: Raydium pool price vs aggregator best-route.
//
// Scan flow (per cycle, ~15-20s):
//   1. Raydium buy quotes for ALL tokens (FREE, parallel) → get token amounts
//   2. Jupiter sell quotes for top candidates (1 call each) → get SOL back
//   3. If Raydium-buy + Jupiter-sell > input SOL + fees → EXECUTE
//
// Why this works: Raydium pools can lag behind aggregator pricing.
// When Raydium gives you MORE tokens per SOL than the market average,
// selling those tokens through Jupiter (which finds the best exit route)
// captures the spread.

import crypto from 'crypto';
import { BaseStrategy, Opportunity, StrategyConfig } from './baseStrategy.js';
import { strategyLog } from '../logger.js';
import {
  SOL_MINT,
  LAMPORTS_PER_SOL,
  SCAN_TOKENS,
  TokenInfo,
  BotConfig,
  RiskProfile,
  USDC_MINT,
  BASE_GAS_LAMPORTS,
  PRIORITY_FEE_LAMPORTS,
  JITO_TIP_LAMPORTS,
  TWO_LEG_FEE_LAMPORTS,
} from '../config.js';
import { ConnectionManager } from '../connectionManager.js';

const ALL_TOKENS = SCAN_TOKENS.filter(t => t.mint !== SOL_MINT && t.mint !== USDC_MINT);
const QUOTE_LIFETIME_MS = 5_000;   // with immediate await execution, quotes are used within 0-2s
const EXECUTION_SAFETY_BUFFER_BPS = 0;

// Raydium API — free tier, 300 req/min, completely separate from Jupiter quota
const RAYDIUM_BATCH_SIZE = 5;
const RAYDIUM_BATCH_DELAY_MS = 200;

// Multiple scan amounts — smaller sizes see less price impact and find micro-spreads
// Profits were found at 0.5 SOL; 5-10 SOL competed with pro bots on deeper liquidity
// Only scan amounts where profits were actually found (RAY@0.5 and RAY@2)
// Fewer amounts = faster cycle = fresher quotes when profitable
const SCAN_AMOUNTS_SOL = [0.5, 1];

// Reduced to 3 — only the best candidates get Jupiter calls, saves ~500ms per scan
const MAX_JUPITER_CANDIDATES = 3;

// Phase 0 filter: skip tokens worse than this on Raydium round-trip
const RAYDIUM_PREFILTER_BPS = -15;

// Hot tokens — near-profitable tokens from the last scan
interface HotToken {
  token: TokenInfo;
  lastSpreadBps: number;
  raydiumBuyAmount: string;
  lastCheckedMs: number;
}
const HOT_TOKEN_THRESHOLD_BPS = -5;
const MAX_HOT_TOKENS = 5;
const HOT_TOKEN_RECHECK_MS = 3_000;

interface DexQuote {
  source: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  pricePerToken: number;
  raw: any;
}

export class CrossDexArbitrageStrategy extends BaseStrategy {
  private connectionManager: ConnectionManager;
  private botConfig: BotConfig;
  private riskProfile: RiskProfile;
  private lastJupiterCallMs: number = 0;
  private hotTokens: HotToken[] = [];

  constructor(connectionManager: ConnectionManager, config: BotConfig, riskProfile: RiskProfile) {
    const strategyConfig: StrategyConfig = {
      name: 'cross-dex-arbitrage',
      enabled: riskProfile.strategies.crossDexArbitrage,
      scanIntervalMs: 3_000,
      minProfitUsd: 0,  // ANY positive net profit triggers execution (Jito atomic = safe)
      maxPositionSol: riskProfile.maxPositionSol,
      slippageBps: riskProfile.slippageBps,
    };
    super(strategyConfig);

    this.connectionManager = connectionManager;
    this.botConfig = config;
    this.riskProfile = riskProfile;
  }

  getName(): string {
    return 'Cross-DEX Arbitrage';
  }

  async scan(): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    this.scanCount++;
    const opportunities: Opportunity[] = [];

    strategyLog.info(
      { tokens: ALL_TOKENS.length, amounts: SCAN_AMOUNTS_SOL, scan: this.scanCount },
      'Raydium-first scan starting',
    );

    for (const scanSol of SCAN_AMOUNTS_SOL) {
      const scanAmountStr = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL)).toString();
      const scanAmountLamports = BigInt(scanAmountStr);
      const inputLamports = parseFloat(scanAmountStr);

      // ── STEP 1: Raydium buy ALL tokens (FREE, parallel) ──────────────────
      const raydiumBuys = await this.raydiumBulkBuy(scanAmountStr);

      strategyLog.info(
        { scanSol, total: ALL_TOKENS.length, priced: raydiumBuys.size },
        `Raydium buy quotes: ${raydiumBuys.size}/${ALL_TOKENS.length} tokens`,
      );

      // ── STEP 2: Rank by Raydium round-trip to find best candidates ───────
      // Get Raydium sell quotes too (FREE) to estimate which tokens have spreads
      // PARALLEL: Raydium is free (300/min) — fetch all sell quotes at once instead of sequential
      const ranked: { token: TokenInfo; buyQuote: DexQuote; raydiumRoundTripBps: number }[] = [];

      const tokensWithBuys = ALL_TOKENS.filter(t => raydiumBuys.has(t.mint));
      const sellResults = await Promise.all(
        tokensWithBuys.map(async (token) => {
          const buyQuote = raydiumBuys.get(token.mint)!;
          const sellQuote = await this.getRaydiumSwapQuote(token.mint, SOL_MINT, buyQuote.outputAmount);
          return { token, buyQuote, sellQuote };
        }),
      );

      for (const { token, buyQuote, sellQuote } of sellResults) {
        let roundTripBps = -100;
        if (sellQuote) {
          const outputLamports = parseFloat(sellQuote.outputAmount);
          roundTripBps = ((outputLamports - inputLamports) / inputLamports) * 10_000;
        }

        this.onScanResult?.({
          strategy: this.name,
          token: `${token.symbol}@${scanSol} (ray)`,
          spreadBps: roundTripBps,
          grossProfitSol: sellQuote ? (parseFloat(sellQuote.outputAmount) - inputLamports) / LAMPORTS_PER_SOL : 0,
          netProfitUsd: 0,
          fees: 0,
          profitable: false,
        });

        if (roundTripBps > RAYDIUM_PREFILTER_BPS) {
          ranked.push({ token, buyQuote, raydiumRoundTripBps: roundTripBps });
        }
      }

      // Sort best first
      ranked.sort((a, b) => b.raydiumRoundTripBps - a.raydiumRoundTripBps);

      strategyLog.info(
        {
          scanSol,
          candidates: ranked.slice(0, MAX_JUPITER_CANDIDATES)
            .map(r => `${r.token.symbol}(ray:${r.raydiumRoundTripBps.toFixed(1)}bps)`).join(', '),
        },
        `Top candidates for Jupiter sell: ${Math.min(ranked.length, MAX_JUPITER_CANDIDATES)}`,
      );

      // ── STEP 3: Jupiter sell for top candidates (1 call each) ────────────
      // This is the KEY cross-DEX check: Raydium buy price vs Jupiter sell price
      const hotCandidates: { token: TokenInfo; spreadBps: number; raydiumBuyAmount: string }[] = [];

      for (const candidate of ranked.slice(0, MAX_JUPITER_CANDIDATES)) {
        const { token, buyQuote } = candidate;

        await this.jupiterRateLimit();
        const jupSell = await this.getJupiterQuote(
          token.mint, SOL_MINT, buyQuote.outputAmount, this.config.slippageBps,
        );

        if (!jupSell) {
          strategyLog.debug({ token: token.symbol }, 'No Jupiter sell quote');
          continue;
        }

        // Cross-DEX spread: Raydium buy + Jupiter sell
        const outputLamports = parseFloat(jupSell.outputAmount);
        const spreadBps = ((outputLamports - inputLamports) / inputLamports) * 10_000;
        const profitAnalysis = this.calculateProfit(scanAmountLamports, BigInt(jupSell.outputAmount));

        this.onScanResult?.({
          strategy: this.name,
          token: `${token.symbol}@${scanSol} (ray→jup)`,
          spreadBps,
          grossProfitSol: profitAnalysis.grossProfitSol,
          netProfitUsd: profitAnalysis.netProfitUsd,
          fees: profitAnalysis.totalFeeSol,
          profitable: profitAnalysis.netProfitUsd > 0,
        });

        const emoji = profitAnalysis.grossProfitSol > 0 ? '🟢' : '🔴';
        strategyLog.info(
          {
            token: token.symbol, sol: scanSol,
            spreadBps: spreadBps.toFixed(1),
            grossSol: profitAnalysis.grossProfitSol.toFixed(6),
            netUsd: profitAnalysis.netProfitUsd.toFixed(4),
            fees: profitAnalysis.totalFeeSol.toFixed(6),
          },
          `${emoji} ${token.symbol}@${scanSol} ray→jup ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
        );

        // Track for hot tokens
        hotCandidates.push({ token, spreadBps, raydiumBuyAmount: buyQuote.outputAmount });

        // PROFITABLE? Use the quotes we already have — NO re-verify (saves ~1s)
        // The executor's profitability sanity check protects against stale quotes
        if (profitAnalysis.netProfitUsd > 0) {
          strategyLog.warn(
            { token: token.symbol, netUsd: profitAnalysis.netProfitUsd.toFixed(4), spreadBps: spreadBps.toFixed(1) },
            `🚀 PROFITABLE: ${token.symbol} ray→jup — fetching swap TXs NOW`,
          );

          // Use the existing Raydium buy quote as forward, Jupiter sell as reverse
          // Skip the re-quote+re-verify cycle (was 2 extra Jupiter calls = ~1s wasted)
          // We already have: buyQuote (Raydium) and jupSell (Jupiter)
          // Need Jupiter buy quote for the swap TX (1 call)
          await this.jupiterRateLimit();
          const jupBuy = await this.getJupiterQuote(
            SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps,
          );
          if (!jupBuy?.raw?.routePlan) continue;

          // Fetch swap TXs using jupBuy + existing jupSell (skip re-verify sell)
          const swapTxs = await this.fetchSwapTxPair(jupBuy.raw, jupSell.raw);

          const now = Date.now();
          const opp = this.buildOpportunity(
            token, scanSol, scanAmountLamports, jupBuy, jupSell, profitAnalysis, spreadBps, now,
          );

          // Attach pre-fetched swap TXs so executor skips the re-quote cycle
          if (swapTxs) {
            opp.metadata.forwardSwapTx = swapTxs.forwardSwapTx;
            opp.metadata.reverseSwapTx = swapTxs.reverseSwapTx;
            opp.metadata.forwardQuote = jupBuy.raw;
            opp.metadata.reverseQuote = jupSell.raw;
            opp.metadata.scanTimestamp = now;
            strategyLog.info({ token: token.symbol }, 'FAST PATH: Swap TXs pre-fetched');
          }

          // IMMEDIATE EXECUTE: Don't wait for scan to finish — quotes expire
          if (this.onImmediateExecute) {
            strategyLog.info({ token: token.symbol, netUsd: profitAnalysis.netProfitUsd.toFixed(4) },
              `⚡ IMMEDIATE: Executing ${token.symbol} NOW`);
            await this.onImmediateExecute(opp);
          }
          opportunities.push(opp);
        }
      }

      // Update hot tokens
      this.updateHotTokens(hotCandidates);
    }

    // ── HOT TOKEN FAST RE-CHECK ──────────────────────────────────────────
    if (opportunities.length === 0 && this.hotTokens.length > 0) {
      strategyLog.info(
        { hotTokens: this.hotTokens.map(h => `${h.token.symbol}(${h.lastSpreadBps.toFixed(1)}bps)`).join(', ') },
        `Fast re-checking ${this.hotTokens.length} hot tokens`,
      );
      const hotOpps = await this.scanHotTokens();
      opportunities.push(...hotOpps);
    }

    strategyLog.info(
      { found: opportunities.length, scanCount: this.scanCount, hotTokens: this.hotTokens.length },
      `Scan complete — ${opportunities.length} profitable`,
    );

    return opportunities;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TARGETED SINGLE-TOKEN SCAN (called by WebSocket pool change handler)
  // Scans only 1 token instead of all — runs in ~1-2s instead of ~8-10s
  // ────────────────────────────────────────────────────────────────────────────

  async scanSingleToken(token: TokenInfo): Promise<Opportunity[]> {
    if (!this.isActive()) return [];

    const opportunities: Opportunity[] = [];

    strategyLog.info(
      { token: token.symbol, trigger: 'websocket' },
      `⚡ WebSocket-triggered scan for ${token.symbol}`,
    );

    for (const scanSol of SCAN_AMOUNTS_SOL) {
      const scanAmountStr = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL)).toString();
      const scanAmountLamports = BigInt(scanAmountStr);
      const inputLamports = parseFloat(scanAmountStr);

      // Raydium buy quote (FREE)
      const buyQuote = await this.getRaydiumSwapQuote(SOL_MINT, token.mint, scanAmountStr);
      if (!buyQuote) continue;

      // Jupiter sell quote (1 call)
      await this.jupiterRateLimit();
      const jupSell = await this.getJupiterQuote(
        token.mint, SOL_MINT, buyQuote.outputAmount, this.config.slippageBps,
      );
      if (!jupSell) continue;

      const outputLamports = parseFloat(jupSell.outputAmount);
      const spreadBps = ((outputLamports - inputLamports) / inputLamports) * 10_000;
      const profitAnalysis = this.calculateProfit(scanAmountLamports, BigInt(jupSell.outputAmount));

      this.onScanResult?.({
        strategy: this.name,
        token: `${token.symbol}@${scanSol} (ws→ray→jup)`,
        spreadBps,
        grossProfitSol: profitAnalysis.grossProfitSol,
        netProfitUsd: profitAnalysis.netProfitUsd,
        fees: profitAnalysis.totalFeeSol,
        profitable: profitAnalysis.netProfitUsd > 0,
      });

      strategyLog.info(
        {
          token: token.symbol, sol: scanSol, spreadBps: spreadBps.toFixed(1),
          netUsd: profitAnalysis.netProfitUsd.toFixed(4), trigger: 'websocket',
        },
        `⚡ WS ${token.symbol}@${scanSol} ray→jup ${spreadBps.toFixed(1)}bps | net $${profitAnalysis.netProfitUsd.toFixed(4)}`,
      );

      if (profitAnalysis.netProfitUsd > 0) {
        strategyLog.warn(
          { token: token.symbol, netUsd: profitAnalysis.netProfitUsd.toFixed(4) },
          `⚡ WS PROFITABLE: ${token.symbol} — fetching swap TXs NOW`,
        );

        // Jupiter buy quote for swap TX (1 call)
        await this.jupiterRateLimit();
        const jupBuy = await this.getJupiterQuote(
          SOL_MINT, token.mint, scanAmountStr, this.config.slippageBps,
        );
        if (!jupBuy?.raw?.routePlan) continue;

        // Pre-fetch swap TXs
        const swapTxs = await this.fetchSwapTxPair(jupBuy.raw, jupSell.raw);
        const now = Date.now();
        const opp = this.buildOpportunity(
          token, scanSol, scanAmountLamports, jupBuy, jupSell, profitAnalysis, spreadBps, now,
        );

        if (swapTxs) {
          opp.metadata.forwardSwapTx = swapTxs.forwardSwapTx;
          opp.metadata.reverseSwapTx = swapTxs.reverseSwapTx;
          opp.metadata.forwardQuote = jupBuy.raw;
          opp.metadata.reverseQuote = jupSell.raw;
          opp.metadata.scanTimestamp = now;
          opp.metadata.wsTriggered = true;
          strategyLog.info({ token: token.symbol }, '⚡ WS FAST PATH: Swap TXs pre-fetched');
        }

        if (this.onImmediateExecute) {
          await this.onImmediateExecute(opp);
        }
        opportunities.push(opp);
      }
    }

    return opportunities;
  }

  private buildOpportunity(
    token: TokenInfo, scanSol: number, scanAmountLamports: bigint,
    buyQuote: DexQuote, sellQuote: DexQuote,
    profitAnalysis: ReturnType<typeof this.calculateProfit>,
    spreadBps: number, now: number,
  ): Opportunity {
    return {
      id: crypto.randomUUID(),
      strategy: this.name,
      tokenPath: ['SOL', token.symbol, 'SOL'],
      mintPath: [SOL_MINT, token.mint, SOL_MINT],
      inputAmountLamports: scanAmountLamports,
      expectedOutputLamports: BigInt(sellQuote.outputAmount),
      expectedProfitSol: profitAnalysis.netProfitSol,
      expectedProfitUsd: profitAnalysis.netProfitUsd,
      confidence: this.estimateConfidence(profitAnalysis),
      quotes: [buyQuote.raw, sellQuote.raw],
      metadata: {
        token: token.symbol,
        scanAmountSol: scanSol,
        buySource: buyQuote.source,
        sellSource: 'aggregator',
        buyAmount: buyQuote.outputAmount,
        sellAmount: sellQuote.outputAmount,
        spreadBps,
        feeBreakdown: profitAnalysis.feeBreakdown,
      },
      timestamp: now,
      expiresAt: now + QUOTE_LIFETIME_MS,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // HOT TOKEN FAST RE-CHECK (only 1 Jupiter call per token)
  // Buy on Raydium (FREE), sell on Jupiter (1 call)
  // ────────────────────────────────────────────────────────────────────────────

  private async scanHotTokens(): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];
    const scanSol = SCAN_AMOUNTS_SOL[0];
    const scanAmountStr = BigInt(Math.round(scanSol * LAMPORTS_PER_SOL)).toString();
    const scanAmountLamports = BigInt(scanAmountStr);
    const inputLamports = parseFloat(scanAmountStr);

    for (const hot of this.hotTokens) {
      const now = Date.now();
      if (now - hot.lastCheckedMs < HOT_TOKEN_RECHECK_MS) continue;
      hot.lastCheckedMs = now;

      try {
        // Fresh Raydium buy (FREE)
        const rayBuy = await this.getRaydiumSwapQuote(SOL_MINT, hot.token.mint, scanAmountStr);
        if (!rayBuy) continue;

        // Jupiter sell (1 call)
        await this.jupiterRateLimit();
        const jupSell = await this.getJupiterQuote(
          hot.token.mint, SOL_MINT, rayBuy.outputAmount, this.config.slippageBps,
        );
        if (!jupSell) continue;

        const outputLamports = parseFloat(jupSell.outputAmount);
        const spreadBps = ((outputLamports - inputLamports) / inputLamports) * 10_000;
        hot.lastSpreadBps = spreadBps;
        hot.raydiumBuyAmount = rayBuy.outputAmount;

        const profitAnalysis = this.calculateProfit(scanAmountLamports, BigInt(jupSell.outputAmount));

        this.onScanResult?.({
          strategy: this.name,
          token: `${hot.token.symbol}@${scanSol} (HOT)`,
          spreadBps,
          grossProfitSol: profitAnalysis.grossProfitSol,
          netProfitUsd: profitAnalysis.netProfitUsd,
          fees: profitAnalysis.totalFeeSol,
          profitable: profitAnalysis.netProfitUsd > 0,
        });

        strategyLog.info(
          { token: hot.token.symbol, spreadBps: spreadBps.toFixed(1), netUsd: profitAnalysis.netProfitUsd.toFixed(4) },
          `HOT re-check: ${hot.token.symbol} ${spreadBps.toFixed(1)}bps`,
        );

        if (profitAnalysis.netProfitUsd > 0) {
          strategyLog.warn(
            { token: hot.token.symbol, netUsd: profitAnalysis.netProfitUsd.toFixed(4), spreadBps: spreadBps.toFixed(1) },
            `🚀 HOT TOKEN PROFITABLE: ${hot.token.symbol} — fetching swap TXs`,
          );

          // Get Jupiter buy quote (1 call) — skip re-verify sell (saves ~1s)
          // The executor's profitability sanity check protects against stale quotes
          await this.jupiterRateLimit();
          const jupBuy = await this.getJupiterQuote(
            SOL_MINT, hot.token.mint, scanAmountStr, this.config.slippageBps,
          );
          if (!jupBuy?.raw?.routePlan) continue;

          // Pre-fetch swap TXs using jupBuy + existing jupSell (skip re-verify)
          const swapTxs = await this.fetchSwapTxPair(jupBuy.raw, jupSell.raw);
          const opp = this.buildOpportunity(
            hot.token, scanSol, scanAmountLamports, jupBuy, jupSell, profitAnalysis, spreadBps, Date.now(),
          );
          if (swapTxs) {
            opp.metadata.forwardSwapTx = swapTxs.forwardSwapTx;
            opp.metadata.reverseSwapTx = swapTxs.reverseSwapTx;
            opp.metadata.forwardQuote = jupBuy.raw;
            opp.metadata.reverseQuote = jupSell.raw;
            opp.metadata.scanTimestamp = Date.now();
          }
          if (this.onImmediateExecute) {
            await this.onImmediateExecute(opp);
          }
          opportunities.push(opp);
        }
      } catch (err) {
        strategyLog.debug({ err, token: hot.token.symbol }, 'Hot token re-check error');
      }
    }

    return opportunities;
  }

  private updateHotTokens(candidates: { token: TokenInfo; spreadBps: number; raydiumBuyAmount: string }[]): void {
    const nearProfitable = candidates
      .filter(c => c.spreadBps > HOT_TOKEN_THRESHOLD_BPS && c.spreadBps < 0)
      .sort((a, b) => b.spreadBps - a.spreadBps)
      .slice(0, MAX_HOT_TOKENS);

    this.hotTokens = nearProfitable.map(c => ({
      token: c.token,
      lastSpreadBps: c.spreadBps,
      raydiumBuyAmount: c.raydiumBuyAmount,
      lastCheckedMs: Date.now(),
    }));

    if (this.hotTokens.length > 0) {
      strategyLog.info(
        { hotTokens: this.hotTokens.map(h => `${h.token.symbol}(${h.lastSpreadBps.toFixed(1)}bps)`).join(', ') },
        `Updated hot token list: ${this.hotTokens.length} tokens near breakeven`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RAYDIUM BULK BUY (FREE, parallel — 300/min)
  // ────────────────────────────────────────────────────────────────────────────

  private async raydiumBulkBuy(scanAmountStr: string): Promise<Map<string, DexQuote>> {
    const results = new Map<string, DexQuote>();

    for (let i = 0; i < ALL_TOKENS.length; i += RAYDIUM_BATCH_SIZE) {
      const batch = ALL_TOKENS.slice(i, i + RAYDIUM_BATCH_SIZE);

      const promises = batch.map(async (token) => {
        try {
          const quote = await this.getRaydiumSwapQuote(SOL_MINT, token.mint, scanAmountStr);
          if (quote) {
            results.set(token.mint, quote);
          }
        } catch (err) {
          strategyLog.debug({ err, token: token.symbol }, 'Raydium buy error');
        }
      });

      await Promise.all(promises);

      if (i + RAYDIUM_BATCH_SIZE < ALL_TOKENS.length) {
        await new Promise(r => setTimeout(r, RAYDIUM_BATCH_DELAY_MS));
      }
    }

    return results;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // JUPITER QUOTES
  // ────────────────────────────────────────────────────────────────────────────

  private async getJupiterQuote(
    inputMint: string, outputMint: string, amount: string, slippageBps: number,
  ): Promise<DexQuote | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());

    try {
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });

      if (!response.ok) {
        if (response.status === 429) {
          strategyLog.warn('Jupiter 429 — 5s backoff');
          await new Promise(r => setTimeout(r, 5000));
        }
        return null;
      }

      const data = await response.json();
      if (!data.outAmount) return null;

      return {
        source: 'aggregator', inputMint, outputMint, inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: parseFloat(data.outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch {
      return null;
    }
  }

  private async getJupiterDexQuote(
    inputMint: string, outputMint: string, amount: string,
    slippageBps: number, dexes: string,
  ): Promise<DexQuote | null> {
    const url = new URL(`${this.botConfig.jupiterApiUrl}/swap/v1/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amount);
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('dexes', dexes);

    try {
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });

      if (!response.ok) {
        if (response.status === 429) {
          strategyLog.warn({ dexes }, 'Jupiter 429 — 5s backoff');
          await new Promise(r => setTimeout(r, 5000));
        }
        return null;
      }

      const data = await response.json();
      if (!data.outAmount) return null;

      return {
        source: dexes, inputMint, outputMint, inputAmount: amount,
        outputAmount: data.outAmount,
        pricePerToken: parseFloat(data.outAmount) / parseFloat(amount),
        raw: data,
      };
    } catch {
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RAYDIUM DIRECT API — free, 300/min, separate quota
  // ────────────────────────────────────────────────────────────────────────────

  private async getRaydiumSwapQuote(
    inputMint: string, outputMint: string, amount: string,
  ): Promise<DexQuote | null> {
    for (const baseUrl of [
      'https://transaction-v1.raydium.io',
      'https://api-v3.raydium.io',
    ]) {
      try {
        const url = `${baseUrl}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.config.slippageBps}&txVersion=V0`;
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });

        if (!response.ok) continue;

        const data = await response.json();
        const outAmount = data.data?.outputAmount || data.data?.outAmount;
        if (!outAmount) continue;

        return {
          source: 'raydium-direct',
          inputMint, outputMint, inputAmount: amount,
          outputAmount: String(outAmount),
          pricePerToken: parseFloat(String(outAmount)) / parseFloat(amount),
          raw: data,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SWAP TX PRE-FETCH (for fast execution path)
  // ────────────────────────────────────────────────────────────────────────────

  private async fetchSwapTxPair(
    forwardQuote: any, reverseQuote: any,
  ): Promise<{ forwardSwapTx: string; reverseSwapTx: string } | null> {
    try {
      const walletPubkey = this.connectionManager.getPublicKey().toString();
      const swapUrl = `${this.botConfig.jupiterApiUrl}/swap/v1/swap`;

      const makeBody = (quote: any) => ({
        quoteResponse: quote,
        userPublicKey: walletPubkey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS,
      });

      // Fetch both swap TXs — sequential to respect rate limit
      await this.jupiterRateLimit();
      const fwdResp = await fetch(swapUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody(forwardQuote)),
        signal: AbortSignal.timeout(10000),
      });
      if (!fwdResp.ok) {
        strategyLog.warn({ status: fwdResp.status }, 'Failed to fetch forward swap TX');
        return null;
      }
      const fwdData = await fwdResp.json();

      await this.jupiterRateLimit();
      const revResp = await fetch(swapUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeBody(reverseQuote)),
        signal: AbortSignal.timeout(10000),
      });
      if (!revResp.ok) {
        strategyLog.warn({ status: revResp.status }, 'Failed to fetch reverse swap TX');
        return null;
      }
      const revData = await revResp.json();

      if (!fwdData.swapTransaction || !revData.swapTransaction) return null;

      return {
        forwardSwapTx: fwdData.swapTransaction,
        reverseSwapTx: revData.swapTransaction,
      };
    } catch (err) {
      strategyLog.warn({ err }, 'Failed to pre-fetch swap TX pair');
      return null;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // PROFIT CALCULATION
  // ────────────────────────────────────────────────────────────────────────────

  private calculateProfit(
    inputLamports: bigint, outputLamports: bigint,
  ): {
    grossProfitSol: number; netProfitSol: number; netProfitUsd: number;
    totalFeeSol: number; feeBreakdown: Record<string, number>;
  } {
    const inputSol = Number(inputLamports) / LAMPORTS_PER_SOL;
    const outputSol = Number(outputLamports) / LAMPORTS_PER_SOL;
    const grossProfitSol = outputSol - inputSol;

    // Single atomic TX: 1 signature (5,000) + priority fee (10,000) = 15,000 lamports
    // No Jito tip needed — sent via Helius staked connection
    const totalFeeSol = TWO_LEG_FEE_LAMPORTS / LAMPORTS_PER_SOL;
    const netProfitSol = grossProfitSol - totalFeeSol;

    const solPriceUsd = this.botConfig.solPriceUsd;
    if (!solPriceUsd || solPriceUsd <= 0) {
      return {
        grossProfitSol, netProfitSol: -1, netProfitUsd: -1, totalFeeSol,
        feeBreakdown: { totalFee: TWO_LEG_FEE_LAMPORTS / LAMPORTS_PER_SOL },
      };
    }

    return {
      grossProfitSol,
      netProfitSol,
      netProfitUsd: netProfitSol * solPriceUsd,
      totalFeeSol,
      feeBreakdown: { totalFee: TWO_LEG_FEE_LAMPORTS / LAMPORTS_PER_SOL },
    };
  }

  private estimateConfidence(p: { netProfitSol: number; totalFeeSol: number }): number {
    if (p.netProfitSol <= 0) return 0;
    return parseFloat(Math.min(0.90, Math.max(0.05, p.netProfitSol / p.totalFeeSol / 3)).toFixed(4));
  }

  private async jupiterRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastJupiterCallMs;
    const minDelay = Math.max(1000, Math.ceil(1_000 / this.botConfig.maxRequestsPerSecond));
    if (elapsed < minDelay) {
      await new Promise(r => setTimeout(r, minDelay - elapsed));
    }
    this.lastJupiterCallMs = Date.now();
  }
}
