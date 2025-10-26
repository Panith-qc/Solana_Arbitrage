#!/bin/bash

# ═══════════════════════════════════════════════════════════
# SOLANA MEV BOT - CLOUD SHELL DEPLOYMENT SCRIPT
# ═══════════════════════════════════════════════════════════
# This script installs dependencies, builds, and serves the bot
# ═══════════════════════════════════════════════════════════

set -e  # Exit on any error

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║     SOLANA MEV BOT - CLOUD SHELL DEPLOYMENT           ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# ═══════════════════════════════════════════════════════════
# STEP 1: CHECK PREREQUISITES
# ═══════════════════════════════════════════════════════════
echo "🔍 Step 1/5: Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ Node.js found: $(node --version)"
fi

if ! command -v npm &> /dev/null; then
    echo "❌ npm not found"
    exit 1
else
    echo "✅ npm found: $(npm --version)"
fi

# ═══════════════════════════════════════════════════════════
# STEP 2: INSTALL PNPM (or fallback to npm)
# ═══════════════════════════════════════════════════════════
echo ""
echo "📦 Step 2/5: Installing pnpm..."

if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm globally..."
    npm install -g pnpm || {
        echo "⚠️  pnpm install failed, will use npm instead"
        USE_NPM=true
    }
else
    echo "✅ pnpm already installed: $(pnpm --version)"
fi

# ═══════════════════════════════════════════════════════════
# STEP 3: INSTALL DEPENDENCIES
# ═══════════════════════════════════════════════════════════
echo ""
echo "📥 Step 3/5: Installing project dependencies..."
echo "⏳ This may take 2-3 minutes..."

cd ~/Solana_Arbitrage

if [ "$USE_NPM" = true ]; then
    echo "Using npm..."
    npm install
else
    echo "Using pnpm..."
    pnpm install
fi

echo "✅ Dependencies installed!"

# ═══════════════════════════════════════════════════════════
# STEP 4: BUILD PROJECT
# ═══════════════════════════════════════════════════════════
echo ""
echo "🔨 Step 4/5: Building project..."
echo "⏳ This may take 30-60 seconds..."

if [ "$USE_NPM" = true ]; then
    npm run build
else
    pnpm run build
fi

# Verify build
if [ ! -d "dist" ]; then
    echo "❌ Build failed: dist/ folder not found"
    exit 1
fi

if [ ! -f "dist/index.html" ]; then
    echo "❌ Build failed: dist/index.html not found"
    exit 1
fi

echo "✅ Build successful!"
echo ""
ls -lh dist/ | head -10

# ═══════════════════════════════════════════════════════════
# STEP 5: START SERVER
# ═══════════════════════════════════════════════════════════
echo ""
echo "🚀 Step 5/5: Starting development server..."
echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║              🎉 DEPLOYMENT COMPLETE! 🎉                ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
echo "📡 Server starting on port 8080..."
echo ""
echo "🌐 TO ACCESS YOUR BOT:"
echo "   1. Click 'Web Preview' button (top-right)"
echo "   2. Select 'Preview on port 8080'"
echo "   3. Your bot will open in a new tab"
echo ""
echo "🔑 YOUR WALLET KEY:"
echo "   - Still stored in browser localStorage"
echo "   - No need to re-enter"
echo ""
echo "🛑 TO STOP SERVER:"
echo "   - Press Ctrl+C"
echo ""
echo "════════════════════════════════════════════════════════"
echo ""

# Check if serve is installed
if ! command -v serve &> /dev/null; then
    echo "Installing serve..."
    npm install -g serve
fi

# Start server (this will block)
serve dist -p 8080 --no-clipboard
