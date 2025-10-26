#!/bin/bash

# ═══════════════════════════════════════════════════════════
# SOLANA MEV BOT - REAL GCP DEPLOYMENT
# ═══════════════════════════════════════════════════════════
# Deploys to Google Cloud Storage with public access
# ═══════════════════════════════════════════════════════════

set -e

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║     SOLANA MEV BOT - GCP DEPLOYMENT (REAL)             ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 1: GET PROJECT ID
# ═══════════════════════════════════════════════════════════
PROJECT_ID=$(gcloud config get-value project)
BUCKET_NAME="solana-mev-bot-${PROJECT_ID}"

echo "🔍 Project ID: $PROJECT_ID"
echo "📦 Bucket Name: $BUCKET_NAME"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 2: INSTALL PNPM & DEPENDENCIES
# ═══════════════════════════════════════════════════════════
echo "📦 Installing dependencies..."
cd ~/Solana_Arbitrage

if ! command -v pnpm &> /dev/null; then
    npm install -g pnpm 2>/dev/null || USE_NPM=true
fi

if [ "$USE_NPM" = true ]; then
    npm install
else
    pnpm install
fi

# ═══════════════════════════════════════════════════════════
# STEP 3: BUILD PROJECT
# ═══════════════════════════════════════════════════════════
echo ""
echo "🔨 Building project..."

if [ "$USE_NPM" = true ]; then
    npm run build
else
    pnpm run build
fi

if [ ! -d "dist" ]; then
    echo "❌ Build failed!"
    exit 1
fi

echo "✅ Build successful!"

# ═══════════════════════════════════════════════════════════
# STEP 4: CREATE/CONFIGURE BUCKET
# ═══════════════════════════════════════════════════════════
echo ""
echo "☁️  Setting up Cloud Storage bucket..."

# Create bucket (ignore error if exists)
gsutil mb gs://$BUCKET_NAME/ 2>/dev/null || echo "Bucket already exists"

# Enable website configuration
gsutil web set -m index.html -e index.html gs://$BUCKET_NAME

# Make bucket public
gsutil iam ch allUsers:objectViewer gs://$BUCKET_NAME

echo "✅ Bucket configured!"

# ═══════════════════════════════════════════════════════════
# STEP 5: UPLOAD FILES
# ═══════════════════════════════════════════════════════════
echo ""
echo "📤 Uploading files to Cloud Storage..."

# Delete old files
gsutil -m rm gs://$BUCKET_NAME/** 2>/dev/null || true

# Upload new files
gsutil -m cp -r dist/* gs://$BUCKET_NAME/

# Set cache control
gsutil -m setmeta -h "Cache-Control:public, max-age=3600" gs://$BUCKET_NAME/**

echo "✅ Upload complete!"

# ═══════════════════════════════════════════════════════════
# STEP 6: GET PUBLIC URL
# ═══════════════════════════════════════════════════════════
echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║              🎉 DEPLOYMENT SUCCESSFUL! 🎉              ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "🌐 YOUR BOT IS LIVE AT:"
echo ""
echo "   https://storage.googleapis.com/$BUCKET_NAME/index.html"
echo ""
echo "🔗 ALTERNATIVE URL:"
echo "   https://storage.cloud.google.com/$BUCKET_NAME/index.html"
echo ""
echo "📋 TO UPDATE:"
echo "   cd ~/Solana_Arbitrage"
echo "   git pull origin main"
echo "   bash DEPLOY_GCP_REAL.sh"
echo ""
echo "🗑️  TO DELETE:"
echo "   gsutil rm -r gs://$BUCKET_NAME"
echo ""
echo "════════════════════════════════════════════════════════"
echo ""
echo "✅ Bot is now publicly accessible on the internet!"
echo ""
