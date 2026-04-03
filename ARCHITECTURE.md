# Architecture Map

## Entry Points

| File | Purpose |
|------|---------|
| `server.js` | Express backend (803 lines). Old monolithic server with Jupiter quote/swap endpoints, scan loop, and REST API. Being replaced by the engine/ architecture. |

## Engine (src/engine/) — The Active Bot

| File | Purpose | External API Calls |
|------|---------|-------------------|
| `botEngine.ts` | Central orchestrator. Wires strategies, risk manager, executor, WebSocket monitoring. Manages hot path (directSwapBuilder) and warm path (circularScanner). | None directly |
| `keepers.ts` | Background keepers (Phase 2): blockhash (2s), priority fee (10s), WS health (30s), confirmation tracker (500ms batch). Module-level state read by hot path. | Helius RPC `getLatestBlockhash`, `getPriorityFeeEstimate`, `getSignatureStatuses` |
| `config.ts` | Single source of truth for constants: token mints, pool registry, fee constants, risk profiles, Jito tip accounts. Loads .env. | None |
| `connectionManager.ts` | Manages primary/backup RPC connections, wallet, Helius Sender endpoint, priority fee API, failover logic. | Helius RPC, Helius Sender (`sender.helius-rpc.com/fast`), `getPriorityFeeEstimate` |
| `executor.ts` | Executes trades: quoted swaps, atomic arbitrage (Token Ledger), fast atomic (pre-fetched TXs), hot path direct (fire-and-forget). | Jupiter `/swap/v1/quote`, `/swap/v1/swap`, `/swap/v1/swap-instructions`; Helius Sender |
| `directSwapBuilder.ts` | Builds raw Raydium AMM V4 swap instructions from cached pool data. No Jupiter, no SDK. Pure instruction construction for hot path. | None (reads on-chain data at startup via RPC) |
| `circularScanner.ts` | Background Jupiter circular scanner. 4 API keys round-robin. Scans SOL->Token->SOL routes. | Jupiter `/swap/v1/quote` |
| `transactionBuilder.ts` | Builds/combines swap TXs: Token Ledger pattern, CU patching, Jito tip insertion. | Jupiter `/swap/v1/swap-instructions` |
| `poolMonitor.ts` | Enhanced WebSocket pool monitoring. Subscribes to vault accounts, decodes reserves, detects cross-pool spreads. | Helius Enhanced WebSocket (`wss://atlas-mainnet.helius-rpc.com`) |
| `riskManager.ts` | Risk gates: daily loss limit, position limits, circuit breaker, trade size limits. | None |
| `pnlTracker.ts` | Tracks profit/loss per trade and daily aggregates. Persists to database. | None |
| `positionTracker.ts` | Tracks open positions and stuck tokens for recovery. | None |
| `simulator.ts` | Transaction simulation via `simulateTransaction` RPC. Used in warm path, NOT hot path. | Helius RPC `simulateTransaction` |
| `database.ts` | SQLite database for trade history, P&L, stuck tokens, settings. | None |
| `logger.ts` | Pino-based structured logging: engine, execution, data, trade loggers. | None |
| `metrics.ts` | In-memory metrics collector: trade counts, latency, P&L. | None |
| `alertManager.ts` | Telegram/Discord alert notifications for trade events. | Telegram Bot API, Discord Webhooks |
| `tradeJournal.ts` | Detailed trade journaling to database for post-analysis. | None |
| `scanAnalytics.ts` | Scan logging and analytics: opportunity tracking, daily summaries. | None |
| `instructionDecoder.ts` | Decodes swap instructions from various DEX programs. | None |
| `jitoBundleExecutor.ts` | Jito bundle submission (direct to block engine). | Jito Block Engine API |
| `jupiterGate.ts` | Rate-limited Jupiter API wrapper. | Jupiter API |
| `jupiterPool.ts` | Jupiter pool data fetching and caching. | Jupiter API |
| `geyserClient.ts` | Geyser/gRPC client stub. NOT AVAILABLE on current infrastructure — disable. | None (stub) |

## Engine API (src/engine/api/)

| File | Purpose |
|------|---------|
| `routes.ts` | Express REST API: `/api/status`, `/api/start`, `/api/stop`, `/api/wallet/connect`, `/api/config`, `/api/metrics`. Admin token auth. |
| `websocket.ts` | WebSocket broadcaster for real-time dashboard updates. |

