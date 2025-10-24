# 🚀 GCP DEPLOYMENT GUIDE - Solana MEV Bot

**GCP Project:** solana-mev-bot-476012  
**Current Code:** All automation features pushed to GitHub  
**Status:** Ready to deploy

---

## 📋 DEPLOYMENT OVERVIEW

You have 2 deployment options:

### Option 1: Quick Deploy (Recommended) ⚡
Use the automated deployment script - deploys in ~5 minutes

### Option 2: Manual Deploy 🛠️
Step-by-step manual deployment for more control

---

## 🚀 OPTION 1: QUICK DEPLOY (RECOMMENDED)

### Prerequisites Check
```bash
# 1. Verify you're logged in
gcloud auth list

# 2. Set your project
gcloud config set project solana-mev-bot-476012

# 3. Enable required APIs (if not already enabled)
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
```

### Deploy with One Command
```bash
# Set environment variable
export GCP_PROJECT_ID="solana-mev-bot-476012"

# Run deployment script
./deploy-gcp.sh
```

**This will:**
1. Build your application (`pnpm install` + `pnpm run build`)
2. Create Docker image
3. Push to Google Container Registry (GCR)
4. Deploy to Cloud Run
5. Give you a live URL

**Expected time:** 5-7 minutes

---

## 🛠️ OPTION 2: MANUAL DEPLOYMENT

### Step 1: Enable Required APIs
```bash
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

### Step 2: Build Application
```bash
# Install dependencies
pnpm install --legacy-peer-deps

# Build for production
pnpm run build
```

### Step 3: Build Docker Image
```bash
# Build the image
docker build -t gcr.io/solana-mev-bot-476012/solana-mev-bot:latest .

# Verify image was created
docker images | grep solana-mev-bot
```

### Step 4: Push to Container Registry
```bash
# Configure Docker authentication
gcloud auth configure-docker

# Push the image
docker push gcr.io/solana-mev-bot-476012/solana-mev-bot:latest
```

### Step 5: Deploy to Cloud Run
```bash
gcloud run deploy solana-mev-bot \
  --image gcr.io/solana-mev-bot-476012/solana-mev-bot:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --timeout 300
```

### Step 6: Get Service URL
```bash
gcloud run services describe solana-mev-bot \
  --platform managed \
  --region us-central1 \
  --format 'value(status.url)'
```

---

## 📊 CLOUD RUN CONFIGURATION

### Resource Allocation
- **Memory:** 2 GB (enough for MEV bot)
- **CPU:** 2 vCPUs (handles concurrent trades)
- **Port:** 8080 (standard)
- **Timeout:** 300 seconds (5 minutes)

### Auto-Scaling
- **Min Instances:** 1 (always running)
- **Max Instances:** 3 (scale under load)
- **Concurrency:** 80 requests per instance

### Cost Estimate
- **Always-on (1 instance):** ~$50-70/month
- **Scaling (2-3 instances):** ~$100-150/month
- **Free tier:** First 2 million requests free

---

## 🔐 ENVIRONMENT VARIABLES

### Set via Cloud Run Console
Go to Cloud Run → Your Service → Edit & Deploy → Variables

**Required variables:**
```
VITE_HELIUS_API_KEY=your_helius_key
VITE_HELIUS_RPC_URL=your_helius_url
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_key
```

### Or set via command line:
```bash
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --update-env-vars VITE_HELIUS_API_KEY=your_key,VITE_SUPABASE_URL=your_url
```

---

## 🔄 UPDATE DEPLOYMENT (After Code Changes)

### Quick Update
```bash
# 1. Push code to GitHub (already done)
git push origin main

# 2. Rebuild and redeploy
./deploy-gcp.sh
```

### Manual Update
```bash
# 1. Rebuild app
pnpm run build

# 2. Rebuild Docker image
docker build -t gcr.io/solana-mev-bot-476012/solana-mev-bot:latest .

# 3. Push to GCR
docker push gcr.io/solana-mev-bot-476012/solana-mev-bot:latest

# 4. Deploy new version
gcloud run deploy solana-mev-bot \
  --image gcr.io/solana-mev-bot-476012/solana-mev-bot:latest \
  --region us-central1
