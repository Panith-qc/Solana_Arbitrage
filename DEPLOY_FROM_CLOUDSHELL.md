# 🚀 DEPLOY PHASE 2 ULTRA FROM GCP CLOUD SHELL

**Best Method:** Deploy directly from Google Cloud Shell  
**Advantage:** No local setup needed, gcloud pre-installed & authenticated  
**Time:** 5-10 minutes to deploy

---

## 📋 **PREREQUISITES**

✅ GCP account with billing enabled  
✅ GitHub repo: https://github.com/Panith-qc/Solana_Arbitrage  
✅ Your credentials ready (Helius + Jupiter Ultra keys)

---

## 🚀 **STEP-BY-STEP DEPLOYMENT**

### **STEP 1: Open Cloud Shell**

1. Go to: https://console.cloud.google.com
2. Click the **Cloud Shell icon** (>_) in top-right corner
3. Wait for Cloud Shell to activate

---

### **STEP 2: Clone Your Repository**

```bash
# Clone from GitHub
git clone https://github.com/Panith-qc/Solana_Arbitrage.git

# Navigate to directory
cd Solana_Arbitrage

# Verify files exist
ls -lh deploy-phase2-ultra.sh
```

**Expected output:**
```
-rwxr-xr-x 1 user user 4.6K deploy-phase2-ultra.sh
```

---

### **STEP 3: Set Your Project**

```bash
# List available projects
gcloud projects list

# Set your project (replace with your project ID)
export PROJECT_ID="your-project-id"
gcloud config set project $PROJECT_ID

# Verify
gcloud config get-value project
```

---

### **STEP 4: Enable Required APIs**

```bash
# Enable all required GCP services
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  containerregistry.googleapis.com

echo "✅ APIs enabled!"
```

**This takes 30-60 seconds.**

---

### **STEP 5: Create Secrets**

```bash
# Helius RPC URL
echo "https://mainnet.helius-rpc.com/?api-key=926fd4af-7c9d-4fa3-9504-a2970ac5f16d" | \
  gcloud secrets create helius-rpc-url --data-file=- || echo "Secret already exists"

# Helius API Key
echo "926fd4af-7c9d-4fa3-9504-a2970ac5f16d" | \
  gcloud secrets create helius-api-key --data-file=- || echo "Secret already exists"

# Jupiter Ultra API Key
echo "bca82c35-07e5-4ab0-9a8f-7d23333ffa93" | \
  gcloud secrets create jupiter-ultra-api-key --data-file=- || echo "Secret already exists"

# Jito Tip Accounts
echo "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE,D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ,9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta,5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn,2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD,2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ,wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF,3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT,4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey,4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or" | \
  gcloud secrets create jito-tip-accounts --data-file=- || echo "Secret already exists"

# Verify secrets created
gcloud secrets list

echo "✅ All secrets created!"
```

---

### **STEP 6: Deploy to Cloud Run**

```bash
# Deploy directly from source
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
  --set-env-vars "NODE_ENV=production,JUPITER_ULTRA_ENABLED=true,JUPITER_MEV_PROTECTION=true" \
  --set-secrets "VITE_HELIUS_RPC_URL=helius-rpc-url:latest,HELIUS_API_KEY=helius-api-key:latest,JUPITER_ULTRA_API_KEY=jupiter-ultra-api-key:latest,JITO_TIP_ACCOUNTS=jito-tip-accounts:latest"
```

**This takes 5-8 minutes.**

**Expected output:**
```
Building using Dockerfile...
✓ Creating Container Repository...
✓ Uploading sources...
✓ Building Container...
✓ Pushing Container...
✓ Deploying Container...
✓ Setting IAM Policy...
Done.
Service [solana-mev-bot] revision [solana-mev-bot-00001] has been deployed
Service URL: https://solana-mev-bot-xxxxx-uc.a.run.app
```

---

### **STEP 7: Get Your URL**

```bash
# Get the deployed URL
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format 'value(status.url)'
```

**Copy this URL** - this is your bot's web interface!

---

### **STEP 8: Verify Deployment**

```bash
# Check if service is running
gcloud run services describe solana-mev-bot --region us-central1

# View logs
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --limit 50
```

**Look for these logs:**
```
🚀 Cyclic Arbitrage Service initialized (JUPITER ULTRA)
⚡ Ultra: RPC-less | MEV Protection | Sub-second | 96% success rate
✅ Jupiter Ultra service initialized
🎯 Rate Limiter initialized (PAID tier)
   Max: 1200 req/min | 20 req/sec
```

---

## ✅ **YOU'RE DONE!**

Your Phase 2 Ultra bot is now live on GCP!

**Access it:**
1. Open the URL from Step 7
2. Go to "Phase 2 Auto Trading"
3. Enter your private key
4. Select risk profile
5. Click "Start Phase 2 Trading"

---

## 📊 **MONITORING FROM CLOUD SHELL**

### **View Real-Time Logs:**
```bash
# Stream logs continuously
gcloud run services logs tail solana-mev-bot --region us-central1
```

