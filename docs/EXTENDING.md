# Extending beyond identity-only

This skeleton is **identity-only**: it authenticates the user and then exposes
tools, but the example tools do not call any third-party API on the user's
behalf. Most real connectors do one of two things. Here is how to add each.

## Pattern A: call a shared backend with a service credential

The connector talks to one API using a single org-level token (an API key, a
service account, a machine client). Every authenticated user shares it. This is
how Griot's Coda, Typeform, Toast, and Slack connectors work.

1. Add the credential as a Secret Manager secret and wire it in `deploy.sh`
   `--set-secrets`, plus a field in `config.ts`.
2. In your tool handler, call the API with that credential. Use
   `userIdFrom(extra)` / `emailFrom(extra)` for audit logging or per-user
   authorization checks, but the API call itself uses the shared token.
3. The domain gate in `idp.ts` is what keeps this safe: only your org's people
   can reach the tools at all.

This is the simplest and most common pattern. No per-user secret storage needed.

## Pattern B: act as each user against their own account

The connector calls an API **as the signed-in user** (e.g. edit that user's own
documents). Now you must obtain and store a per-user credential. This is how
Griot's Drive connector works, and it adds two things to the skeleton:

1. **Request data scopes at login.** In `config.ts`, add the API scopes to
   `OIDC_SCOPES` (for Google, request offline access so you get a refresh token).
   In `idp.ts`, capture the refresh token from the token response.
2. **Store that refresh token encrypted, never plaintext.** Add a Cloud KMS key
   and a small crypto helper; store ciphertext in the `users` document. The
   Griot Drive connector uses envelope encryption via `@google-cloud/kms`:

   ```ts
   import { KeyManagementServiceClient } from "@google-cloud/kms";
   const kms = new KeyManagementServiceClient();

   export async function encryptSecret(plaintext: string): Promise<string> {
     const [r] = await kms.encrypt({
       name: config.gcp.kmsKeyName,
       plaintext: Buffer.from(plaintext, "utf8"),
     });
     return Buffer.from(r.ciphertext as Uint8Array).toString("base64");
   }
   export async function decryptSecret(ciphertextB64: string): Promise<string> {
     const [r] = await kms.decrypt({
       name: config.gcp.kmsKeyName,
       ciphertext: Buffer.from(ciphertextB64, "base64"),
     });
     return Buffer.from(r.plaintext as Uint8Array).toString("utf8");
   }
   ```

   Then in `store.ts`, store `googleRefreshTokenEnc` on the user and add a getter
   that decrypts it. Provision the KMS key and grant the runtime service account
   `roles/cloudkms.cryptoKeyEncrypterDecrypter` (add these lines back into
   `provision.sh`; they were removed from this identity-only starter).

3. In your tool handler, load and decrypt that user's token and use it to build
   an authenticated API client. Refresh tokens are long-lived; the API client
   library refreshes the short-lived access token as needed.

### Scope and consent-screen note (Google)

Some Google scopes (like full Drive) are "restricted" and normally trigger a
security assessment. Keeping the OAuth consent screen **Internal** to your
Workspace exempts it, because there are no external users. If you must support
external users, budget for Google's verification process.

## Running several connectors in one project

You do not need a new GCP project per connector. Deploy each as its own Cloud Run
service in the same project. Data isolation is built in: set a unique
`FIRESTORE_COLLECTION_PREFIX` per connector (e.g. `drive_`, `coda_`) and every
collection this connector owns is namespaced, so two services sharing one
Firestore database never collide. `deploy/deploy.sh` defaults the prefix to
`<SERVICE>_`, so it is distinct out of the box; override it if you want a shorter
name. (A separate Firestore database per connector also works if you prefer hard
isolation.)

Each service additionally gets its own runtime service account, its own `/mcp`
URL, and its own IdP OAuth client (or a shared identity-only client with multiple
redirect URIs, for connectors that request no data scopes). A connector that
stores per-user third-party tokens (Pattern B) gets its own KMS key, bound only
to that connector's service account; connectors using a shared org token
(Pattern A) or identity-only need no KMS key at all.
