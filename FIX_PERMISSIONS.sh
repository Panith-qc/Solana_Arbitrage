#!/bin/bash
# Quick fix for secret permissions

set -e

PROJECT_ID="solana-mev-bot-476012"
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "🔑 Granting secret access to: $SERVICE_ACCOUNT"
echo ""

for SECRET in helius-rpc-url helius-api-key jupiter-ultra-api-key jito-tip-accounts; do
  echo "   Granting access to $SECRET..."
  gcloud secrets add-iam-policy-binding $SECRET \
    --member="serviceAccount:${SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet
done

echo ""
echo "✅ All permissions granted!"
echo ""
echo "Now run: ./DEPLOY_NOW_CLOUDSHELL.sh"
