#!/bin/bash

# ═══════════════════════════════════════════════════════════
# UPDATE EXISTING CLOUD RUN DEPLOYMENT
# ═══════════════════════════════════════════════════════════
# Just rebuild and redeploy to your existing Cloud Run URL
# ═══════════════════════════════════════════════════════════

set -e

PROJECT_ID=$(gcloud config get-value project)
SERVICE_NAME="solana-mev-bot"
REGION="us-central1"

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║         UPDATING CLOUD RUN DEPLOYMENT                  ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "🔍 Project: $PROJECT_ID"
echo "🚀 Service: $SERVICE_NAME"
echo "🌎 Region: $REGION"
echo ""

cd ~/Solana_Arbitrage

# Build and deploy
echo "🔨 Building Docker image..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/$SERVICE_NAME

echo ""
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image gcr.io/$PROJECT_ID/$SERVICE_NAME \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 3600 \
  --max-instances 10 \
  --quiet

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║              ✅ DEPLOYMENT COMPLETE!                   ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "🌐 YOUR BOT IS LIVE AT:"
echo ""
echo "   https://solana-mev-bot-gycvc2tvxq-uc.a.run.app/"
echo ""
echo "🔄 Changes are now live!"
echo ""
