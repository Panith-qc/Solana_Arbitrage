# 🚀 DEPLOY FROM GCP CLOUD SHELL - WITH CRITICAL FIX

**Your Project:** `solana-mev-bot-476012`  
**Your Console:** https://console.cloud.google.com/compute/instances?project=solana-mev-bot-476012&cloudshell=true

---

## ⚡ **ONE-COMMAND DEPLOYMENT**

### **Open Cloud Shell and Copy-Paste This:**

```bash
curl -sSL https://raw.githubusercontent.com/Panith-qc/Solana_Arbitrage/main/GCP_CLOUDSHELL_DEPLOY_WITH_FIX.sh | bash
```

**OR if you prefer to see the steps:**

```bash
# Step 1: Set project
gcloud config set project solana-mev-bot-476012

# Step 2: Clean up
cd ~ && rm -rf Solana_Arbitrage

# Step 3: Clone repository with fix
git clone --depth 1 https://github.com/Panith-qc/Solana_Arbitrage.git
cd Solana_Arbitrage

# Step 4: Enable APIs
gcloud services enable cloudbuild.googleapis.com run.googleapis.com

# Step 5: Deploy
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --timeout 3600
```

**Time:** 5-7 minutes

---

## 📊 **WHAT THIS DEPLOYS**

### ✅ **Critical Fix Included:**
- Scanner now checks **complete cycles** (SOL → Token → SOL)
- No more opposite-direction trades
- Only reports if: `finalSOL > initialSOL`
- **You always start with SOL, end with MORE SOL!**

### 🔧 **Configuration:**
- **Memory:** 2GB RAM
- **CPU:** 2 cores
- **Scaling:** 1-3 instances
- **Region:** us-central1
- **Access:** Public (unauthenticated)
- **Timeout:** 1 hour

---

## 🌐 **ACCESS YOUR BOT**

After deployment completes, you'll see:

```
Service [solana-mev-bot] revision [solana-mev-bot-00001] has been deployed
Service URL: https://solana-mev-bot-XXXXXXXXX-uc.a.run.app
```

**Open that URL!** That's your live trading bot with the fix! 🎉

---

## 📋 **VERIFY THE FIX IS WORKING**

### **View Live Logs:**

```bash
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --follow
```

### **Look For These Messages:**

✅ **Good (What you should see):**
```
🔍 CHECKING COMPLETE CYCLE: SOL → JUP → SOL
   Step 1: SOL → Token (0.1 SOL)
   ✅ Got 26315 tokens
   Step 2: Token → SOL (26315 tokens)
   ✅ Got 0.102 SOL back
💰 CYCLE PROFIT: Start=0.1 SOL, End=0.102 SOL, Profit=0.002 SOL
```

❌ **Bad (What you should NOT see):**
```
FOUND OPPORTUNITY: JUP/SOL  ← Old bug (one-way only)
Input: $241, Output: $121    ← Old bug (losing money)
```

---

## 🔄 **UPDATE YOUR DEPLOYMENT**

### **When Code Changes:**

```bash
# From Cloud Shell
cd ~/Solana_Arbitrage
git pull origin main
gcloud run deploy solana-mev-bot \
  --source . \
  --region us-central1 \
  --project solana-mev-bot-476012
```

**Time:** 3-5 minutes

---

## 📊 **MONITORING COMMANDS**

### **Check Service Status:**
```bash
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012
```

### **Get Service URL:**
```bash
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --format='value(status.url)'
```

### **View Recent Logs:**
```bash
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --limit 100
```

### **Check Errors Only:**
```bash
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --log-filter='severity=ERROR'
```

---

## 🔗 **QUICK LINKS**

### **Your Project Links:**
- **Cloud Shell:** https://console.cloud.google.com/cloudshell/editor?project=solana-mev-bot-476012
- **Cloud Run Services:** https://console.cloud.google.com/run?project=solana-mev-bot-476012
- **Logs:** https://console.cloud.google.com/logs?project=solana-mev-bot-476012
- **Billing:** https://console.cloud.google.com/billing?project=solana-mev-bot-476012

---

## 🐛 **TROUBLESHOOTING**

### **"APIs not enabled" Error:**
```bash
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
```

### **"Permission denied" Error:**
```bash
gcloud auth login
gcloud config set project solana-mev-bot-476012
```

### **"Build failed" Error:**
```bash
# Check build logs
gcloud builds list --project solana-mev-bot-476012 --limit 5

# View latest build
gcloud builds log $(gcloud builds list --project solana-mev-bot-476012 --limit 1 --format="value(id)")
```

### **"Service not responding" Error:**
```bash
# Check service health
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --format='value(status.conditions)'
```

---

## 💰 **COST ESTIMATE**

### **Monthly Costs (1 instance always on):**
- **Compute:** ~$50-70/month
- **Network:** ~$5-10/month
- **Storage:** <$1/month
- **Total:** ~$55-80/month

### **Free Tier Includes:**
- 2 million requests/month FREE
- 360,000 GB-seconds/month FREE
- 180,000 vCPU-seconds/month FREE

### **Reduce Costs (Scale to 0 when idle):**
```bash
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --min-instances 0
```

⚠️ **Warning:** Bot will stop trading when scaled to 0!

---

## ⚠️ **IMPORTANT NOTES**

### **Expected Behavior:**

**You might see ZERO opportunities** - this is NORMAL!

**Why?**
- Real arbitrage cycles are RARE
- Markets are efficient
- High competition
- Current market is stable

**The Difference:**
- **Before Fix:** Found FAKE opportunities, lost money ❌
- **After Fix:** Finds ZERO opportunities, protects money ✅

### **When Will It Trade?**

Bot will execute when:
- ✅ Complete cycle is profitable (SOL → Token → SOL)
- ✅ Net profit > $0.05 (after all fees)
- ✅ Market has volatility or imbalances
- ✅ Real arbitrage opportunities appear

**Be patient!** Quality > Quantity

---

## ✅ **SUCCESS CHECKLIST**

After deployment:
- [ ] Got Service URL
- [ ] URL loads in browser
- [ ] Dashboard displays
- [ ] Console shows "CHECKING COMPLETE CYCLE" messages
- [ ] No "Input: $241, Output: $121" errors
- [ ] Bot protects capital (rejects unprofitable)

---

## 🚀 **READY TO DEPLOY?**

### **Copy This Into Cloud Shell:**

```bash
gcloud config set project solana-mev-bot-476012 && \
cd ~ && rm -rf Solana_Arbitrage && \
git clone --depth 1 https://github.com/Panith-qc/Solana_Arbitrage.git && \
cd Solana_Arbitrage && \
gcloud services enable cloudbuild.googleapis.com run.googleapis.com && \
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --project solana-mev-bot-476012 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --timeout 3600
```

**That's it! One command, 5-7 minutes, done!** 🚀

---

## 🎉 **AFTER DEPLOYMENT**

You'll have:
- ✅ Live trading bot at a URL
- ✅ Critical fix applied (SOL→Token→SOL cycles)
- ✅ 24/7 operation on GCP
- ✅ Auto-scaling (1-3 instances)
- ✅ Professional deployment

**Open your URL, connect your wallet, and start trading!** 💰
