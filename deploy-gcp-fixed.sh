#!/bin/bash

###############################################################################
# FIXED GCP DEPLOYMENT - BUILD FIRST, THEN DEPLOY
###############################################################################

set -e

echo "🔧 FIXING DEPLOYMENT ISSUE..."
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Step 1: Build locally first
echo -e "${YELLOW}📦 Step 1: Building application locally...${NC}"
pnpm install
pnpm run build
echo -e "${GREEN}✅ Build complete!${NC}"
echo ""

# Step 2: Use production Dockerfile
echo -e "${YELLOW}📝 Step 2: Using production Dockerfile...${NC}"
cp Dockerfile.production Dockerfile
echo -e "${GREEN}✅ Dockerfile ready${NC}"
echo ""

# Step 3: Deploy to Cloud Run
echo -e "${YELLOW}🚀 Step 3: Deploying to Cloud Run...${NC}"
gcloud run deploy solana-mev-bot \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --port 5173 \
    --memory 2Gi \
    --cpu 2 \
    --timeout 300 \
    --max-instances 10 \
    --set-env-vars "NODE_ENV=production"

echo ""
echo -e "${GREEN}✅ DEPLOYMENT SUCCESSFUL!${NC}"
echo ""

# Get service URL
SERVICE_URL=$(gcloud run services describe solana-mev-bot --region=us-central1 --format="value(status.url)")
echo -e "${BLUE}🌐 Service URL:${NC} $SERVICE_URL"
echo ""
echo -e "${GREEN}🎉 Your bot is LIVE!${NC}"
