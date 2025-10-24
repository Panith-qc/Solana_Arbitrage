#!/bin/bash
# IMMEDIATE FIX - Run this in your GCP Cloud Shell

echo "🔧 FIXING YOUR DEPLOYMENT ERROR..."
echo ""

# Build locally first
echo "📦 Building locally (this ensures dist/ exists)..."
pnpm install
pnpm run build

# Create simple Dockerfile
echo "📝 Creating fixed Dockerfile..."
cat > Dockerfile << 'EOF'
FROM node:20-alpine
WORKDIR /app
RUN npm install -g serve
COPY dist ./dist
ENV PORT=5173
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
EOF

# Deploy
echo "🚀 Deploying to Cloud Run..."
gcloud run deploy solana-mev-bot \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --port 5173 \
    --memory 2Gi \
    --cpu 2 \
    --timeout 300

echo ""
echo "✅ DONE! Check the URL above!"