## Strategies (src/engine/strategies/)

| File | Purpose | Status |
|------|---------|--------|
| `baseStrategy.ts` | Abstract base class for all strategies. | Active |
| `crossDexArbitrage.ts` | Cross-DEX arbitrage: buy on one DEX, sell on another. PRIMARY strategy. | Active |
| `microArbitrage.ts` | Small rapid trades across many tokens. | Active |
| `backrunStrategy.ts` | Poll-based backrunning after confirmed TX. | Active (needs Geyser for full power) |
| `cyclicArbitrage.ts` | Circular route scanning. | Disabled (duplicates cross-dex) |
| `multiHopArbitrage.ts` | 3-leg arbitrage paths. | Disabled (too many Jupiter calls) |
| `longTailArbitrage.ts` | Long-tail token scanning. | Disabled (consistently negative) |
| `sandwichStrategy.ts` | Sandwich attacks. | Disabled (needs Geyser/mempool) |
| `frontrunStrategy.ts` | Frontrunning. | Disabled (needs Geyser/mempool) |
| `jitLiquidityStrategy.ts` | JIT liquidity provision. | Disabled (needs Geyser) |
| `liquidationStrategy.ts` | Liquidation monitoring. | Stub only |

## Sniping (src/engine/sniping/)

| File | Purpose |
|------|---------|
| `snipingStrategy.ts` | New pool detection and execution. |
| `poolDetector.ts` | Detects new Raydium/Orca pool creation. |
| `snipeExecutor.ts` | Executes snipe trades on new pools. |
| `tokenSafetyFilter.ts` | Token safety checks (honeypot, rug pull detection). |

## Frontend (src/components/, src/pages/, src/hooks/) — React Dashboard

Legacy React frontend. Not part of the trading engine. 60+ UI component files.
The dashboard connects to the Express API for status/control.

## Services (src/services/) — Legacy/Duplicate

40+ service files from earlier development iterations. Most are superseded by the engine/ architecture.
Many are duplicates or unused (e.g., multiple Jupiter service implementations, CORS proxy services, Supabase client).
These should NOT be used for new development — all active trading logic is in engine/.

## Config (src/config/)

| File | Purpose |
|------|---------|
| `riskProfiles.ts` | Risk profile definitions (conservative/balanced/aggressive). |
| `topTokens.ts` | Token list with mints and metadata. |
| `tradingConfig.ts` | Trading configuration constants. |

## External API Endpoints Used

| API | Endpoint | Used By | Credits |
|-----|----------|---------|---------|
| Helius RPC | `https://mainnet.helius-rpc.com/?api-key=KEY` | connectionManager | 1/call |
| Helius Enhanced WS | `wss://atlas-mainnet.helius-rpc.com/?api-key=KEY` | poolMonitor | 2/0.1MB |
| Helius Sender | `https://sender.helius-rpc.com/fast?api-key=KEY` | connectionManager | 0 |
| Helius Priority Fee | `getPriorityFeeEstimate` (via RPC) | connectionManager | 1 |
| Jupiter Quote | `https://api.jup.ag/swap/v1/quote` | executor, circularScanner | Free (rate limited) |
| Jupiter Swap | `https://api.jup.ag/swap/v1/swap` | executor | Free |
| Jupiter Swap Instructions | `https://api.jup.ag/swap/v1/swap-instructions` | transactionBuilder | Free |
| Jito Block Engine | `https://mainnet.block-engine.jito.wtf` | jitoBundleExecutor | Free |
| Telegram | `https://api.telegram.org/bot{token}` | alertManager | Free |

## Key Data Flow

```
WebSocket (Eye 1)                    Jupiter Scanner (Eye 2)
     |                                        |
  pool update                           circular quote
     |                                        |
  decode reserves                       profit check
     |                                        |
  spread detection                      opportunity found
     |                                        |
     +-----------> Risk Gates <--------------+
                       |
              [cost, risk, validate]
                       |
            +----------+----------+
            |                     |
       HOT PATH              WARM PATH
    (directSwapBuilder)    (Jupiter /swap)
            |                     |
       build raw IX           build Jupiter TX
            |                     |
       sign + send            sign + send
            |                     |
       Helius Sender          Helius Sender
            |                     |
       Confirmation Tracker (background)
```
