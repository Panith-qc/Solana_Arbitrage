#!/bin/bash

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                                                               ║"
echo "║         🚀 SOLANA MEV BOT - CODESPACE SETUP 🚀               ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  Creating .env file from template..."
    cat > .env << 'ENVEOF'
# Helius RPC (Required)
VITE_HELIUS_API_KEY=your-helius-api-key-here

# Wallet Private Key (Required for trading)
VITE_PRIVATE_KEY=your-wallet-private-key-here

# Optional: Risk Level
VITE_RISK_LEVEL=BALANCED

# Optional: Max Position Size
VITE_MAX_POSITION_SOL=1.0
ENVEOF
    echo "✅ .env file created"
    echo "⚠️  IMPORTANT: Edit .env and add your API keys!"
    echo ""
fi

# Install dependencies
echo "📦 Installing dependencies..."
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi

pnpm install

# Build
echo ""
echo "🏗️  Building application..."
pnpm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║              ✅ SETUP COMPLETE! ✅                            ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "📋 NEXT STEPS:"
    echo ""
    echo "1. Edit .env file with your API keys:"
    echo "   code .env"
    echo ""
    echo "2. Start the development server:"
    echo "   pnpm run dev"
    echo ""
    echo "3. Open the URL shown (usually http://localhost:5173)"
    echo ""
    echo "4. Navigate to 'Phase 2 Auto Trading' and start trading!"
    echo ""
    echo "📚 Full guide: GITHUB_CODESPACES_DEPLOY.md"
    echo ""
else
    echo ""
    echo "❌ Build failed. Check errors above."
    exit 1
fi
