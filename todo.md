# Production Solana Sandwich Bot - Real Trading System

## Core Files to Create (8 files maximum)

### 1. Services Layer (4 files)
- `src/services/realJupiterService.ts` - Real Jupiter API integration with authentication fixes
- `src/services/advancedMEVScanner.ts` - Enhanced MEV detection beyond arbitrage
- `src/services/realProfitEngine.ts` - Production profit calculation with real fees
- `src/services/productionWalletManager.ts` - Secure wallet integration for real trading

### 2. Components Layer (3 files)
- `src/components/ProductionTradingDashboard.tsx` - Main trading interface
- `src/components/RealMEVOpportunities.tsx` - Live MEV opportunity display
- `src/components/TradingControls.tsx` - Real trade execution controls

### 3. Main Application (1 file)
- `src/pages/Index.tsx` - Updated main page with production dashboard

## Key Features Implementation
✅ **NO MOCK DATA** - All real trading functionality
✅ **Fixed Authentication** - Proper JWT handling for Supabase
✅ **Enhanced MEV Detection** - Sandwich, arbitrage, liquidation opportunities
✅ **Real Profit Calculation** - Accurate fees, gas optimization
✅ **Production Risk Management** - Circuit breakers, position sizing
✅ **Multi-DEX Integration** - Jupiter, Raydium, Orca routing
✅ **Live Mempool Scanning** - Real-time transaction monitoring

## Minimum Profit Thresholds
- Sandwich Opportunities: $0.05+ (increased from $0.005)
- Arbitrage: $0.02+ minimum
- Liquidation: $0.10+ minimum
- All calculations include real gas fees and slippage

## Trading Pairs (14 pairs optimized)
SOL/USDC, SOL/USDT, SOL/JUP, SOL/BONK, SOL/WIF, SOL/POPCAT, USDC/USDT, and reverse pairs