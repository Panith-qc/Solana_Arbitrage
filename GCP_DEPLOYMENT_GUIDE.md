# 🚀 GCP CLOUD RUN DEPLOYMENT GUIDE

## 📋 **PRE-REQUISITES**

1. **GCP Account** with billing enabled
2. **gcloud CLI** installed:
   ```bash
   # Install gcloud CLI
   curl https://sdk.cloud.google.com | bash
   exec -l $SHELL
   gcloud init
   ```

3. **Authenticate**:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

---

## 🎯 **DEPLOYMENT OPTIONS**

### **Option 1: Simple One-Command Deploy** (Recommended)

```bash
./deploy-gcp-simple.sh
```

**What it does:**
- Builds the app
- Deploys to Cloud Run
- Sets up auto-scaling
- Returns service URL

**Time:** ~3-5 minutes

---

### **Option 2: Full Deployment with Configuration**

```bash
export GCP_PROJECT_ID="your-project-id"
./deploy-gcp.sh
```

**What it does:**
- Checks authentication
- Enables required APIs
- Builds the application
- Deploys with full configuration
- Provides detailed output

**Features:**
- ✅ 2GB memory, 2 CPU
- ✅ Auto-scaling (0-10 instances)
- ✅ 1-hour timeout
- ✅ Production environment

**Time:** ~5-7 minutes

---

### **Option 3: Deployment with Secrets** (Production)

```bash
export GCP_PROJECT_ID="your-project-id"
./deploy-gcp-with-secrets.sh
```

**What it does:**
- Creates GCP Secret Manager secrets
- Securely stores API keys
- Deploys with environment variables
- Mounts secrets at runtime

**You'll be prompted for:**
1. Helius API key
2. Wallet private key (base58)

**Time:** ~5-7 minutes

---

## 📝 **MANUAL DEPLOYMENT**

If you prefer manual control:

### **Step 1: Authenticate**
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### **Step 2: Enable APIs**
```bash
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
```

### **Step 3: Build**
```bash
pnpm install
pnpm run build
```

### **Step 4: Deploy**
```bash
gcloud run deploy solana-mev-bot \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --port 8080 \
    --memory 2Gi \
    --cpu 2 \
    --timeout 3600
```

### **Step 5: Get URL**
```bash
gcloud run services describe solana-mev-bot \
    --region us-central1 \
    --format="value(status.url)"
```

---

## 🔧 **CONFIGURATION OPTIONS**

### **Change Region:**
```bash
# Edit deploy script or use:
gcloud run deploy solana-mev-bot --region europe-west1 ...
```

**Available regions:**
- `us-central1` (Iowa)
- `us-east1` (South Carolina)
- `us-west1` (Oregon)
- `europe-west1` (Belgium)
- `asia-east1` (Taiwan)

### **Change Memory/CPU:**
```bash
# More power for high-frequency trading:
--memory 4Gi --cpu 4

# Cost-effective for testing:
--memory 1Gi --cpu 1
```

### **Set Min Instances (Always On):**
```bash
# Keep 1 instance always warm (costs more, faster response)
--min-instances 1
```

---

## 💰 **COST ESTIMATE**

### **Default Configuration:**
- **Memory:** 2GB
- **CPU:** 2 vCPU
- **Min Instances:** 0 (scales to zero)
- **Max Instances:** 10

**Estimated Cost:**
- **Idle:** $0/month (scales to zero)
- **Active (24/7):** ~$50-70/month
- **Per request:** $0.0000004 per request

### **With Min Instances = 1:**
- **Base Cost:** ~$50/month (always running)
- **Plus:** Scaling costs for traffic

---

## 🔒 **SECURITY BEST PRACTICES**

### **1. Use Secret Manager:**
```bash
# Create secrets
gcloud secrets create helius-api-key --data-file=-
echo "YOUR_API_KEY" | gcloud secrets create helius-api-key --data-file=-

# Deploy with secrets
gcloud run deploy solana-mev-bot \
    --set-secrets "VITE_HELIUS_API_KEY=helius-api-key:latest"
```

### **2. Restrict Access:**
```bash
# Remove public access
gcloud run services remove-iam-policy-binding solana-mev-bot \
    --region us-central1 \
    --member="allUsers" \
    --role="roles/run.invoker"

# Add specific user
gcloud run services add-iam-policy-binding solana-mev-bot \
    --region us-central1 \
    --member="user:your-email@gmail.com" \
    --role="roles/run.invoker"
```

