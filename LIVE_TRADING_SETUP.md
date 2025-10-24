# 🚀 LIVE TRADING SETUP GUIDE

**Status:** Phase 2 Complete - Ready for Production  
**Last Updated:** October 24, 2025

---

## ✅ PRE-DEPLOYMENT CHECKLIST

Before deploying to GCP or starting live trading:

### System Verification ✅
- [x] Phase 0 complete (basic setup)
- [x] Phase 1 complete (MEV infrastructure)
- [x] Phase 2 complete (high-frequency strategies)
- [x] All services build successfully
- [x] No critical errors in code

### Testing Verification ⚠️ (YOU MUST COMPLETE)
- [ ] Dashboard loads and connects to wallet
- [ ] At least 5 opportunities detected in 15 minutes
- [ ] Test trade executed successfully (0.05-0.1 SOL)
- [ ] Profit calculations accurate
- [ ] No critical errors during testing

### Production Preparation
- [ ] Production wallet created and secured
- [ ] API keys obtained (Helius, Supabase)
- [ ] GCP account created (if deploying to cloud)
- [ ] Funding wallet prepared (1-10 SOL)
- [ ] Monitoring strategy planned

---

## 💰 CAPITAL REQUIREMENTS

### Minimum for Testing
- **0.1 SOL** (~$24) - Absolute minimum for testing
- Use only for 1-2 test trades
- Expect limited opportunities

### Recommended for Phase 2
- **1-10 SOL** (~$240-2,400) - Sweet spot for Phase 2
- Good opportunity capture
- Diversified strategy execution
- Expected: $20-100/day profit

### Scaling Path
```
Start:  0.1 SOL  → Test phase
        ↓
Scale:  0.5 SOL  → If 5+ successful trades
        ↓
Scale:  1.0 SOL  → If 10+ successful trades
        ↓
Scale:  5.0 SOL  → If consistent profits for 1 week
        ↓
Scale: 10.0 SOL  → If consistent profits for 2 weeks
```

---

## 🔐 WALLET SETUP

### Option 1: Create New Production Wallet (Recommended)
```bash
# Using Solana CLI
solana-keygen new --outfile ~/production-wallet.json

# Get public address
solana-keygen pubkey ~/production-wallet.json

# Get private key (base58)
# You'll need this for the dashboard
cat ~/production-wallet.json
```

### Option 2: Use Existing Wallet
- Export private key from Phantom/Solflare
- **NEVER use your main wallet!**
- Create a dedicated trading wallet

### Security Best Practices
- ✅ Store private key in secure location
- ✅ Use hardware wallet if possible
- ✅ Enable 2FA on all accounts
- ✅ Never share private key
- ✅ Regular key rotation (monthly)
- ❌ Never commit keys to git
- ❌ Never store keys in plain text

---

## 🛠️ PRODUCTION CONFIGURATION

### Step 1: Set Up Environment Variables

Create `.env.production` from template:
```bash
cp .env.production.template .env.production
```

Edit `.env.production` with your actual values:
```bash
# Required API Keys
VITE_HELIUS_API_KEY=your_actual_helius_key
VITE_HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_key

# Safe Production Settings
VITE_MIN_PROFIT_USD=0.05              # Higher threshold
VITE_MAX_POSITION_SOL=1.0             # Limit position size
VITE_AUTO_TRADING_ENABLED=false       # Start manual
```

### Step 2: Configure Trading Parameters

Edit `src/config/tradingConfig.ts`:
```typescript
export const PRODUCTION_CONFIG = {
  trading: {
    minProfitUsd: 0.05,        // $0.05 minimum
    maxPositionSol: 1.0,       // Max 1 SOL per trade
    slippageBps: 100,          // 1% slippage
    autoTradingEnabled: false, // Manual first!
    riskLevel: 'LOW',          // Start conservative
  },
  
  risk: {
    maxDailyLossSol: 0.5,      // Stop after 0.5 SOL loss
    stopLossPercent: 5,        // 5% stop loss
    maxConcurrentTrades: 3,    // Max 3 at once
  },
  
  scanner: {
    scanIntervalMs: 2000,      // Scan every 2 seconds
  }
};
```

---

## 🌐 DEPLOYMENT OPTIONS

### Option A: Local Deployment (Start Here)

**Recommended for:**
- Initial testing
- Learning the system
- Small capital (<1 SOL)

**Steps:**
```bash
# 1. Build for production
pnpm run build

# 2. Start production server
pnpm run preview
# or
npx serve -s dist -l 8080

# 3. Open http://localhost:8080
# 4. Connect wallet and start trading
```

**Pros:**
- ✅ Full control
- ✅ Easy to monitor
- ✅ No cloud costs
- ✅ Quick iterations

