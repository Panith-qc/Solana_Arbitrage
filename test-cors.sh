#!/bin/bash

# 🧪 CORS Testing Script
# Tests all CORS configurations locally and in production

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
LOCAL_URL="http://localhost:8080"
PROD_URL="${CLOUD_RUN_URL:-}"

echo "🧪 CORS Testing Script"
echo "======================"
echo ""

# Function to test CORS headers
test_cors() {
  local url=$1
  local origin=$2
  local endpoint=$3
  
  echo -e "${YELLOW}Testing: ${endpoint} from origin ${origin}${NC}"
  
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Origin: ${origin}" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    -X OPTIONS \
    "${url}${endpoint}")
  
  if [ "$response" == "200" ]; then
    echo -e "${GREEN}✅ PASS: OPTIONS request successful (${response})${NC}"
    
    # Check for CORS headers
    headers=$(curl -s -I \
      -H "Origin: ${origin}" \
      -H "Access-Control-Request-Method: POST" \
      -H "Access-Control-Request-Headers: Content-Type" \
      -X OPTIONS \
      "${url}${endpoint}")
    
    if echo "$headers" | grep -i "Access-Control-Allow-Origin" > /dev/null; then
      echo -e "${GREEN}✅ PASS: CORS headers present${NC}"
    else
      echo -e "${RED}❌ FAIL: CORS headers missing${NC}"
    fi
  else
    echo -e "${RED}❌ FAIL: OPTIONS request failed (${response})${NC}"
  fi
  
  echo ""
}

# Function to test API endpoint
test_endpoint() {
  local url=$1
  local endpoint=$2
  
  echo -e "${YELLOW}Testing: GET ${endpoint}${NC}"
  
  response=$(curl -s -o /dev/null -w "%{http_code}" "${url}${endpoint}")
  
  if [ "$response" == "200" ]; then
    echo -e "${GREEN}✅ PASS: Endpoint accessible (${response})${NC}"
  else
    echo -e "${RED}❌ FAIL: Endpoint failed (${response})${NC}"
  fi
  
  echo ""
}

# Test 1: Local server
echo "======================================"
echo "Test 1: Local Server"
echo "======================================"
echo ""

if curl -s "${LOCAL_URL}/api/health" > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Local server is running${NC}"
  echo ""
  
  # Test health endpoint
  test_endpoint "${LOCAL_URL}" "/api/health"
  
  # Test status endpoint
  test_endpoint "${LOCAL_URL}" "/api/status"
  
  # Test CORS for /api/swap
  test_cors "${LOCAL_URL}" "http://localhost:8080" "/api/swap"
  test_cors "${LOCAL_URL}" "http://localhost:5173" "/api/swap"
  test_cors "${LOCAL_URL}" "http://127.0.0.1:8080" "/api/swap"
  
  # Test CORS for /api/quote
  test_cors "${LOCAL_URL}" "http://localhost:8080" "/api/quote"
  
else
  echo -e "${RED}❌ Local server is not running${NC}"
  echo "Start it with: node server.js"
  echo ""
fi

# Test 2: Production server (if URL provided)
if [ -n "$PROD_URL" ]; then
  echo "======================================"
  echo "Test 2: Production Server"
  echo "======================================"
  echo ""
  
  if curl -s "${PROD_URL}/api/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Production server is accessible${NC}"
    echo ""
    
    # Test health endpoint
    test_endpoint "${PROD_URL}" "/api/health"
    
    # Test status endpoint
    test_endpoint "${PROD_URL}" "/api/status"
    
    # Test CORS with production origin
    test_cors "${PROD_URL}" "${PROD_URL}" "/api/swap"
    test_cors "${PROD_URL}" "${PROD_URL}" "/api/quote"
    
  else
    echo -e "${RED}❌ Production server is not accessible${NC}"
    echo "Check your CLOUD_RUN_URL environment variable"
    echo ""
  fi
else
  echo "======================================"
  echo "Skipping Production Tests"
  echo "======================================"
  echo ""
  echo "To test production, set CLOUD_RUN_URL:"
  echo "export CLOUD_RUN_URL=https://your-service.run.app"
  echo "./test-cors.sh"
  echo ""
fi

# Test 3: Detailed CORS header inspection
echo "======================================"
echo "Test 3: Detailed CORS Header Inspection"
echo "======================================"
echo ""

if curl -s "${LOCAL_URL}/api/health" > /dev/null 2>&1; then
  echo -e "${YELLOW}Inspecting CORS headers from /api/swap:${NC}"
  echo ""
  
  curl -s -I \
    -H "Origin: http://localhost:8080" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    -X OPTIONS \
    "${LOCAL_URL}/api/swap" | grep -i "access-control"
  
  echo ""
fi

# Summary
echo "======================================"
echo "Test Summary"
echo "======================================"
echo ""
echo "✅ All critical CORS configurations should pass"
echo "✅ OPTIONS requests should return 200"
echo "✅ CORS headers should be present"
echo ""
echo "If any tests fail, check:"
echo "1. Server is running (node server.js)"
echo "2. CORS configuration in server.js"
echo "3. Network connectivity"
echo ""
echo "For production issues:"
echo "1. Check Cloud Run logs: gcloud run services logs read solana-mev-bot --region us-central1"
echo "2. Verify environment variables are set"
echo "3. Ensure service is publicly accessible"
echo ""
