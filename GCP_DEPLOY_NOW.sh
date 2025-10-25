#!/bin/bash
# ═══════════════════════════════════════════════════════════
# SOLANA MEV BOT - GCP CLOUD RUN DEPLOYMENT SCRIPT
# ═══════════════════════════════════════════════════════════
# Copy this entire script and paste into GCP Cloud Shell
# Then run: bash GCP_DEPLOY_NOW.sh
# ═══════════════════════════════════════════════════════════

set -e  # Exit on any error

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         SOLANA MEV BOT - GCP DEPLOYMENT                   ║"
echo "║         Real-Time Trading with Full Visibility            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════

# Set your GCP project ID here (or it will use current project)
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project)}"
REGION="us-central1"
SERVICE_NAME="solana-mev-bot"

if [ -z "$PROJECT_ID" ]; then
    echo "❌ ERROR: No GCP project set!"
    echo "   Run: gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi

echo "📋 Deployment Configuration:"
echo "   ├─ Project ID: $PROJECT_ID"
echo "   ├─ Region: $REGION"
echo "   └─ Service Name: $SERVICE_NAME"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 1: CLONE/UPDATE REPOSITORY
# ═══════════════════════════════════════════════════════════

echo "📦 STEP 1/4: Getting latest code..."
echo ""

if [ -d "Solana_Arbitrage" ]; then
    echo "   Repository exists, updating..."
    cd Solana_Arbitrage
    git fetch origin
    git reset --hard origin/main
    git pull origin main
    echo "   ✅ Code updated to latest version"
else
    echo "   Cloning repository..."
    git clone https://github.com/Panith-qc/Solana_Arbitrage.git
    cd Solana_Arbitrage
    echo "   ✅ Repository cloned"
fi

echo ""
echo "   Current commit: $(git log -1 --oneline)"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 2: ENABLE REQUIRED GCP APIS
# ═══════════════════════════════════════════════════════════

echo "🔧 STEP 2/4: Enabling required GCP APIs..."
echo ""

APIS=(
    "cloudbuild.googleapis.com"
    "run.googleapis.com"
    "containerregistry.googleapis.com"
    "artifactregistry.googleapis.com"
)

for api in "${APIS[@]}"; do
    echo "   Enabling $api..."
    gcloud services enable $api --project=$PROJECT_ID 2>/dev/null || echo "   (already enabled)"
done

echo ""
echo "   ✅ All APIs enabled"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 3: BUILD & DEPLOY TO CLOUD RUN
# ═══════════════════════════════════════════════════════════

echo "🚀 STEP 3/4: Building and deploying to Cloud Run..."
echo "   ⏱️  This will take 5-7 minutes..."
echo ""

# Deploy with optimal settings for trading bot
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

echo ""
echo "   ✅ Deployment successful!"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 4: GET SERVICE URL AND DISPLAY INFO
# ═══════════════════════════════════════════════════════════

echo "🌐 STEP 4/4: Getting service information..."
echo ""

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
echo "✅ Your Solana MEV Trading Bot is now LIVE!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 SERVICE URL:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   $SERVICE_URL"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 HOW TO START TRADING:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   1. Open URL above in your browser"
echo "   2. Enter your Solana wallet private key"
echo "   3. Select risk profile:"
echo "      • Conservative (safer, smaller trades)"
echo "      • Balanced (recommended for most users)"
echo "      • Aggressive (higher risk, larger trades)"
echo "   4. Click 'Start Auto-Trading'"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 MONITORING YOUR BOT:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   View Real-Time Logs:"
echo "   gcloud run services logs read $SERVICE_NAME --region $REGION --follow"
echo ""
echo "   View Metrics Dashboard:"
echo "   https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME/metrics?project=$PROJECT_ID"
echo ""
echo "   View All Services:"
echo "   https://console.cloud.google.com/run?project=$PROJECT_ID"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎯 WHAT YOU'LL SEE IN CONSOLE:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   Every 3 seconds:"
echo "   🔍 MEV SCAN - Checking tokens..."
echo "      🔄 SOL → JUP → SOL"
echo "      👉 Profit: $X.XX | ✅ or ❌"
echo ""
echo "   When opportunity found:"
echo "   💰 FOUND PROFITABLE OPPORTUNITY!"
echo "   🚀 EXECUTING TRADE..."
echo "   ✅ Trade complete - Profit: $X.XX"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚙️  BOT FEATURES:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   ✅ Real-time scanning every 3 seconds"
echo "   ✅ 5x faster with parallel execution"
echo "   ✅ Full visibility of all checks"
echo "   ✅ Automatic profit calculations"
echo "   ✅ MEV strategies: Arbitrage, Backrun, JIT, etc."
echo "   ✅ Jito bundles for atomic execution"
echo "   ✅ Dynamic priority fees"
echo "   ✅ Risk management & stop-loss"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💡 HELPFUL COMMANDS:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   # View logs in real-time"
echo "   gcloud run services logs read $SERVICE_NAME --region $REGION --follow"
echo ""
echo "   # Update to latest version"
echo "   cd Solana_Arbitrage && git pull && bash GCP_DEPLOY_NOW.sh"
echo ""
echo "   # Delete service"
echo "   gcloud run services delete $SERVICE_NAME --region $REGION"
echo ""
echo "   # View service details"
echo "   gcloud run services describe $SERVICE_NAME --region $REGION"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🎉 Your automated MEV trading bot is ready!"
echo "   Open the URL above and start trading! 🚀💰"
echo ""
echo "════════════════════════════════════════════════════════════"
