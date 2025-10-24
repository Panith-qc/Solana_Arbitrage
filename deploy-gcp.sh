#!/bin/bash

###############################################################################
# GCP CLOUD RUN DEPLOYMENT SCRIPT
# Solana MEV Trading Bot - Production Deployment
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-your-gcp-project-id}"
SERVICE_NAME="solana-mev-bot"
REGION="us-central1"
MEMORY="2Gi"
CPU="2"
MIN_INSTANCES="0"
MAX_INSTANCES="10"
PORT="5173"

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   SOLANA MEV TRADING BOT - GCP CLOUD RUN DEPLOYMENT         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo -e "${RED}❌ gcloud CLI not found. Please install it first:${NC}"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if user is authenticated
echo -e "${YELLOW}🔐 Checking GCP authentication...${NC}"
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &> /dev/null; then
    echo -e "${RED}❌ Not authenticated. Please run: gcloud auth login${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Authenticated${NC}"
echo ""

# Set project
echo -e "${YELLOW}📦 Setting GCP project...${NC}"
if [ "$PROJECT_ID" = "your-gcp-project-id" ]; then
    echo -e "${RED}❌ Please set GCP_PROJECT_ID environment variable${NC}"
    echo "   export GCP_PROJECT_ID=your-actual-project-id"
    exit 1
fi

gcloud config set project "$PROJECT_ID"
echo -e "${GREEN}✅ Project set to: $PROJECT_ID${NC}"
echo ""

# Enable required APIs
echo -e "${YELLOW}🔧 Enabling required GCP APIs...${NC}"
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    containerregistry.googleapis.com \
    artifactregistry.googleapis.com
echo -e "${GREEN}✅ APIs enabled${NC}"
echo ""

# Build the application
echo -e "${YELLOW}🏗️  Building application...${NC}"
pnpm install
pnpm run build
echo -e "${GREEN}✅ Build complete${NC}"
echo ""

# Deploy to Cloud Run
echo -e "${YELLOW}🚀 Deploying to Cloud Run...${NC}"
echo -e "${BLUE}   Service: $SERVICE_NAME${NC}"
echo -e "${BLUE}   Region: $REGION${NC}"
echo -e "${BLUE}   Memory: $MEMORY${NC}"
echo -e "${BLUE}   CPU: $CPU${NC}"
echo ""

gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --port "$PORT" \
    --memory "$MEMORY" \
    --cpu "$CPU" \
    --min-instances "$MIN_INSTANCES" \
    --max-instances "$MAX_INSTANCES" \
    --set-env-vars "NODE_ENV=production" \
    --timeout 3600 \
    --concurrency 80

# Get service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)")

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                 ✅ DEPLOYMENT SUCCESSFUL! ✅                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}🌐 Service URL:${NC} $SERVICE_URL"
echo -e "${BLUE}📊 Console:${NC} https://console.cloud.google.com/run/detail/$REGION/$SERVICE_NAME?project=$PROJECT_ID"
echo ""
echo -e "${YELLOW}📝 Next Steps:${NC}"
echo "   1. Open the service URL in your browser"
echo "   2. Connect your wallet"
echo "   3. Start trading with Phase 2 strategies"
echo ""
echo -e "${GREEN}🎉 Happy Trading! 💎${NC}"
