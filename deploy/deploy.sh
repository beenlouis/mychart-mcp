#!/usr/bin/env bash
# Build + deploy the MCP connector server to Cloud Run.
# Run after ./provision.sh and after the OAuth secrets are stored (RUNBOOK step 4).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lewis-personal-finance-mcp}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mychart-mcp}"
SERVICE_ACCOUNT="mychart-mcp-run@${PROJECT_ID}.iam.gserviceaccount.com"
ALLOWED_EMAILS="${ALLOWED_EMAILS:?Set ALLOWED_EMAILS to the comma-separated list of people allowed to connect}"
# Unique per connector so several can share one project (e.g. drive_, coda_).
# Defaults to "<SERVICE>_" so it is distinct out of the box.
FIRESTORE_COLLECTION_PREFIX="${FIRESTORE_COLLECTION_PREFIX:-${SERVICE}_}"

gcloud config set project "${PROJECT_ID}"

# Cloud Run's deterministic URL is https://SERVICE-PROJECTNUMBER.REGION.run.app,
# so we can compute the public base URL (and thus the OAuth redirect) up front.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
PUBLIC_BASE_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
echo ">> Public base URL: ${PUBLIC_BASE_URL}"
echo "   IdP redirect URI must be: ${PUBLIC_BASE_URL}/oauth/idp/callback"

# OIDC_CLIENT_ID is not secret; read it from the local env before deploying.
: "${OIDC_CLIENT_ID:?Set OIDC_CLIENT_ID (the IdP OAuth Web client ID) before deploying}"

gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --service-account "${SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=4 \
  --set-env-vars="NODE_ENV=production,PUBLIC_BASE_URL=${PUBLIC_BASE_URL},ALLOWED_EMAILS=${ALLOWED_EMAILS},GCP_PROJECT_ID=${PROJECT_ID},FIRESTORE_DATABASE_ID=(default),FIRESTORE_COLLECTION_PREFIX=${FIRESTORE_COLLECTION_PREFIX},OIDC_CLIENT_ID=${OIDC_CLIENT_ID},KMS_KEY_NAME=${KMS_KEY_NAME},EPIC_ENVIRONMENT=${EPIC_ENVIRONMENT},EPIC_FHIR_BASE_URL=${EPIC_FHIR_BASE_URL},EPIC_CLIENT_ID=${EPIC_CLIENT_ID}" \
  --set-secrets="OIDC_CLIENT_SECRET=oidc-client-secret:latest,JWT_SIGNING_SECRET=mychart-jwt-signing:latest,EPIC_CLIENT_SECRET=mychart-epic-client-secret:latest"

echo ">> Deployed. Connector URL for Claude: ${PUBLIC_BASE_URL}/mcp"