### **Check Service Status:**
```bash
# Get service details
gcloud run services describe solana-mev-bot --region us-central1

# Get URL
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format 'value(status.url)'
```

### **View Recent Errors:**
```bash
# Show only errors
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --log-filter "severity>=ERROR" \
  --limit 20
```

### **Check Resource Usage:**
```bash
# View metrics
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format "table(
    metadata.name,
    status.conditions.status,
    status.conditions.message
  )"
```

---

## 🔄 **UPDATE DEPLOYMENT**

### **Update from New Code:**
```bash
# Pull latest changes
cd ~/Solana_Arbitrage
git pull origin main

# Redeploy
gcloud run deploy solana-mev-bot \
  --source . \
  --region us-central1
```

### **Update Environment Variables:**
```bash
# Update any env var
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --set-env-vars "NEW_VAR=value"
```

### **Update Secrets:**
```bash
# Update a secret
echo "new-secret-value" | \
  gcloud secrets versions add secret-name --data-file=-

# Service will automatically use new version
```

### **Scale Resources:**
```bash
# Increase resources
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --memory 4Gi \
  --cpu 4 \
  --min-instances 2 \
  --max-instances 5
```

---

## 🛑 **STOP/DELETE SERVICE**

### **Stop (but keep):**
```bash
# Scale to zero
gcloud run services update solana-mev-bot \
  --region us-central1 \
  --min-instances 0 \
  --max-instances 1
```

### **Delete completely:**
```bash
# Delete service
gcloud run services delete solana-mev-bot --region us-central1

# Delete secrets (optional)
gcloud secrets delete helius-rpc-url
gcloud secrets delete helius-api-key
gcloud secrets delete jupiter-ultra-api-key
gcloud secrets delete jito-tip-accounts
```

---

## 🚨 **TROUBLESHOOTING**

### **Issue: "Permission denied"**
```bash
# Check you're using the right project
gcloud config get-value project

# Check permissions
gcloud projects get-iam-policy $PROJECT_ID
```

### **Issue: Build fails**
```bash
# Check build logs
gcloud builds list --limit 5

# View specific build
gcloud builds log <BUILD_ID>
```

### **Issue: Service won't start**
```bash
# Check logs for errors
gcloud run services logs read solana-mev-bot \
  --region us-central1 \
  --limit 100

# Check service description
gcloud run services describe solana-mev-bot --region us-central1
```

### **Issue: Can't access URL**
```bash
# Make sure it's public
gcloud run services add-iam-policy-binding solana-mev-bot \
  --region us-central1 \
  --member="allUsers" \
  --role="roles/run.invoker"
```

---

## 💰 **COST TRACKING**

### **View Current Costs:**
```bash
# Open billing in browser
echo "Visit: https://console.cloud.google.com/billing"

# Check Cloud Run costs
gcloud run services describe solana-mev-bot \
  --region us-central1 \
  --format "value(metadata.name)"
```

### **Set Budget Alerts:**
1. Go to: https://console.cloud.google.com/billing/budgets
2. Create budget: $200/month
3. Set alert at 50%, 90%, 100%

---

## 📱 **QUICK COMMANDS REFERENCE**

```bash
# Get URL
gcloud run services describe solana-mev-bot --region us-central1 --format 'value(status.url)'

# View logs
gcloud run services logs tail solana-mev-bot --region us-central1

# Restart service
gcloud run services update solana-mev-bot --region us-central1 --set-env-vars "RESTART=$(date +%s)"

# Check status
gcloud run services describe solana-mev-bot --region us-central1

# Scale down (save money)
gcloud run services update solana-mev-bot --region us-central1 --min-instances 0

# Scale up (24/7 operation)
gcloud run services update solana-mev-bot --region us-central1 --min-instances 1
```

---

## ✅ **CLOUD SHELL ADVANTAGES**

✅ **No local setup** - Everything pre-installed  
✅ **Already authenticated** - No gcloud login needed  
✅ **Free** - Cloud Shell is free to use  
✅ **Fast upload** - Internal GCP network  
✅ **Persistent** - Home directory persists  

---

## 🎯 **EXPECTED PERFORMANCE**

Once deployed:
- ⚡ **Scan speed:** 1-2 seconds
- ⚡ **API capacity:** 1800 req/min
- ⚡ **Execution:** Sub-second (<1s)
- ⚡ **Success rate:** 96%
- ⚡ **MEV protected:** Yes ✅
- ⚡ **Uptime:** 24/7
- ⚡ **Auto-scaling:** 1-3 instances

---

## 📞 **SUPPORT**

If you need help:
```bash
# Check service is healthy
gcloud run services describe solana-mev-bot --region us-central1

# View recent logs
gcloud run services logs read solana-mev-bot --region us-central1 --limit 50

# Test connection
curl $(gcloud run services describe solana-mev-bot --region us-central1 --format 'value(status.url)')
```

---

**Your Phase 2 Ultra bot will be live in ~10 minutes!** 🚀

*Deploy from Cloud Shell - Easy, Fast, Free!*
