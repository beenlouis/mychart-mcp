/**
 * Identity federation.
 *
 * Our server is an OAuth 2.1 Authorization Server for Claude, but it does NOT
 * store passwords or authenticate users itself. Instead it bounces every login
 * to a real Identity Provider (IdP) and trusts the identity the IdP returns.
 * This file is the ONE place that knows how to talk to that IdP.
 *
 * Default implementation: Google Workspace (openid/email/profile, identity
 * only -- no access to the user's Google data).
 *
 * To use a DIFFERENT IdP (Microsoft Entra ID, Okta, Auth0, etc.) you only need
 * to replace the two functions below with the equivalent OIDC calls. Nothing
 * else in the codebase changes. See docs/SWAP-IDENTITY-PROVIDER.md.
 */
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config, OIDC_SCOPES } from "./config.js";

/**
 * A login that Google completed successfully but that this connector refuses
 * (wrong domain, not on the allow-list). It is the user's authorization being
 * denied, not a server fault, so the callback maps it to `access_denied`.
 * Reporting a denial as `server_error` sends the client into blind retries
 * instead of telling the person why they were turned away.
 */
export class IdentityNotAllowedError extends Error {
  readonly denied = true as const;
}


/** A bare OAuth2 client configured with our web-app credentials + redirect. */
function makeOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2({
    clientId: config.idp.clientId,
    clientSecret: config.idp.clientSecret,
    redirectUri: config.idp.redirectUri,
  });
}

/**
 * The URL we send the user to for consent at the IdP. `state` carries our own
 * opaque linkage id so we can match the callback back to the pending request.
 */
export function buildIdpAuthUrl(state: string): string {
  return makeOAuthClient().generateAuthUrl({
    scope: [...OIDC_SCOPES],
    // Hint Google toward the org's Workspace domain (cosmetic; enforced below).
    hd: config.idp.allowedDomain,
    state,
  });
}

export interface FederatedIdentity {
  sub: string; // stable, unique per user at the IdP
  email: string;
  domain?: string;
  name?: string;
}

/** Exchange the code the IdP handed back for a verified identity. */
export async function exchangeIdpCode(code: string): Promise<FederatedIdentity> {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("IdP did not return an id_token");

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.idp.clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("id_token missing sub/email");
  }

  // Enforce the org domain gate. For Google we prefer the verified `hd`
  // (hosted-domain) claim; fall back to the email domain for other IdPs.
  const domain = payload.hd ?? payload.email.split("@")[1];
  if (domain !== config.idp.allowedDomain) {
    throw new IdentityNotAllowedError(
      `Login restricted to @${config.idp.allowedDomain} accounts (got ${domain ?? "none"})`,
    );
  }

  return { sub: payload.sub, email: payload.email, domain, name: payload.name };
}
