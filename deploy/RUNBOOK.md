# Deployment runbook

End to end, roughly 30 to 45 minutes the first time. Nothing here is exotic:
one Cloud Run service, one Firestore database, two secrets, one OAuth client at
your identity provider.

## 0. Prereqs

- `gcloud` CLI installed and authenticated as someone who can create a project
  and link billing in your Google Cloud org.
- Node 22+ locally if you want to run it before deploying.
- Decide two things:
  - **PROJECT_ID** for the new GCP project (e.g. `acme-mcp-connector`).
  - **ALLOWED_DOMAIN**: the email domain allowed to log in (e.g. `acme.org`).

## 1. Provision cloud resources

```bash
cd mcp-connector-starter
PROJECT_ID=acme-mcp-connector \
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
./deploy/provision.sh
```

This creates the project, enables APIs, creates Firestore (native mode), a
least-privilege runtime service account (Firestore access only), and two empty
Secret Manager secrets.

## 2. Get your Cloud Run URL up front

Cloud Run URLs are deterministic: `https://SERVICE-PROJECTNUMBER.REGION.run.app`.
You need this URL before step 3, because it is part of the OAuth redirect URI.

```bash
gcloud projects describe acme-mcp-connector --format='value(projectNumber)'
# URL = https://acme-mcp-connector-<THAT-NUMBER>.us-central1.run.app
```

## 3. Create the identity-provider OAuth client

Default skeleton uses **Google**. In the SAME GCP project:

1. APIs & Services -> OAuth consent screen. Choose **Internal** (restricts login
   to your Workspace; also avoids Google's verification/assessment process).
2. APIs & Services -> Credentials -> Create Credentials -> **OAuth client ID** ->
   **Web application**.
3. Authorized redirect URI:
   `https://acme-mcp-connector-<NUMBER>.us-central1.run.app/oauth/idp/callback`
4. Copy the **Client ID** and **Client secret**.

Using Entra ID / Okta / Auth0 instead? See `docs/SWAP-IDENTITY-PROVIDER.md`; the
redirect URI path (`/oauth/idp/callback`) is the same.

## 4. Store the secrets

```bash
# The IdP client secret
printf '%s' 'YOUR_OIDC_CLIENT_SECRET' | \
  gcloud secrets versions add oidc-client-secret --data-file=- --project=acme-mcp-connector

# The signing key for our own MCP tokens
openssl rand -base64 48 | \
  gcloud secrets versions add jwt-signing-secret --data-file=- --project=acme-mcp-connector
```

## 5. Deploy

```bash
PROJECT_ID=acme-mcp-connector \
ALLOWED_DOMAIN=acme.org \
OIDC_CLIENT_ID='YOUR_OIDC_CLIENT_ID.apps.googleusercontent.com' \
./deploy/deploy.sh
```

It prints the connector URL to hand to Claude:
`https://acme-mcp-connector-<NUMBER>.us-central1.run.app/mcp`

## 6. Add it to Claude

Settings -> Connectors -> Add custom connector. Paste the `/mcp` URL. Leave the
OAuth Client ID / Secret fields **blank** (Claude self-registers via Dynamic
Client Registration). Click Connect, log in through your IdP, done. Try the
`whoami` tool to confirm.

## Troubleshooting

- **"redirect_uri_mismatch" at Google**: the URI in step 3 must exactly equal
  `<PUBLIC_BASE_URL>/oauth/idp/callback`, including https and the project number.
- **Login rejected after consent**: the account's domain does not match
  `ALLOWED_DOMAIN`. Check the deployed env var.
- **Claude says it can't connect / 401 loop**: confirm `/.well-known/oauth-authorization-server`
  loads in a browser at your base URL. If not, `PUBLIC_BASE_URL` is wrong.
- **Logs**: `gcloud run services logs read SERVICE --region REGION`. Tokens are
  redacted by the logger.

## Redeploying a whole fleet of connectors

`deploy.sh` uses `--set-env-vars` / `--set-secrets`, which REPLACE the service's
entire env. Anything added to the live service by hand since the last scripted
deploy is dropped silently. So before redeploying a long-running service, diff
the live revision against what the script would set:

    ./deploy/fleet-drift-check.py <service> <region> <project>

Deploy only on an exact match, then probe the new revision for the behaviour you
changed: `/health` must be 200 and a garbage bearer on `/mcp` must be
`401 invalid_token`. Deploy from the checkout that has `node_modules`.
