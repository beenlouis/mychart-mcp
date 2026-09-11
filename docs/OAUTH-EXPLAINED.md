# OAuth for claude.ai custom connectors, explained

This document exists because coding assistants keep framing the auth step as an
unsolved, expensive fork. It is not. Here is the whole truth in one place.

## The one hard requirement

To add a remote MCP server to claude.ai as a **custom connector**, your server
must be an **OAuth 2.1 authorization server**. Concretely it must:

- serve the discovery metadata (`/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource`),
- handle `/authorize` and `/token`,
- support **PKCE**,
- and support client registration (either pre-registered clients or, more
  commonly, **Dynamic Client Registration**).

There is no toggle in Claude that turns this off. A bare API key or a
"no-auth" server will not attach through the claude.ai connector UI.

## "The OAuth Client ID field is optional. Can't I just skip it?"

You can leave it blank, but that does **not** skip OAuth. Those "OAuth Client ID
/ Secret (optional)" fields are for a **pre-registered** client. Leaving them
blank switches you to **Dynamic Client Registration (DCR)**: Claude calls your
server's `/register` endpoint at connect time and registers itself as a client
automatically, instead of you creating a client by hand and pasting its ID in.

Either way your server still has to be a full OAuth 2.1 authorization server.
Blank fields change **how a client gets registered**, not **whether OAuth
happens**. This skeleton supports DCR, so blank is exactly what you want.

## "Managed authorization" does not get you out of it either

claude.ai's "managed authorization" (org-admin-configured connectors) still
requires a real OAuth 2.1 server on your side. It only changes who configures the
connection, and it is gated to specific plans and identity setups. It is not a
way to avoid building the server.

## So the real decision is smaller than it looks

The only actual choice is: **who runs the OAuth authorization-server machinery?**

1. **A hosted vendor (e.g. Auth0)** acts as the AS, and your MCP server trusts
   it. Fine, but it is another vendor, another account, another bill, and you
   still wire it up.

2. **Self-host the AS** inside your MCP server. This sounds like "weeks of work"
   only if you picture writing OAuth from scratch. You are not. The **MCP
   TypeScript SDK ships the authorization server**:

   - `mcpAuthRouter({ provider, ... })` mounts `/authorize`, `/token`,
     `/register`, `/revoke`, and both discovery documents.
   - `requireBearerAuth({ verifier })` protects your `/mcp` endpoint.
   - You implement one `OAuthServerProvider` object: a handful of methods
     (`authorize`, `exchangeAuthorizationCode`, `exchangeRefreshToken`,
     `verifyAccessToken`, plus PKCE and revoke). That is `src/auth-provider.ts`
     in this repo, and it is short.

In this skeleton the entire auth layer is about 600 lines across
`auth-provider.ts`, `store.ts`, `idp.ts`, `tokens.ts`, and the wiring in
`index.ts`, and most of it is boilerplate. Griot has stood this exact pattern up
seven times; after the first, each new connector is a day or less.

**Recommendation: self-host.** With the SDK doing the protocol work, self-hosting
is actually less total effort than integrating a vendor, and there is no extra
account to manage.

## But you still need something to log users in

Being the authorization server does not mean you store passwords. You should
not. This skeleton **federates** the actual login: when Claude hits `/authorize`,
we redirect the user to a real **identity provider** (Google Workspace by
default), verify the identity it returns, enforce a domain gate, and only then
mint our own tokens.

This is "identity only." The IdP is used purely to answer "who is this person,
and are they in our org?" The connector requests no data scopes and never reads
the user's mail, files, or anything else at the IdP. If you later want tools that
DO act on a backend on the user's behalf, that is an additive step, documented in
`EXTENDING.md`.

To point the login at a different IdP (Entra, Okta, Auth0-as-IdP), you change one
file: `src/idp.ts`. See `SWAP-IDENTITY-PROVIDER.md`.

## The mental model, one more time

- **Your MCP server = the OAuth authorization server Claude talks to.** (SDK does
  the heavy lifting.)
- **Your IdP = the thing that actually authenticates the human.** (You federate
  to it; you already have one.)
- **DCR = Claude registering itself as a client**, which is why you leave the
  client-id field blank.

Nothing here is Auth0-shaped, and nothing here is weeks of work.

## Error codes are a protocol, not decoration

This section exists because getting it wrong took two live connectors down for a
day on 2026-09-01, with both servers healthy the whole time.

The MCP SDK turns whatever your provider throws into an HTTP response, and it
only understands its own error classes:

| You throw | Client sees | Client does |
|---|---|---|
| `InvalidTokenError` | 401 `invalid_token` | refreshes its access token |
| `InvalidGrantError` | 400 `invalid_grant` | starts a fresh authorization |
| `InvalidScopeError` | 400 `invalid_scope` | asks for less |
| anything else, including a bare `Error` | **500 `server_error`** | **retries the same dead request forever** |

That last row is the trap. A bare `throw new Error("refresh token expired")` is
not an "expired" signal to the client. It is a "the server is broken, try again
later" signal, and a well-behaved client obeys it indefinitely. Nothing ever
prompts the user to reconnect, so a connector that is one click from recovery
instead looks permanently dead.

The rule: **an error caused by the credential must never be reported as an
error caused by the server.** That applies one layer up too. A login the
connector refuses (wrong domain, not on the allow-list) is `access_denied`, not
`server_error` — the person needs to be told they were turned away, not watch a
spinner retry.

## Refresh rotation has to survive a retry

Single-use rotation is right: it makes a stolen refresh token worthless after
one exchange. But the naive implementation deletes the spent record, and that
turns an ordinary client retry into an unrecoverable state.

Claude retries when a request hangs, and a Cloud Run cold start does hang. So
two exchanges arrive carrying the same refresh token. One wins and rotates. The
other finds nothing and fails — permanently, because the client is now holding a
token the server has thrown away.

What this template does instead:

- The read and both writes happen in **one Firestore transaction**, so
  concurrent exchanges cannot both win.
- The spent record is **marked, not deleted** (`rotatedAt`, `replacedByJti`).
- A replay inside `refreshRotationGraceMs` (60s) is served the **live tip** of
  the rotation chain, so the retry converges on the same working token. Follow
  the chain to the tip, not just one hop: the immediate successor may itself
  have been rotated, and handing that back makes the client's *next* refresh
  look like reuse.
- A replay **outside** the window is genuine reuse. Per RFC 9700 the whole
  `familyId` chain is revoked, in chunks of 450 because a family accumulates one
  record per rotation and Firestore caps a batch at 500 writes.

`test/refresh-rotation.test.mjs` covers all of this, including the concurrency
case. It needs real Firestore (transaction semantics are the thing under test)
via `gcloud auth application-default login`, and a throwaway
`FIRESTORE_COLLECTION_PREFIX`.

## Everything with an `expiresAt` needs a TTL policy

`pending_auth`, `auth_codes` and `refresh_tokens` all write an `expiresAt` and
are only deleted on the happy path. Every abandoned login, every unexchanged
code, and (since rotation now retains spent tokens) every rotation leaves a row
behind forever. Nothing sweeps them.

Enable a Firestore TTL policy per connector, once, at provision time:

```bash
for g in "${PREFIX}refresh_tokens" "${PREFIX}auth_codes" "${PREFIX}pending_auth"; do
  gcloud firestore fields ttls update expiresAt \
    --collection-group="$g" --project="$PROJECT_ID" --enable-ttl
done
```

This costs nothing in correctness: once the refresh JWT is past its expiry,
`verifyRefreshTokenJwt` rejects it before the store is ever consulted, so the
retained record is already dead weight.