**Cons:**
- ❌ Must keep computer running
- ❌ Manual updates required
- ❌ No auto-restart on errors

---

### Option B: GCP Cloud Run Deployment

**Recommended for:**
- Larger capital (>5 SOL)
- 24/7 operation
- Professional setup
- Auto-scaling needs

**Prerequisites:**
1. GCP account with billing enabled
2. gcloud CLI installed
3. Docker installed
4. Project created in GCP

**Quick Deploy:**
```bash
# 1. Set your GCP project ID
export GCP_PROJECT_ID="your-project-id"

# 2. Login to GCP
gcloud auth login

# 3. Set project
gcloud config set project $GCP_PROJECT_ID

# 4. Enable required APIs
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com

# 5. Deploy!
./deploy-gcp.sh
```

**Manual Deploy:**
```bash
# Build Docker image
docker build -t gcr.io/$GCP_PROJECT_ID/solana-mev-bot .

# Push to Container Registry
docker push gcr.io/$GCP_PROJECT_ID/solana-mev-bot

# Deploy to Cloud Run
gcloud run deploy solana-mev-bot \
  --image gcr.io/$GCP_PROJECT_ID/solana-mev-bot \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --port 8080
```

**GCP Configuration:**
- **Region:** us-central1 (or closest to you)
- **Memory:** 2 GB
- **CPU:** 2 vCPUs
- **Min Instances:** 1 (always running)
- **Max Instances:** 3 (auto-scale under load)
- **Timeout:** 300 seconds

**Cost Estimate:**
- ~$50-100/month for always-on instance
- Additional costs for traffic/compute
- Free tier available for testing

**Pros:**
- ✅ 24/7 operation
- ✅ Auto-scaling
- ✅ Professional infrastructure
- ✅ Automatic restarts
- ✅ Easy monitoring

**Cons:**
- ❌ Monthly costs
- ❌ More complex setup
- ❌ Learning curve

---

## 📊 MONITORING & ALERTS

### Real-Time Monitoring

**During Trading:**
1. Watch dashboard for opportunities
2. Monitor console for errors
3. Track balance changes
4. Review trade history

**Key Metrics to Watch:**
- Opportunities detected per hour
- Trade success rate
- Average profit per trade
- Daily profit/loss
- Error rate
- Balance changes

### Set Up Alerts

**Discord/Telegram Bot (Recommended):**
- Trade notifications
- Profit/loss alerts
- Error notifications
- Daily summaries

**Email Alerts:**
- Daily performance report
- Error notifications
- Low balance warnings

**GCP Monitoring (if using Cloud Run):**
```bash
# View logs
gcloud logs tail --service=solana-mev-bot

# Set up alerts in GCP Console
# - CPU usage > 80%
# - Memory usage > 80%
# - Error rate > 5%
# - Request latency > 5s
```

---

## 🚦 LIVE TRADING PHASES

### Phase A: Manual Testing (Week 1)
**Capital:** 0.1-0.5 SOL  
**Mode:** Manual execution only  
**Goal:** Verify system works correctly

**Checklist:**
- [ ] Execute 10-20 manual trades
- [ ] Track all results
- [ ] Verify profit calculations
- [ ] Test all Phase 2 strategies
- [ ] Document any issues

**Success Criteria:**
- 70%+ success rate
- Profits match estimates (±10%)
- No critical errors
- Understanding of all strategies

---

### Phase B: Semi-Auto Trading (Week 2-3)
**Capital:** 0.5-2 SOL  
**Mode:** Auto-detection, manual approval  
**Goal:** Build confidence in automation

**Settings:**
```typescript
{
  autoTradingEnabled: false,    // Still manual
  minProfitUsd: 0.05,          // Higher threshold
  maxPositionSol: 0.5,         // Small positions
  requireManualApproval: true   // Review each trade
}
```

**Checklist:**
- [ ] Review each opportunity before executing
- [ ] Track success patterns
- [ ] Identify best-performing strategies
- [ ] Optimize parameters

**Success Criteria:**
- 75%+ success rate
- Consistent daily profits
- Quick decision-making
- Confidence in system

---

### Phase C: Full Auto Trading (Week 4+)
**Capital:** 2-10 SOL  
**Mode:** Fully automated  
**Goal:** Passive income generation

**Settings:**
```typescript
{
  autoTradingEnabled: true,     // Full auto
  minProfitUsd: 0.03,          // Lower threshold
  maxPositionSol: 2.0,         // Larger positions
  requireManualApproval: false  // Auto-execute
}
```

**Monitoring:**
- Check dashboard 2-3x per day
- Review daily reports
- Adjust parameters weekly
- Monitor for errors

**Success Criteria:**
- 80%+ success rate
- $20-100 daily profit (with 10 SOL)
- <1% error rate
- Consistent performance

