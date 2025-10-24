# 🚀 DEPLOY TO GCP NOW - QUICK START

## ⚡ **FASTEST DEPLOYMENT (2 COMMANDS)**

```bash
# 1. Set your GCP project ID
export GCP_PROJECT_ID="your-project-id"

# 2. Deploy!
./deploy-gcp-simple.sh
```

**That's it! Your bot will be live in 3-5 minutes!** ✅

---

## 📋 **WHAT HAPPENS:**

1. **Builds** your app (pnpm run build)
2. **Creates** Docker container
3. **Deploys** to Cloud Run
4. **Returns** your live URL

**Example Output:**
```
Deploying container to Cloud Run service [solana-mev-bot]...
✓ Deploying... Done.
  ✓ Creating Revision...
  ✓ Routing traffic...
Done.
Service [solana-mev-bot] revision [solana-mev-bot-00001-abc] has been deployed.
Service URL: https://solana-mev-bot-xyz123-uc.a.run.app
```

---

## 🎯 **DEPLOYMENT OPTIONS:**

### **Option 1: Simple (Recommended)** ⚡
```bash
./deploy-gcp-simple.sh
```
- ✅ Fastest
- ✅ One command
- ✅ Perfect for testing

### **Option 2: Full Configuration** 🔧
```bash
export GCP_PROJECT_ID="your-project-id"
./deploy-gcp.sh
```
- ✅ Detailed output
- ✅ API checks
- ✅ Full configuration

### **Option 3: With Secrets** 🔒
```bash
export GCP_PROJECT_ID="your-project-id"
./deploy-gcp-with-secrets.sh
```
- ✅ Secure API keys
- ✅ Secret Manager
- ✅ Production ready

---

## 📝 **PRE-REQUISITES:**

### **1. Install gcloud CLI:**
```bash
# Mac
brew install --cask google-cloud-sdk

# Linux
curl https://sdk.cloud.google.com | bash

# Windows
# Download from: https://cloud.google.com/sdk/docs/install
```

### **2. Authenticate:**
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### **3. Enable Billing:**
Go to: https://console.cloud.google.com/billing

---

## 💰 **COST:**

**With default settings:**
- **Idle:** $0/month (auto-scales to zero)
- **Active 24/7:** ~$50-70/month
- **Per request:** $0.0000004

**Free Tier:**
- 2 million requests/month FREE
- 360,000 GB-seconds FREE
- 180,000 vCPU-seconds FREE

**Your bot will likely stay in free tier for testing!** ✅

---

## 🎉 **AFTER DEPLOYMENT:**

### **1. Get Your URL:**
The deployment will output something like:
```
https://solana-mev-bot-xyz123-uc.a.run.app
```

### **2. Open in Browser:**
Click the URL or:
```bash
open https://solana-mev-bot-xyz123-uc.a.run.app
```

### **3. Start Trading:**
1. Connect your wallet
2. Click "Start Phase 2 Trading"
3. Watch the magic! 🎯

---

## 📊 **VIEW LOGS:**

```bash
# Real-time logs
gcloud run services logs read solana-mev-bot \
    --region us-central1 \
    --follow

# Or in browser
https://console.cloud.google.com/run
```

---

## 🔄 **UPDATE DEPLOYMENT:**

Made changes? Redeploy:
```bash
./deploy-gcp-simple.sh
```

It will deploy a new revision automatically!

---

## ❌ **TROUBLESHOOTING:**

### **"gcloud: command not found"**
Install gcloud CLI (see pre-requisites above)

### **"You are not authenticated"**
```bash
gcloud auth login
```

### **"Project not set"**
```bash
export GCP_PROJECT_ID="your-actual-project-id"
```

### **Build fails**
```bash
# Check you're in the right directory
cd /workspace

# Check build works locally
pnpm run build
```

---

## 🗑️ **DELETE SERVICE:**

To stop and remove:
```bash
gcloud run services delete solana-mev-bot --region us-central1
```

---

## 📚 **MORE INFO:**

- **Full Guide:** `GCP_DEPLOYMENT_GUIDE.md`
- **Scripts:**
  - `deploy-gcp-simple.sh` - Quick deploy
  - `deploy-gcp.sh` - Full deploy
  - `deploy-gcp-with-secrets.sh` - Secure deploy

---

## ⚡ **QUICK CHECKLIST:**

- [ ] gcloud CLI installed
- [ ] Authenticated (`gcloud auth login`)
- [ ] Project ID set (`export GCP_PROJECT_ID=...`)
- [ ] Billing enabled
- [ ] Run `./deploy-gcp-simple.sh`
- [ ] Wait 3-5 minutes
- [ ] Open URL
- [ ] Start trading! 🚀

---

# 🎯 **DEPLOY RIGHT NOW:**

```bash
# Copy-paste this:
export GCP_PROJECT_ID="your-project-id"  # Change this!
./deploy-gcp-simple.sh
```

**3 minutes later: Your bot is LIVE!** 🎉💎
