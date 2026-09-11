# Swapping the identity provider

The connector federates login to an identity provider (IdP). The default is
Google Workspace. Changing it touches exactly one file: `src/idp.ts`. Nothing in
`auth-provider.ts`, `store.ts`, `index.ts`, or your tools changes.

`src/idp.ts` exports two functions the rest of the code depends on:

```ts
buildIdpAuthUrl(state: string): string
exchangeIdpCode(code: string): Promise<FederatedIdentity>
// FederatedIdentity = { sub, email, domain?, name? }
```

Keep those two signatures and you are done. The redirect URI is always
`<PUBLIC_BASE_URL>/oauth/idp/callback`.

## Google Workspace (default, already wired)

Uses `googleapis`. Create an OAuth "Web application" client in your GCP project,
set the redirect URI, set `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` /
`ALLOWED_DOMAIN`. The domain gate uses Google's verified `hd` claim. See
`deploy/RUNBOOK.md` step 3.

## Any OIDC provider (Microsoft Entra ID, Okta, Auth0, etc.)

All of these are standard OpenID Connect, so the shape is identical: send the
user to the provider's `authorize` URL, exchange the returned code at its `token`
URL, then verify the `id_token` against the provider's published JWKS. `jose`
(already a dependency) does the verification. Below is a drop-in `src/idp.ts`
using only `jose` plus `fetch`, driven by the provider's discovery document.

Add one env var for the issuer, e.g.
`OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
(Okta: `https://<org>.okta.com`; Auth0: `https://<tenant>.auth0.com`), and read
it in `config.ts` next to the other `OIDC_*` values.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config, OIDC_SCOPES } from "./config.js";

// config.idp.issuer must be set from OIDC_ISSUER (add it in config.ts)
let discovery: Promise<{ authorization_endpoint: string; token_endpoint: string; jwks_uri: string }>;
function getDiscovery() {
  discovery ??= fetch(`${config.idp.issuer}/.well-known/openid-configuration`).then((r) => {
    if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
    return r.json();
  });
  return discovery;
}

export function buildIdpAuthUrl(state: string): string {
  // Note: buildIdpAuthUrl is sync in the interface; resolve discovery at startup
  // or make it async and await it in auth-provider.authorize(). For Entra/Okta
  // the authorize endpoint is stable, so you can also just hardcode it.
  const u = new URL(`${config.idp.issuer}/oauth2/v2.0/authorize`); // Entra example
  u.searchParams.set("client_id", config.idp.clientId);
  u.searchParams.set("redirect_uri", config.idp.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", OIDC_SCOPES.join(" "));
  u.searchParams.set("state", state);
  return u.toString();
}

export interface FederatedIdentity {
  sub: string; email: string; domain?: string; name?: string;
}

export async function exchangeIdpCode(code: string): Promise<FederatedIdentity> {
  const { token_endpoint, jwks_uri } = await getDiscovery();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.idp.redirectUri,
    client_id: config.idp.clientId,
    client_secret: config.idp.clientSecret,
  });
  const tokenRes = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("IdP did not return an id_token");

  const jwks = createRemoteJWKSet(new URL(jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: config.idp.issuer,
    audience: config.idp.clientId,
  });

  const email = String(payload.email ?? payload.preferred_username ?? "");
  const sub = String(payload.sub ?? "");
  if (!sub || !email) throw new Error("id_token missing sub/email");

  const domain = email.split("@")[1];
  if (domain !== config.idp.allowedDomain) {
    throw new Error(`Login restricted to @${config.idp.allowedDomain} (got ${domain})`);
  }
  return { sub, email, domain, name: payload.name as string | undefined };
}
```

Provider-specific notes:

- **Microsoft Entra ID**: register an "App registration," add a **Web** redirect
  URI of `<PUBLIC_BASE_URL>/oauth/idp/callback`, create a client secret, and use
  the v2.0 issuer `https://login.microsoftonline.com/<tenant>/v2.0`. To lock to
  your tenant, put the tenant id in the issuer (not `common`). Email may arrive
  as `preferred_username`.
- **Okta**: use your org URL as the issuer (or a custom authorization server's
  issuer). Redirect URI as above. Scopes `openid email profile`.
- **Auth0**: issuer `https://<tenant>.auth0.com/`, standard OIDC. If you use
  Auth0 you are using it purely as the IdP here; the MCP server is still your own
  authorization server. (You would only use Auth0 AS the authorization server if
  you chose option 1 in `OAUTH-EXPLAINED.md`, which this skeleton does not.)

Drop `googleapis` from `package.json` once you no longer use the Google path.
