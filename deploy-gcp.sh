#!/bin/bash
# GCP Cloud Run Deployment Script
# Deploys Solana MEV Trading Bot to Google Cloud Platform

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   GCP Cloud Run Deployment - Solana MEV Trading Bot       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-your-project-id}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="solana-mev-bot"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Validate GCP CLI
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}❌ gcloud CLI not found. Please install it first.${NC}"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

echo -e "${GREEN}✅ gcloud CLI found${NC}"
echo ""

# Validate project ID
if [ "$PROJECT_ID" == "your-project-id" ]; then
    echo -e "${RED}❌ Please set GCP_PROJECT_ID environment variable${NC}"
    echo "   export GCP_PROJECT_ID=your-actual-project-id"
    exit 1
fi

echo "📋 Configuration:"
echo "   Project ID: $PROJECT_ID"
echo "   Region: $REGION"
echo "   Service Name: $SERVICE_NAME"
echo ""

# Confirm deployment
read -p "🤔 Deploy to GCP Cloud Run? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo -e "${YELLOW}❌ Deployment cancelled${NC}"
    exit 0
fi

echo ""
echo "🚀 Starting deployment process..."
echo ""

# Step 1: Build the application
echo "📦 Step 1/5: Building application..."
pnpm install --legacy-peer-deps || {
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
}

pnpm run build || {
    echo -e "${RED}❌ Failed to build application${NC}"
    exit 1
}

echo -e "${GREEN}✅ Application built successfully${NC}"
echo ""

# Step 2: Build Docker image
echo "🐳 Step 2/5: Building Docker image..."
docker build -t ${IMAGE_NAME}:latest . || {
    echo -e "${RED}❌ Failed to build Docker image${NC}"
    exit 1
}

echo -e "${GREEN}✅ Docker image built${NC}"
echo ""

# Step 3: Push to Container Registry
echo "☁️  Step 3/5: Pushing image to GCR..."
docker push ${IMAGE_NAME}:latest || {
    echo -e "${RED}❌ Failed to push Docker image${NC}"
    exit 1
}

echo -e "${GREEN}✅ Image pushed to Container Registry${NC}"
echo ""

# Step 4: Deploy to Cloud Run
echo "🚀 Step 4/5: Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
    --image ${IMAGE_NAME}:latest \
    --platform managed \
    --region ${REGION} \
    --allow-unauthenticated \
    --memory 2Gi \
    --cpu 2 \
    --min-instances 1 \
    --max-instances 3 \
    --port 8080 \
    --timeout 300 \
    --project ${PROJECT_ID} || {
    echo -e "${RED}❌ Failed to deploy to Cloud Run${NC}"
    exit 1
}

echo -e "${GREEN}✅ Deployed to Cloud Run${NC}"
echo ""

# Step 5: Get service URL
echo "🌐 Step 5/5: Getting service URL..."
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --platform managed \
    --region ${REGION} \
    --project ${PROJECT_ID} \
    --format 'value(status.url)')

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║              DEPLOYMENT SUCCESSFUL! 🎉                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✅ Your MEV Trading Bot is now live!${NC}"
echo ""
echo "📍 Service URL:"
echo "   ${SERVICE_URL}"
echo ""
echo "🔗 Access your bot:"
echo "   1. Open: ${SERVICE_URL}"
echo "   2. Connect your wallet"
echo "   3. Start trading!"
echo ""
echo "📊 Monitor your deployment:"
echo "   Cloud Run Console:"
echo "   https://console.cloud.google.com/run/detail/${REGION}/${SERVICE_NAME}/metrics?project=${PROJECT_ID}"
echo ""
echo "📝 Logs:"
echo "   gcloud logs tail --service=${SERVICE_NAME}"
echo ""
echo "⚠️  IMPORTANT REMINDERS:"
echo "   - Start with small amounts (0.1-1 SOL)"
echo "   - Monitor performance closely"
echo "   - Keep auto-trading disabled initially"
echo "   - Review logs regularly"
echo ""
echo "═══════════════════════════════════════════════════════════"
