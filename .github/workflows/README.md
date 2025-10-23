# GitHub Actions Workflows

## Setup Instructions for GCP Cloud Run Deployment

### Prerequisites

1. **GCP Project Setup**
   - Create a GCP project
   - Enable Cloud Run API
   - Enable Artifact Registry API
   - Create an Artifact Registry repository named `solana-mev-bot`

2. **Service Account**
   - Create a service account with permissions:
     - `Cloud Run Admin`
     - `Artifact Registry Writer`
     - `Service Account User`
   - Generate a JSON key for the service account

3. **GitHub Secrets**
   
   Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions):
   
   - `GCP_PROJECT_ID`: Your GCP project ID
   - `GCP_SA_KEY`: The JSON key content from your service account
   - `HELIUS_API_KEY`: Your Helius RPC API key
   - `SUPABASE_ANON_KEY`: Your Supabase anonymous key

4. **GCP Secret Manager**
   
   Store sensitive values in GCP Secret Manager:
   ```bash
   # Create secrets
   echo -n "YOUR_HELIUS_API_KEY" | gcloud secrets create helius-api-key --data-file=-
   echo -n "YOUR_SUPABASE_KEY" | gcloud secrets create supabase-anon-key --data-file=-
   
   # Grant Cloud Run service account access
   gcloud secrets add-iam-policy-binding helius-api-key \
     --member="serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"
   
   gcloud secrets add-iam-policy-binding supabase-anon-key \
     --member="serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"
   ```

### Manual Deployment

To trigger deployment manually:
1. Go to Actions tab in GitHub
2. Select "Deploy to GCP Cloud Run" workflow
3. Click "Run workflow"
4. Select `main` branch
5. Click "Run workflow"

### Automatic Deployment

The workflow automatically triggers on:
- Every push to `main` branch
- Manual workflow dispatch

### Monitoring

After deployment, monitor your service:
```bash
# View logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=solana-mev-bot" --limit 50

# Check service status
gcloud run services describe solana-mev-bot --region=us-central1

# View metrics in GCP Console
https://console.cloud.google.com/run
```

### Troubleshooting

If deployment fails:
1. Check GitHub Actions logs
2. Verify all secrets are correctly set
3. Ensure GCP APIs are enabled
4. Check service account permissions
5. Verify Docker image builds successfully locally:
   ```bash
   docker build -t solana-mev-bot .
   docker run -p 8080:8080 solana-mev-bot
   ```
