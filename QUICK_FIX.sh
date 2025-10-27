#!/bin/bash
# IMMEDIATE FIX - Run this in your GCP Cloud Shell

echo "🔧 FIXING YOUR DEPLOYMENT ERROR..."
echo ""

# Build locally first
echo "📦 Building locally (this ensures dist/ exists)..."
pnpm install
pnpm run build

echo "📝 Ensuring backend Dockerfile (Express) is used..."
if grep -q "CMD \[\"node\", \"server.js\"\]" Dockerfile ; then
  echo "✅ Backend Dockerfile detected"
else
  echo "⚠️ Dockerfile not configured for Express. Using repository Dockerfile (expects server.js)."
fi

# Deploy
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy solana-mev-bot \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --port 8080 \
    --memory 2Gi \
    --cpu 2 \
    --timeout 300

echo ""
echo "✅ DONE! Check the URL above!"
