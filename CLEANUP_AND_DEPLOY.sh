#!/bin/bash
# ═══════════════════════════════════════════════════════════
# CLEANUP & DEPLOY - Fix nested directories and disk space
# ═══════════════════════════════════════════════════════════

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         CLEANUP & FRESH DEPLOYMENT                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 1: CLEANUP - Go to home directory
# ═══════════════════════════════════════════════════════════

echo "🧹 STEP 1/5: Cleaning up nested directories..."
cd ~

# Remove all nested Solana_Arbitrage directories
if [ -d "Solana_Arbitrage" ]; then
    echo "   Removing old directories..."
    rm -rf Solana_Arbitrage
    echo "   ✅ Cleanup complete"
else
    echo "   ✅ No cleanup needed"
fi

echo ""

# ═══════════════════════════════════════════════════════════
# STEP 2: FREE UP SPACE
# ═══════════════════════════════════════════════════════════

echo "💾 STEP 2/5: Checking disk space..."
df -h ~ | grep -v Filesystem

echo ""
echo "   Cleaning up Docker (if present)..."
docker system prune -af 2>/dev/null || echo "   (Docker not available, skipping)"

echo ""
echo "   Cleaning up package caches..."
rm -rf ~/.cache/* 2>/dev/null || true

echo ""
echo "   ✅ Space cleanup complete"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 3: CLONE FRESH COPY
# ═══════════════════════════════════════════════════════════

echo "📦 STEP 3/5: Cloning fresh repository..."
git clone --depth 1 https://github.com/Panith-qc/Solana_Arbitrage.git
cd Solana_Arbitrage

echo "   ✅ Fresh code ready"
echo ""
echo "   Current location: $(pwd)"
echo "   Latest commit: $(git log -1 --oneline)"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 4: VERIFY PROJECT
# ═══════════════════════════════════════════════════════════

echo "🔍 STEP 4/5: Verifying project structure..."

# Check for required files
REQUIRED_FILES=("package.json" "Dockerfile" "index.html")
ALL_PRESENT=true

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "   ✅ $file"
    else
        echo "   ❌ $file (MISSING!)"
        ALL_PRESENT=false
    fi
done

if [ "$ALL_PRESENT" = false ]; then
    echo ""
    echo "❌ ERROR: Some required files are missing!"
    echo "   Please check your repository."
    exit 1
fi

echo ""
echo "   ✅ Project structure verified"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 5: DEPLOY
# ═══════════════════════════════════════════════════════════

echo "🚀 STEP 5/5: Deploying to Cloud Run..."
echo "   ⏱️  This will take 5-7 minutes..."
echo ""

# Set project
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
REGION="us-central1"
SERVICE_NAME="solana-mev-bot"

if [ -z "$PROJECT_ID" ]; then
    echo "❌ ERROR: No GCP project set!"
    echo "   Run: gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi

echo "   Project: $PROJECT_ID"
echo "   Region: $REGION"
echo "   Service: $SERVICE_NAME"
echo ""

# Enable APIs (silently)
echo "   Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com --quiet 2>/dev/null || true
gcloud services enable run.googleapis.com --quiet 2>/dev/null || true
gcloud services enable artifactregistry.googleapis.com --quiet 2>/dev/null || true

# Deploy
gcloud run deploy $SERVICE_NAME \
  --source . \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --timeout 3600 \
  --port 8080 \
  --project $PROJECT_ID \
  --quiet

# Get service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --project $PROJECT_ID \
  --format 'value(status.url)')

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║              🎉 DEPLOYMENT SUCCESSFUL! 🎉                  ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "✅ Your MEV Trading Bot is now LIVE!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 SERVICE URL:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   $SERVICE_URL"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 NEXT STEPS:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   1. Open the URL above in your browser"
echo "   2. Enter your wallet private key"
echo "   3. Select risk profile (Balanced recommended)"
echo "   4. Click 'Start Phase 2 Trading'"
echo "   5. Open browser console (F12) to see real-time activity"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 MONITORING:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   View logs:"
echo "   gcloud run services logs read $SERVICE_NAME --region $REGION --follow"
echo ""
echo "   View metrics:"
echo "   https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME/metrics?project=$PROJECT_ID"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🎉 Ready to trade! 🚀💰"
echo ""
