#!/bin/bash

###############################################################################
# GCP DEPLOYMENT WITH SECRET MANAGER
# Securely deploy with environment variables and secrets
###############################################################################

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ID="${GCP_PROJECT_ID:-your-gcp-project-id}"
SERVICE_NAME="solana-mev-bot"
REGION="us-central1"

echo -e "${BLUE}🔐 Deploying with Secret Manager${NC}"
echo ""

# Create secrets (if they don't exist)
echo -e "${YELLOW}📝 Setting up secrets...${NC}"

# Check if Helius API key secret exists
if ! gcloud secrets describe helius-api-key --project="$PROJECT_ID" &> /dev/null; then
    echo -e "${YELLOW}Creating Helius API key secret...${NC}"
    echo "Enter your Helius API key:"
    read -s HELIUS_API_KEY
    echo -n "$HELIUS_API_KEY" | gcloud secrets create helius-api-key \
        --data-file=- \
        --project="$PROJECT_ID"
    echo -e "${GREEN}✅ Helius API key secret created${NC}"
else
    echo -e "${GREEN}✅ Helius API key secret already exists${NC}"
fi

# Check if wallet private key secret exists
if ! gcloud secrets describe wallet-private-key --project="$PROJECT_ID" &> /dev/null; then
    echo -e "${YELLOW}Creating wallet private key secret...${NC}"
    echo "Enter your wallet private key (base58):"
    read -s WALLET_PRIVATE_KEY
    echo -n "$WALLET_PRIVATE_KEY" | gcloud secrets create wallet-private-key \
        --data-file=- \
        --project="$PROJECT_ID"
    echo -e "${GREEN}✅ Wallet private key secret created${NC}"
else
    echo -e "${GREEN}✅ Wallet private key secret already exists${NC}"
fi

echo ""
echo -e "${YELLOW}🚀 Deploying to Cloud Run with secrets...${NC}"

# Deploy with secret mounting
gcloud run deploy "$SERVICE_NAME" \
    --source . \
    --region "$REGION" \
    --platform managed \
    --allow-unauthenticated \
    --port 5173 \
    --memory 2Gi \
    --cpu 2 \
    --min-instances 0 \
    --max-instances 10 \
    --timeout 3600 \
    --set-env-vars "NODE_ENV=production" \
    --set-secrets "VITE_HELIUS_API_KEY=helius-api-key:latest,VITE_WALLET_PRIVATE_KEY=wallet-private-key:latest"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format="value(status.url)")

echo ""
echo -e "${GREEN}✅ Deployment with secrets complete!${NC}"
echo -e "${BLUE}🌐 Service URL:${NC} $SERVICE_URL"
echo ""
