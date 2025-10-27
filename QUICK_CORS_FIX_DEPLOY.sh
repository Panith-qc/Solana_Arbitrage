#!/bin/bash

# 🚀 Quick CORS Fix Deployment Script
# Deploys the updated server.js with CORS fixes to Cloud Run

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║   CORS FIX - QUICK DEPLOYMENT TO CLOUD RUN         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check if GCP_PROJECT_ID is set
if [ -z "$GCP_PROJECT_ID" ]; then
  echo -e "${YELLOW}⚠️  GCP_PROJECT_ID not set. Using default: solana-mev-bot-476012${NC}"
  export GCP_PROJECT_ID="solana-mev-bot-476012"
fi

echo -e "${YELLOW}📋 Configuration:${NC}"
echo "   Project: $GCP_PROJECT_ID"
echo "   Region: us-central1"
echo "   Service: solana-mev-bot"
echo ""

# Step 1: Test locally first (optional)
read -p "Test locally before deploying? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}🧪 Testing locally...${NC}"
  
  # Check if node is installed
  if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install Node.js first.${NC}"
    exit 1
  fi
  
  # Start server in background
  echo "Starting server..."
  node server.js &
  SERVER_PID=$!
  
  # Wait for server to start
  sleep 3
  
  # Test CORS
  echo -e "${YELLOW}Testing CORS configuration...${NC}"
  
  # Test health endpoint
  if curl -s http://localhost:8080/api/health > /dev/null; then
    echo -e "${GREEN}✅ Health endpoint working${NC}"
  else
    echo -e "${RED}❌ Health endpoint failed${NC}"
    kill $SERVER_PID
    exit 1
  fi
  
  # Test OPTIONS preflight
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Origin: http://localhost:8080" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    -X OPTIONS \
    http://localhost:8080/api/swap)
  
  if [ "$response" == "200" ]; then
    echo -e "${GREEN}✅ CORS preflight working${NC}"
  else
    echo -e "${RED}❌ CORS preflight failed (HTTP $response)${NC}"
    kill $SERVER_PID
    exit 1
  fi
  
  # Stop server
  kill $SERVER_PID
  echo -e "${GREEN}✅ Local tests passed!${NC}"
  echo ""
fi

# Step 2: Deploy to Cloud Run
echo -e "${YELLOW}🚀 Deploying to Cloud Run...${NC}"
echo ""

gcloud run deploy solana-mev-bot \
  --source . \
  --region us-central1 \
  --project $GCP_PROJECT_ID \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --port 8080 \
  --timeout 300 \
  --concurrency 80 \
  --set-env-vars "NODE_ENV=production" \
  --quiet

if [ $? -eq 0 ]; then
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║           DEPLOYMENT SUCCESSFUL! ✅                   ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  
  # Get service URL
  SERVICE_URL=$(gcloud run services describe solana-mev-bot \
    --region us-central1 \
    --project $GCP_PROJECT_ID \
    --format 'value(status.url)')
  
  echo -e "${GREEN}🌐 Your service is live at:${NC}"
  echo "   $SERVICE_URL"
  echo ""
  
  echo -e "${YELLOW}📊 Testing deployed service...${NC}"
  echo ""
  
  # Test health endpoint
  if curl -s "$SERVICE_URL/api/health" > /dev/null; then
    echo -e "${GREEN}✅ Health endpoint: Working${NC}"
  else
    echo -e "${RED}❌ Health endpoint: Failed${NC}"
  fi
  
  # Test CORS
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Origin: $SERVICE_URL" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    -X OPTIONS \
    "$SERVICE_URL/api/swap")
  
  if [ "$response" == "200" ]; then
    echo -e "${GREEN}✅ CORS configuration: Working${NC}"
  else
    echo -e "${YELLOW}⚠️  CORS configuration: Check logs (HTTP $response)${NC}"
  fi
  
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║              NEXT STEPS                              ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "1. Open your service:"
  echo "   $SERVICE_URL"
  echo ""
  echo "2. View logs:"
  echo "   gcloud run services logs read solana-mev-bot --region us-central1"
  echo ""
  echo "3. Monitor requests:"
  echo "   Watch for '[TIMESTAMP] METHOD /path - Origin: ...' in logs"
  echo ""
  echo "4. Test CORS from browser:"
  echo "   - Open browser console (F12)"
  echo "   - Check for CORS errors (should be none)"
  echo ""
  echo -e "${GREEN}✅ CORS issues should now be resolved!${NC}"
  echo ""
  
else
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║           DEPLOYMENT FAILED ❌                        ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Check the error above and try again."
  echo ""
  echo "Common issues:"
  echo "1. Not authenticated: Run 'gcloud auth login'"
  echo "2. Project not set: Set GCP_PROJECT_ID"
  echo "3. Billing not enabled: Enable billing in GCP console"
  echo ""
  exit 1
fi