```

---

## 📊 MONITORING YOUR DEPLOYMENT

### View Logs
```bash
# Real-time logs
gcloud logs tail --service=solana-mev-bot

# Recent logs
gcloud logs read --service=solana-mev-bot --limit 50
```

### Check Service Status
```bash
gcloud run services describe solana-mev-bot \
  --region us-central1
```

### View in Console
Visit: https://console.cloud.google.com/run/detail/us-central1/solana-mev-bot/metrics?project=solana-mev-bot-476012

---

## 🐛 TROUBLESHOOTING

### Build Fails
```bash
# Check build logs
gcloud builds list --limit 5

# View specific build
gcloud builds log BUILD_ID
```

### Deployment Fails
```bash
# Check service logs
gcloud run services describe solana-mev-bot --region us-central1

# Check recent errors
gcloud logs read --service=solana-mev-bot --severity ERROR --limit 20
```

### Service Not Responding
```bash
# Check if service is running
gcloud run services list

# Check revisions
gcloud run revisions list --service=solana-mev-bot --region us-central1

# Test the URL
curl -I YOUR_CLOUD_RUN_URL
```

---

## ✅ POST-DEPLOYMENT CHECKLIST

After deployment:
- [ ] Service URL is accessible
- [ ] Dashboard loads correctly
- [ ] Can enter wallet private key
- [ ] Risk profiles display
- [ ] Auto-configuration works
- [ ] Can start trading
- [ ] Logs show no errors

---

## 🔒 SECURITY BEST PRACTICES

### 1. Use Secret Manager (Recommended)
```bash
# Create secrets
gcloud secrets create helius-api-key --data-file=-
# (paste your key, then Ctrl+D)

# Grant access to Cloud Run
gcloud secrets add-iam-policy-binding helius-api-key \
  --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

# Update service to use secret
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --update-secrets=VITE_HELIUS_API_KEY=helius-api-key:latest
```

### 2. Restrict Access
```bash
# Remove public access (if needed)
gcloud run services remove-iam-policy-binding solana-mev-bot \
  --region us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"

# Add specific users
gcloud run services add-iam-policy-binding solana-mev-bot \
  --region us-central1 \
  --member="user:your-email@gmail.com" \
  --role="roles/run.invoker"
```

### 3. Enable HTTPS Only
Cloud Run automatically uses HTTPS - no additional config needed! ✅

---

## 💰 COST OPTIMIZATION

### Reduce Costs
```bash
# Scale to 0 when idle (not recommended for trading bot)
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --min-instances 0

# Reduce memory (if bot runs fine with less)
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --memory 1Gi
```

### Monitor Costs
Visit: https://console.cloud.google.com/billing/reports?project=solana-mev-bot-476012

---

## 🎯 QUICK COMMANDS REFERENCE

```bash
# Deploy/Update
./deploy-gcp.sh

# View logs
gcloud logs tail --service=solana-mev-bot

# Get URL
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format 'value(status.url)'

# Check status
gcloud run services list

# Delete service
gcloud run services delete solana-mev-bot --region us-central1
```

---

## 📞 SUPPORT RESOURCES

### GCP Documentation
- Cloud Run: https://cloud.google.com/run/docs
- Container Registry: https://cloud.google.com/container-registry/docs
- Secret Manager: https://cloud.google.com/secret-manager/docs

### Your Project Console
- Overview: https://console.cloud.google.com/home/dashboard?project=solana-mev-bot-476012
- Cloud Run: https://console.cloud.google.com/run?project=solana-mev-bot-476012
- Logs: https://console.cloud.google.com/logs?project=solana-mev-bot-476012

---

## 🎉 READY TO DEPLOY!

**Recommended approach:**
1. Run `./deploy-gcp.sh` 
2. Wait 5-7 minutes
3. Get your live URL
4. Test with your wallet
5. Start auto-trading!

**Your bot will be live at a URL like:**
`https://solana-mev-bot-XXXXXXXXX-uc.a.run.app`

---

**Good luck with deployment!** 🚀
