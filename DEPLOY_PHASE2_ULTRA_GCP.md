# 🚀 DEPLOY PHASE 2 ULTRA TO GCP - COMPLETE GUIDE

**Updated:** October 25, 2025  
**For:** Phase 2 Ultra with Jupiter Ultra API + Helius Paid Tier  
**Infrastructure:** GCP Cloud Run + Secret Manager

---

## 📋 **PREREQUISITES**

```bash
# 1. GCP Account with billing enabled
# 2. gcloud CLI installed
# 3. Your credentials ready:
#    - Helius API Key: 926fd4af-7c9d-4fa3-9504-a2970ac5f16d
#    - Jupiter Ultra API Key: bca82c35-07e5-4ab0-9a8f-7d23333ffa93
#    - Private key for trading wallet
```

---

## 🔧 **STEP 1: SET UP GCP PROJECT**

```bash
# Login to GCP
gcloud auth login

# Set your project ID (replace with yours)
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  containerregistry.googleapis.com

# Set default region
gcloud config set run/region us-central1
```

---

## 🔐 **STEP 2: CREATE SECRETS IN SECRET MANAGER**

```bash
# Create Helius RPC URL secret
echo "https://mainnet.helius-rpc.com/?api-key=926fd4af-7c9d-4fa3-9504-a2970ac5f16d" | \
  gcloud secrets create helius-rpc-url --data-file=-

# Create Helius API Key secret
echo "926fd4af-7c9d-4fa3-9504-a2970ac5f16d" | \
  gcloud secrets create helius-api-key --data-file=-

# Create Jupiter Ultra API Key secret
echo "bca82c35-07e5-4ab0-9a8f-7d23333ffa93" | \
  gcloud secrets create jupiter-ultra-api-key --data-file=-

# Create Jito tip accounts secret
echo "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE,D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ,9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta,5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn,2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD,2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ,wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF,3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT,4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey,4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or" | \
  gcloud secrets create jito-tip-accounts --data-file=-

# Create trading wallet private key secret (REPLACE WITH YOUR ACTUAL KEY)
echo "YOUR_WALLET_PRIVATE_KEY_HERE" | \
  gcloud secrets create trading-wallet-private-key --data-file=-

echo "✅ All secrets created!"
```

---

## 📦 **STEP 3: BUILD AND DEPLOY**

### **Option A: Quick Deploy (Recommended)**

```bash
# Clone/navigate to your repo
cd /workspace

# Deploy to Cloud Run (with secrets)
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --timeout 300 \
  --set-env-vars "NODE_ENV=production" \
  --set-secrets "VITE_HELIUS_RPC_URL=helius-rpc-url:latest,HELIUS_API_KEY=helius-api-key:latest,JUPITER_ULTRA_API_KEY=jupiter-ultra-api-key:latest,JITO_TIP_ACCOUNTS=jito-tip-accounts:latest,TRADING_WALLET_PRIVATE_KEY=trading-wallet-private-key:latest"

echo "✅ Deployment complete!"
```

### **Option B: Manual Docker Build**

```bash
# Build Docker image
docker build -t gcr.io/$PROJECT_ID/solana-mev-bot:latest .

# Push to Container Registry
docker push gcr.io/$PROJECT_ID/solana-mev-bot:latest

# Deploy to Cloud Run
gcloud run deploy solana-mev-bot \
  --image gcr.io/$PROJECT_ID/solana-mev-bot:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --timeout 300 \
  --set-secrets "VITE_HELIUS_RPC_URL=helius-rpc-url:latest,HELIUS_API_KEY=helius-api-key:latest,JUPITER_ULTRA_API_KEY=jupiter-ultra-api-key:latest,JITO_TIP_ACCOUNTS=jito-tip-accounts:latest"

echo "✅ Deployment complete!"
```

---

## 🔄 **STEP 4: VERIFY DEPLOYMENT**

```bash
# Get the deployed URL
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format 'value(status.url)'

# Check logs
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --limit 50

# Check if service is running
curl $(gcloud run services describe solana-mev-bot --region us-central1 --format 'value(status.url)')
```

**Expected logs:**
```
🚀 Cyclic Arbitrage Service initialized (JUPITER ULTRA)
⚡ Ultra: RPC-less | MEV Protection | Sub-second | 96% success rate
✅ Jupiter Ultra service initialized
🎯 Rate Limiter initialized (PAID tier)
   Max: 1200 req/min | 20 req/sec
```

---

## 📊 **STEP 5: MONITOR & MANAGE**

### **View Logs:**
```bash
# Stream logs in real-time
gcloud run services logs tail solana-mev-bot \
  --region us-central1

# View errors only
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --log-filter "severity>=ERROR"

# View last 100 lines
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --limit 100
```

### **Check Metrics:**
```bash
# Get service details
gcloud run services describe solana-mev-bot \
  --region us-central1

# View metrics in GCP Console
echo "Visit: https://console.cloud.google.com/run/detail/us-central1/solana-mev-bot/metrics?project=$PROJECT_ID"
```

### **Update Environment Variables:**
```bash
# Update any env var
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --set-env-vars "NEW_VAR=value"

# Update secret
echo "new-secret-value" | gcloud secrets versions add secret-name --data-file=-
```

---

## 🔧 **STEP 6: CONFIGURE SCALING**

```bash
# Adjust resources based on load
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --memory 4Gi \
  --cpu 4 \
  --min-instances 2 \
  --max-instances 10 \
  --concurrency 80

# For 24/7 operation (keeps at least 1 instance always warm)
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --min-instances 1 \
  --max-instances 5
```

---

## 💰 **COST ESTIMATION**

