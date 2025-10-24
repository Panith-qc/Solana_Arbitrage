#!/bin/bash
# QUICK DEPLOY SCRIPT FOR GCP CLOUD SHELL
# Copy this entire script into GCP Cloud Shell and run it

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   GCP CLOUD RUN DEPLOYMENT - Solana MEV Bot               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Set project
export PROJECT_ID="solana-mev-bot-476012"
export REGION="us-central1"
export SERVICE_NAME="solana-mev-bot"

echo "📋 Configuration:"
echo "   Project: $PROJECT_ID"
echo "   Region: $REGION"
echo "   Service: $SERVICE_NAME"
echo ""

# Step 1: Clone repository (if not already cloned)
if [ ! -d "Solana_Arbitrage" ]; then
    echo "📦 Step 1/4: Cloning repository..."
    git clone https://github.com/Panith-qc/Solana_Arbitrage.git
    cd Solana_Arbitrage
else
    echo "📦 Step 1/4: Repository already exists, updating..."
    cd Solana_Arbitrage
    git pull origin main
fi

echo "✅ Code ready"
echo ""

# Step 2: Enable APIs
echo "🔧 Step 2/4: Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com

echo "✅ APIs enabled"
echo ""

# Step 3: Deploy to Cloud Run
echo "🚀 Step 3/4: Deploying to Cloud Run..."
echo "   (This will take 5-7 minutes...)"
echo ""

gcloud run deploy $SERVICE_NAME \
  --source . \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 3 \
  --port 8080 \
  --project $PROJECT_ID

# Step 4: Get service URL
echo ""
echo "🌐 Step 4/4: Getting service URL..."
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --project $PROJECT_ID \
  --format 'value(status.url)')

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║              DEPLOYMENT SUCCESSFUL! 🎉                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "✅ Your MEV Trading Bot is now live!"
echo ""
echo "🌐 Service URL:"
echo "   $SERVICE_URL"
echo ""
echo "🔗 Access your bot:"
echo "   1. Open: $SERVICE_URL"
echo "   2. Enter your wallet private key"
echo "   3. Select risk profile (Conservative/Balanced/Aggressive)"
echo "   4. Click 'Start Auto-Trading'"
echo ""
echo "📊 Monitor your bot:"
echo "   View logs: gcloud run services logs read $SERVICE_NAME --region $REGION --follow"
echo "   View metrics: https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME/metrics?project=$PROJECT_ID"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Your automated MEV trading bot is ready! 🚀💰"
echo ""
