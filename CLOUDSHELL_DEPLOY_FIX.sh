#!/bin/bash
# Cloud Shell Deployment Fix
# Run this in GCP Cloud Shell to clean up and redeploy

set -e  # Exit on any error

echo "=================================="
echo "🧹 CLEANING UP CLOUD SHELL..."
echo "=================================="

# Go to home directory
cd ~

# Remove all old clones
echo "Removing old repositories..."
rm -rf Solana_Arbitrage 2>/dev/null || true
rm -rf solana-mev-bot 2>/dev/null || true

# Check disk space
echo ""
echo "📊 Disk space before cleanup:"
df -h ~ | tail -1

# Clean up Cloud Shell cache
echo ""
echo "Cleaning Cloud Shell cache..."
rm -rf ~/.cache/* 2>/dev/null || true
rm -rf /tmp/* 2>/dev/null || true

echo ""
echo "📊 Disk space after cleanup:"
df -h ~ | tail -1

echo ""
echo "=================================="
echo "📥 CLONING FRESH REPOSITORY..."
echo "=================================="

# Clone repository fresh
git clone --depth 1 https://github.com/Panith-qc/Solana_Arbitrage.git
cd Solana_Arbitrage

echo ""
echo "=================================="
echo "✅ VERIFYING CODE IS CORRECT..."
echo "=================================="

# Verify App.tsx has AutoTradingSetup
if grep -q "AutoTradingSetup" src/App.tsx; then
    echo "✅ App.tsx contains AutoTradingSetup import"
else
    echo "❌ ERROR: App.tsx does NOT contain AutoTradingSetup!"
    echo "Showing App.tsx contents:"
    head -20 src/App.tsx
    exit 1
fi

# Verify AutoTradingSetup.tsx exists
if [ -f "src/components/AutoTradingSetup.tsx" ]; then
    echo "✅ AutoTradingSetup.tsx exists"
else
    echo "❌ ERROR: AutoTradingSetup.tsx is missing!"
    ls -la src/components/ | grep -i auto
    exit 1
fi

# Verify riskProfiles.ts exists
if [ -f "src/config/riskProfiles.ts" ]; then
    echo "✅ riskProfiles.ts exists"
else
    echo "❌ ERROR: riskProfiles.ts is missing!"
    exit 1
fi

echo ""
echo "=================================="
echo "🚀 DEPLOYING TO CLOUD RUN..."
echo "=================================="

# Deploy to Cloud Run
gcloud run deploy solana-mev-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 0 \
  --max-instances 2 \
  --port 8080 \
  --project solana-mev-bot-476012 \
  --timeout 300

echo ""
echo "=================================="
echo "✅ DEPLOYMENT COMPLETE!"
echo "=================================="
echo ""
echo "🌐 Your bot is now live with:"
echo "   - 🤖 Auto Trading Setup (default view)"
echo "   - 🛡️ Conservative risk profile"
echo "   - ⚖️ Balanced risk profile"
echo "   - ⚡ Aggressive risk profile"
echo "   - 🔄 Toggle to Advanced Mode"
echo ""
echo "📝 Open the URL shown above to see your bot!"
echo "=================================="