### **Cloud Run Costs:**
```
Configuration:
├─ 2 vCPU
├─ 2GB RAM
├─ 1 min instance (always on)
└─ ~$50-100/month

Breakdown:
├─ CPU: 2 vCPU × $0.00002400/vCPU-second × 2.6M seconds/month = ~$125/month
├─ Memory: 2GB × $0.00000250/GB-second × 2.6M seconds/month = ~$13/month
├─ Requests: Minimal (serving static frontend)
└─ Total: ~$50-150/month (with sustained use discount)
```

### **Total Infrastructure Costs:**
```
Cloud Run: $50-150/month
Helius (paid tier): Already have ✅
Jupiter Ultra: FREE (scales with volume) ✅
Total: ~$50-150/month for hosting
```

---

## 🚨 **TROUBLESHOOTING**

### **Issue: Deployment fails**
```bash
# Check build logs
gcloud builds list --limit 5

# View specific build
gcloud builds log <BUILD_ID>

# Check for permission issues
gcloud projects get-iam-policy $PROJECT_ID
```

### **Issue: Secrets not loading**
```bash
# Verify secrets exist
gcloud secrets list

# Check secret value
gcloud secrets versions access latest --secret="helius-api-key"

# Grant Cloud Run access to secrets
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### **Issue: Service not responding**
```bash
# Check service status
gcloud run services describe solana-mev-bot --region us-central1

# Restart service
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --set-env-vars "RESTART=$(date +%s)"

# Check logs for errors
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --limit 100
```

---

## 📱 **STEP 7: ACCESS YOUR BOT**

Once deployed, you'll get a URL like:
```
https://solana-mev-bot-xxxxx-uc.a.run.app
```

1. **Open the URL in browser**
2. **Go to "Phase 2 Auto Trading"**
3. **Enter your private key**
4. **Select risk profile**
5. **Click "Start Phase 2 Trading"**

The bot will:
- ✅ Use Jupiter Ultra API (MEV-protected)
- ✅ Execute trades with 1800 req/min capacity
- ✅ Run 24/7 on GCP Cloud Run
- ✅ Auto-scale based on load
- ✅ Scan every 1-2 seconds
- ✅ Find and execute profitable trades

---

## 🔐 **SECURITY BEST PRACTICES**

```bash
# 1. Restrict service access
gcloud run services remove-iam-policy-binding solana-mev-bot \
  --region us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"

# 2. Add authentication
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --no-allow-unauthenticated

# 3. Set up Identity-Aware Proxy (IAP)
# Visit: https://console.cloud.google.com/security/iap

# 4. Rotate secrets regularly
echo "new-api-key" | gcloud secrets versions add jupiter-ultra-api-key --data-file=-

# 5. Enable audit logging
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=solana-mev-bot" \
  --limit 10
```

---

## 📊 **MONITORING DASHBOARD**

Create a monitoring dashboard:

```bash
# Open Cloud Monitoring
echo "Visit: https://console.cloud.google.com/monitoring/dashboards?project=$PROJECT_ID"

# Key metrics to monitor:
# - Request count (trades per minute)
# - Request latency (API speed)
# - CPU utilization
# - Memory usage
# - Error rate
# - Instance count
```

---

## 🔄 **CONTINUOUS DEPLOYMENT**

Set up automatic deployments:

```bash
# Connect GitHub repo to Cloud Build
gcloud builds triggers create github \
  --repo-name=Solana_Arbitrage \
  --repo-owner=Panith-qc \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml

echo "✅ Now every push to main will auto-deploy!"
```

---

## 🎯 **QUICK DEPLOY SCRIPT**

Save this as `deploy-phase2-ultra.sh`:

```bash
#!/bin/bash
set -e

echo "🚀 Deploying Phase 2 Ultra to GCP..."

# Set project
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Deploy
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --timeout 300 \
  --set-secrets "VITE_HELIUS_RPC_URL=helius-rpc-url:latest,HELIUS_API_KEY=helius-api-key:latest,JUPITER_ULTRA_API_KEY=jupiter-ultra-api-key:latest,JITO_TIP_ACCOUNTS=jito-tip-accounts:latest"

# Get URL
URL=$(gcloud run services describe solana-mev-bot --region us-central1 --format 'value(status.url)')

echo "✅ Deployment complete!"
echo "🌐 URL: $URL"
echo "📊 Logs: gcloud run services logs tail solana-mev-bot --region us-central1"
```

Run with:
```bash
chmod +x deploy-phase2-ultra.sh
./deploy-phase2-ultra.sh
```

---

## ✅ **DEPLOYMENT CHECKLIST**

```
✅ GCP project created & billing enabled
✅ gcloud CLI installed & authenticated
✅ APIs enabled (Cloud Run, Secret Manager, Container Registry)
✅ Secrets created in Secret Manager
✅ Dockerfile ready (.env.production has credentials)
✅ Build & deploy command executed
✅ Service deployed successfully
✅ URL accessible in browser
✅ Logs show Jupiter Ultra initialized
✅ Phase 2 Auto Trading accessible
✅ Bot scanning for opportunities
✅ Monitoring dashboard set up
```

---

## 🆘 **NEED HELP?**

```bash
# Check deployment status
gcloud run services describe solana-mev-bot --region us-central1

# View recent logs
gcloud run services logs read solana-mev-bot --region us-central1 --limit 50

# Get service URL
gcloud run services describe solana-mev-bot --region us-central1 --format 'value(status.url)'

# Delete and redeploy
gcloud run services delete solana-mev-bot --region us-central1
# Then run deploy command again
```

---

**Your Phase 2 Ultra bot with Jupiter Ultra API + Helius paid tier will be running 24/7 on GCP!** 🚀

*Last updated: October 25, 2025*