### **3. Enable VPC Connector (Optional):**
For private database/API access

---

## 📊 **MONITORING**

### **View Logs:**
```bash
# Real-time logs
gcloud run services logs read solana-mev-bot \
    --region us-central1 \
    --follow

# Filter by severity
gcloud run services logs read solana-mev-bot \
    --region us-central1 \
    --format="value(textPayload)" \
    --severity=ERROR
```

### **View Metrics:**
```bash
# Open Cloud Console
gcloud run services describe solana-mev-bot \
    --region us-central1 \
    --format="value(status.url)"
```

### **Dashboard:**
https://console.cloud.google.com/run

---

## 🔄 **UPDATE DEPLOYMENT**

### **Deploy New Version:**
```bash
# Simple update
./deploy-gcp-simple.sh

# Or manual
gcloud run deploy solana-mev-bot --source .
```

### **Rollback:**
```bash
# List revisions
gcloud run revisions list --service solana-mev-bot --region us-central1

# Rollback to previous
gcloud run services update-traffic solana-mev-bot \
    --region us-central1 \
    --to-revisions REVISION_NAME=100
```

---

## 🧪 **TESTING DEPLOYMENT**

### **1. Check Health:**
```bash
SERVICE_URL=$(gcloud run services describe solana-mev-bot --region us-central1 --format="value(status.url)")
curl $SERVICE_URL
```

### **2. View in Browser:**
```bash
# Open in browser
gcloud run services describe solana-mev-bot \
    --region us-central1 \
    --format="value(status.url)" | xargs open
```

### **3. Test Trading:**
1. Open service URL
2. Connect wallet
3. Start Phase 2 Auto Trading
4. Watch console logs:
   ```bash
   gcloud run services logs read solana-mev-bot --region us-central1 --follow
   ```

---

## ❌ **TROUBLESHOOTING**

### **Build Fails:**
```bash
# Check build logs
gcloud builds list --limit 5

# View specific build
gcloud builds log BUILD_ID
```

### **Service Not Responding:**
```bash
# Check service status
gcloud run services describe solana-mev-bot --region us-central1

# Check recent logs
gcloud run services logs read solana-mev-bot --region us-central1 --limit 50
```

### **Memory/CPU Issues:**
```bash
# Increase resources
gcloud run services update solana-mev-bot \
    --region us-central1 \
    --memory 4Gi \
    --cpu 4
```

### **Timeout Issues:**
```bash
# Increase timeout to max (1 hour)
gcloud run services update solana-mev-bot \
    --region us-central1 \
    --timeout 3600
```

---

## 🗑️ **DELETE SERVICE**

```bash
# Delete Cloud Run service
gcloud run services delete solana-mev-bot --region us-central1

# Delete secrets (optional)
gcloud secrets delete helius-api-key
gcloud secrets delete wallet-private-key
```

---

## 📚 **USEFUL COMMANDS**

```bash
# List all services
gcloud run services list

# Describe service
gcloud run services describe solana-mev-bot --region us-central1

# View service URL
gcloud run services describe solana-mev-bot \
    --region us-central1 \
    --format="value(status.url)"

# Update environment variables
gcloud run services update solana-mev-bot \
    --region us-central1 \
    --set-env-vars "KEY=VALUE"

# View service IAM policy
gcloud run services get-iam-policy solana-mev-bot --region us-central1
```

---

## 🎉 **SUCCESS CHECKLIST**

After deployment, verify:
- [ ] Service URL is accessible
- [ ] Web UI loads correctly
- [ ] Wallet connection works
- [ ] Strategies show as "enabled"
- [ ] No console errors
- [ ] Rate limiter working (no 500 errors)
- [ ] Real opportunities detected
- [ ] Trades can be executed

---

## 📞 **SUPPORT**

**GCP Issues:**
- https://console.cloud.google.com/support
- https://cloud.google.com/run/docs

**Bot Issues:**
- Check `/workspace/CRITICAL_BUGS_FOUND.md`
- Check `/workspace/DEPLOYMENT_READY_CONFIRMATION.md`

---

# 🚀 **QUICK START**

```bash
# 1. Set project
export GCP_PROJECT_ID="your-project-id"

# 2. Deploy
./deploy-gcp-simple.sh

# 3. Done! 🎉
```

**That's it! Your bot is live!** 💎
