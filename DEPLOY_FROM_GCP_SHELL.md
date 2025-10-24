# 🚀 DEPLOY FROM GCP CLOUD SHELL

**Your GCP Project:** solana-mev-bot-476012  
**Your Console:** https://console.cloud.google.com/compute/instances?project=solana-mev-bot-476012

---

## 🎯 QUICK DEPLOY (5 MINUTES)

### Step 1: Open Cloud Shell
Click this link (opens your GCP Cloud Shell):
```
https://console.cloud.google.com/cloudshell/editor?project=solana-mev-bot-476012
```

Or click the **Cloud Shell icon** (>_) in the top right of GCP Console.

---

### Step 2: Clone Your GitHub Repository
```bash
# Clone your repository
git clone https://github.com/Panith-qc/Solana_Arbitrage.git

# Enter directory
cd Solana_Arbitrage
```

---

### Step 3: Enable Required APIs
```bash
# Enable Cloud Run, Cloud Build, and Container Registry
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
```

This takes ~1 minute. Wait for "Operation completed successfully" messages.

---

### Step 4: Deploy to Cloud Run
```bash
# Set your project (should already be set, but just in case)
export GCP_PROJECT_ID="solana-mev-bot-476012"

# Deploy using gcloud run deploy
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080
```

**This command:**
- Builds your app from source
- Creates Docker container
- Deploys to Cloud Run
- Returns a live URL

**Wait time:** 5-7 minutes for first deployment

---

### Step 5: Get Your Live URL
After deployment completes, you'll see:
```
Service [solana-mev-bot] revision [solana-mev-bot-00001] has been deployed and is serving 100 percent of traffic.
Service URL: https://solana-mev-bot-XXXXXXXXX-uc.a.run.app
```

**Copy that URL!** That's your live trading bot! 🎉

---

## 📋 ALTERNATIVE: Use Cloud Build

If the above doesn't work, use Cloud Build:

### Step 1: Build with Cloud Build
```bash
# From your Solana_Arbitrage directory
gcloud builds submit --tag gcr.io/solana-mev-bot-476012/solana-mev-bot
```

### Step 2: Deploy the Built Image
```bash
gcloud run deploy solana-mev-bot \
  --image gcr.io/solana-mev-bot-476012/solana-mev-bot:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --port 8080
```

---

## 🔧 DEPLOYMENT OPTIONS EXPLAINED

### Memory & CPU
```bash
--memory 2Gi     # 2GB RAM (good for MEV bot)
--cpu 2          # 2 CPUs (handles concurrent trades)
```

### Scaling
```bash
--min-instances 1   # Always 1 running (24/7 trading)
--max-instances 3   # Scale to 3 under load
```

### Access
```bash
--allow-unauthenticated   # Public access (anyone can use)
```

**To make private:**
```bash
--no-allow-unauthenticated   # Only you can access
```

---

## 🌐 ACCESS YOUR DEPLOYED BOT

### After Deployment
1. You'll get a URL like: `https://solana-mev-bot-xxx-uc.a.run.app`
2. Open that URL in your browser
3. You'll see your **Automated MEV Trading Bot** interface!
4. Enter your wallet and start trading

---

## 🔄 UPDATE YOUR DEPLOYMENT

### When You Make Changes

**From Cloud Shell:**
```bash
# 1. Pull latest code from GitHub
cd ~/Solana_Arbitrage
git pull origin main

# 2. Redeploy (simple!)
gcloud run deploy solana-mev-bot \
  --source . \
  --region us-central1
```

That's it! Your bot updates in ~3-5 minutes.

---

## 📊 MONITOR YOUR BOT

### View Real-Time Logs
```bash
# Stream logs (like tail -f)
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --follow
```

### Check Recent Activity
```bash
# Last 50 log entries
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --limit 50
```

### View in Console
Visit: https://console.cloud.google.com/run/detail/us-central1/solana-mev-bot/logs?project=solana-mev-bot-476012

---

## 🐛 TROUBLESHOOTING

### Build Fails
```bash
# Check build logs
gcloud builds list --limit 5

# See details of latest build
gcloud builds describe $(gcloud builds list --limit 1 --format="value(id)")
```

### Deployment Fails
```bash
# Check service status
gcloud run services describe solana-mev-bot --region us-central1

# Check for errors
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --severity ERROR
```

### Can't Access URL
```bash
# Verify service is running
gcloud run services list

# Test the URL
curl -I $(gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format='value(status.url)')
```

---

## 💰 COST INFORMATION

### Cloud Run Pricing
- **Free Tier:** 2 million requests/month FREE
- **Always-on (1 instance):** ~$50-70/month
- **Scaling (2-3 instances):** ~$100-150/month

### View Your Costs
https://console.cloud.google.com/billing/reports?project=solana-mev-bot-476012

### Reduce Costs (Not Recommended for Trading)
```bash
# Scale to 0 when idle (bot stops trading!)
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --min-instances 0
```

---

## ✅ POST-DEPLOYMENT CHECKLIST

After deployment, test:
- [ ] URL loads successfully
- [ ] Dashboard displays correctly
- [ ] Can enter wallet private key
- [ ] Risk profiles show (Conservative/Balanced/Aggressive)
- [ ] Auto-configuration works
- [ ] Can start auto-trading
- [ ] Logs show activity
- [ ] No errors in console

---

## 🎯 QUICK COMMANDS SUMMARY

```bash
# Deploy from source
gcloud run deploy solana-mev-bot --source . --region us-central1

# Get service URL
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format='value(status.url)'

# View logs
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --follow

# Update deployment
git pull && gcloud run deploy solana-mev-bot --source . --region us-central1

# Delete service
gcloud run services delete solana-mev-bot --region us-central1
```

---

## 📞 YOUR PROJECT LINKS

- **Cloud Shell:** https://console.cloud.google.com/cloudshell/editor?project=solana-mev-bot-476012
- **Cloud Run:** https://console.cloud.google.com/run?project=solana-mev-bot-476012
- **Logs:** https://console.cloud.google.com/logs?project=solana-mev-bot-476012
- **Billing:** https://console.cloud.google.com/billing?project=solana-mev-bot-476012

---

## 🚀 READY TO DEPLOY?

### Copy & Paste This Into Cloud Shell:

```bash
# Complete deployment script
git clone https://github.com/Panith-qc/Solana_Arbitrage.git && \
cd Solana_Arbitrage && \
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com && \
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080
```

**That's ONE command that does everything!**

---

## 🎉 YOU'RE DONE!

After ~5-7 minutes, you'll have:
- ✅ Live URL for your trading bot
- ✅ Automated trading with risk profiles
- ✅ 24/7 operation on GCP
- ✅ Auto-scaling under load
- ✅ Professional deployment

**Your bot will be accessible at a URL like:**
`https://solana-mev-bot-xxx-uc.a.run.app`

**Open it, enter your wallet, select risk profile, and start trading!** 🚀💰
