#!/bin/bash

###############################################################################
# DEPLOY FIXED BOT TO GCP - WITH CRITICAL FIX
# This script deploys the bot with the SOL→Token→SOL cycle fix
###############################################################################

set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   DEPLOYING FIXED SOLANA MEV BOT TO GCP CLOUD RUN           ║"
echo "║   Fix: Scanner now checks complete SOL→Token→SOL cycles     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found!"
    echo "Install it: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Get GCP project ID
if [ -z "$GCP_PROJECT_ID" ]; then
    echo "📋 Enter your GCP Project ID:"
    read -r GCP_PROJECT_ID
fi

echo "📦 Project: $GCP_PROJECT_ID"
echo ""

# Set project
gcloud config set project "$GCP_PROJECT_ID"

echo "🔨 Building application..."
pnpm run build

echo ""
echo "🚀 Deploying to Cloud Run..."
echo "   This will take 3-5 minutes..."
echo ""

gcloud run deploy solana-mev-bot \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --port 8080 \
  --timeout 3600 \
  --min-instances 0 \
  --max-instances 5 \
  --set-env-vars "NODE_ENV=production"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ✅ DEPLOYMENT COMPLETE!                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "🔗 Your bot is now live!"
echo "📊 Check logs: gcloud run logs tail solana-mev-bot --region us-central1"
echo ""
echo "⚠️  IMPORTANT:"
echo "   The bot now ONLY finds complete SOL→Token→SOL cycles"
echo "   You start with SOL, end with MORE SOL ✅"
echo ""
