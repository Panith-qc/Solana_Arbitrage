#!/bin/bash

###############################################################################
# SIMPLE GCP DEPLOYMENT SCRIPT
# One-command deployment to Cloud Run
###############################################################################

# Quick deployment with minimal configuration
gcloud run deploy solana-mev-bot \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --port 5173 \
    --memory 2Gi \
    --cpu 2 \
    --timeout 3600

echo ""
echo "✅ Deployment complete!"
echo "🌐 Your service is live at the URL shown above"
