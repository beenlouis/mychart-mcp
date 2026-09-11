#!/usr/bin/env bash
# Provision Google Cloud resources for the MCP connector server.
# Idempotent-ish: safe to re-run; existing resources are left in place.
#
# Prereqs: gcloud authenticated as someone who can create projects & attach
# billing. Edit the configuration block, then run ./deploy/provision.sh from
# the repo root.
set -euo pipefail

# ---- configuration (edit these) ----
PROJECT_ID="${PROJECT_ID:-example-mcp-connector}"
REGION="${REGION:-us-central1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"   # multi-region US
SERVICE_ACCOUNT="mcp-run"
SERVICE="${SERVICE:-mcp-connector}"                # must match deploy.sh
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"             # e.g. 0X0X0X-0X0X0X-0X0X0X (required on first create)

SA_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

echo ">> Project: ${PROJECT_ID}  Region: ${REGION}"

# ---- 1. project ----
if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  echo ">> Creating project ${PROJECT_ID}"
  gcloud projects create "${PROJECT_ID}" --name="MCP Connector"
  if [[ -n "${BILLING_ACCOUNT}" ]]; then
    gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}"
  else
    echo "!! No BILLING_ACCOUNT set -- link billing before deploying:"
    echo "   gcloud billing projects link ${PROJECT_ID} --billing-account=XXXX"
  fi
fi
gcloud config set project "${PROJECT_ID}"

# ---- 2. APIs ----
echo ">> Enabling APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com

# ---- 3. Firestore (native mode) ----
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  echo ">> Creating Firestore (native) in ${FIRESTORE_LOCATION}"
  gcloud firestore databases create --location="${FIRESTORE_LOCATION}"
fi

# ---- 4. runtime service account ----
if ! gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SERVICE_ACCOUNT}" \
    --display-name="MCP connector Cloud Run runtime"
fi

# ---- 5. least-privilege IAM (Firestore only) ----
echo ">> Granting roles to ${SA_EMAIL}"
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user" --condition=None

# ---- 6. secrets (values filled in RUNBOOK step 4) ----
for SECRET in oidc-client-secret jwt-signing-secret; do
  if ! gcloud secrets describe "${SECRET}" >/dev/null 2>&1; then
    gcloud secrets create "${SECRET}" --replication-policy="automatic"
  fi
  gcloud secrets add-iam-policy-binding "${SECRET}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor"
done

# ---- 7. TTL policies on the expiring collections ----
# pending_auth, auth_codes and refresh_tokens each write an `expiresAt` and are
# only deleted on the happy path, so abandoned logins, unexchanged codes and
# rotated-away refresh tokens would otherwise accumulate forever. Firestore TTL
# sweeps them. Safe to re-run; enabling an already-enabled TTL is a no-op.
# Each call is a long-running operation and can take a couple of minutes.
# Must resolve to the same value deploy.sh passes to the container, or TTL
# lands on collections the app never writes to.
PREFIX="${FIRESTORE_COLLECTION_PREFIX:-${SERVICE}_}"
echo ">> Enabling Firestore TTL on expiresAt (this is slow; a few minutes)"
for GROUP in "${PREFIX}refresh_tokens" "${PREFIX}auth_codes" "${PREFIX}pending_auth" "${PREFIX}pending_epic_links" "${PREFIX}link_tokens"; do
  echo "   ${GROUP}"
  gcloud firestore fields ttls update expiresAt \
    --collection-group="${GROUP}" --project="${PROJECT_ID}" --enable-ttl --quiet || \
    echo "   WARNING: could not enable TTL on ${GROUP}; do it by hand before going live"
done

echo ">> Provision complete."
echo "   Next: create the IdP OAuth consent screen + Web client (RUNBOOK step 3),"
echo "   store the secrets (step 4), then run ./deploy/deploy.sh"