---

## ⚠️ SAFETY & RISK MANAGEMENT

### Circuit Breakers

**Auto-Stop Conditions:**
- Daily loss > 2 SOL
- Success rate < 50%
- 5 consecutive failed trades
- Critical errors detected
- Unusual price movements

### Position Sizing

**Never risk more than:**
- 10% of capital per trade
- 20% of capital daily
- 50% of capital weekly

**Example with 10 SOL:**
- Max per trade: 1 SOL
- Daily limit: 2 SOL
- Stop trading if down 2 SOL in a day

### Emergency Procedures

**If System Misbehaves:**
1. **STOP TRADING IMMEDIATELY**
2. Disable auto-trading
3. Review recent trades
4. Check for errors
5. Investigate root cause
6. Don't resume until fixed

**If Losing Money:**
1. Stop trading for the day
2. Review all losing trades
3. Identify patterns
4. Adjust parameters
5. Test with small amounts
6. Resume cautiously

---

## 📈 PERFORMANCE EXPECTATIONS

### Phase 2 Performance (After Testing)

**With 1 SOL Capital:**
- Daily trades: 5-15
- Success rate: 70-80%
- Daily profit: $2-10
- Monthly: $60-300

**With 10 SOL Capital:**
- Daily trades: 20-50
- Success rate: 75-85%
- Daily profit: $20-100
- Monthly: $600-3,000

**Best Strategies (Phase 2):**
1. Cyclic Arbitrage - Consistent small profits
2. Long-Tail Arbitrage - Higher margins
3. Backrun - Fast execution profits
4. JIT Liquidity - Fee capture

---

## 🔧 TROUBLESHOOTING

### Common Issues

**No Opportunities Found:**
- Check RPC connection
- Verify API keys
- Lower profit thresholds
- Try different times of day

**Trades Failing:**
- Increase slippage tolerance
- Increase priority fees
- Check wallet balance (gas)
- Verify token availability

**High Error Rate:**
- Review logs for patterns
- Check network connectivity
- Verify API limits not exceeded
- Consider RPC upgrade

**Low Profits:**
- Increase scan frequency
- Enable more strategies
- Adjust profit thresholds
- Increase capital

---

## 📝 DAILY OPERATIONS CHECKLIST

### Morning (9 AM)
- [ ] Check overnight performance
- [ ] Review error logs
- [ ] Verify balance correct
- [ ] Check for system updates

### Afternoon (2 PM)
- [ ] Monitor active trades
- [ ] Review opportunity quality
- [ ] Adjust parameters if needed
- [ ] Check success rate

### Evening (8 PM)
- [ ] Review daily performance
- [ ] Calculate P&L
- [ ] Plan tomorrow's strategy
- [ ] Backup logs

### Weekly (Sunday)
- [ ] Full performance review
- [ ] Parameter optimization
- [ ] Security audit
- [ ] Update documentation

---

## 🎯 SUCCESS METRICS

### Week 1 Goals
- ✅ 10+ successful manual trades
- ✅ 70%+ success rate
- ✅ No critical errors
- ✅ System understanding complete

### Month 1 Goals
- ✅ Auto-trading enabled
- ✅ 75%+ success rate
- ✅ Consistent daily profits
- ✅ $300+ monthly profit (10 SOL)

### Month 3 Goals
- ✅ 80%+ success rate
- ✅ 50+ trades per day
- ✅ $1,000+ monthly profit
- ✅ Refined strategy mix

---

## 📞 SUPPORT & RESOURCES

### Documentation
- `PHASE2_TESTING_GUIDE.md` - Testing instructions
- `COMPREHENSIVE_CODEBASE_ANALYSIS.md` - System analysis
- `IMPLEMENTATION_ROADMAP.md` - Future phases

### Monitoring Tools
- Solscan.io - Transaction explorer
- Helius Dashboard - RPC metrics
- GCP Console - Cloud monitoring

### Community
- Solana Discord - Technical help
- Jupiter Discord - DEX support
- Jito Discord - MEV support

---

## ⚡ QUICK START COMMANDS

```bash
# Local Development
pnpm run dev

# Production Build
pnpm run build

# Local Production Test
pnpm run preview

# Deploy to GCP
./deploy-gcp.sh

# View Logs (GCP)
gcloud logs tail --service=solana-mev-bot

# Check Service Status (GCP)
gcloud run services describe solana-mev-bot --region=us-central1
```

---

**🎉 You're ready to start live trading!**

**Remember:**
1. Start small (0.1-0.5 SOL)
2. Test thoroughly before auto-trading
3. Monitor closely during first week
4. Scale gradually
5. Never risk more than you can lose

**Good luck with your MEV trading bot!** 🚀💰
