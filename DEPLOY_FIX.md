# Fix GCP Authentication and Deploy

## Run these commands in GCP Cloud Shell:

```bash
# 1. Authenticate (should auto-select your account in Cloud Shell)
gcloud auth login --brief

# 2. Set the project
gcloud config set project solana-mev-bot-476012

# 3. Deploy
gcloud run deploy solana-mev-bot \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --port 8080
```

## OR Use this one-liner:

```bash
gcloud config set project solana-mev-bot-476012 && gcloud run deploy solana-mev-bot --source . --region us-central1 --allow-unauthenticated --memory 2Gi --cpu 2 --port 8080
```

This will deploy the NEW build with AutoTradingSetup!
