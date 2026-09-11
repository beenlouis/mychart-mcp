import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { buildIdpAuthUrl } from "./idp.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import {
  saveClient,
  getClient,
  savePendingAuth,
  peekAuthCode,
  consumeAuthCode,
  saveRefreshToken,
  getRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokenFamily,
} from "./store.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessTokenJwt,
  verifyRefreshTokenJwt,
} from "./tokens.js";
import { config } from "./config.js";

/**
 * Firestore-backed client registry. This is what enables Dynamic Client
 * Registration (DCR): when you leave "OAuth Client ID" blank in Claude's
 * custom-connector UI, Claude POSTs to /register and lands here to create a
 * client record on the fly. (The SDK's /register route handles the HTTP.)
 */
const clientsStore: OAuthRegisteredClientsStore = {
  getClient: (clientId) => getClient(clientId),
  registerClient: async (client) => {
    // The SDK's /register handler assigns client_id/secret before calling us,
    // so the runtime object is already a full client record.
    const full = client as OAuthClientInformationFull;
    await saveClient(full);
    return full;
  },
};

/**
 * This object IS our OAuth 2.1 Authorization Server. The MCP SDK's
 * `mcpAuthRouter` (see index.ts) turns it into the /authorize, /token,
 * /register and /revoke HTTP endpoints plus the discovery metadata. We do not
 * authenticate users here; we federate every login to the IdP (see idp.ts and
 * the /oauth/idp/callback route in index.ts, which finishes the flow this
 * `authorize()` starts and mints the authorization code we later exchange).
 */
export const provider: OAuthServerProvider = {
  clientsStore,

  /** Step 1: stash the client's request and bounce the user to the IdP. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const pendingId = randomUUID();
    await savePendingAuth(pendingId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      clientState: params.state,
      resource: params.resource?.href,
    });
    res.redirect(buildIdpAuthUrl(pendingId));
  },

  /** The SDK uses this to validate the PKCE code_verifier at token exchange. */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const stored = await peekAuthCode(authorizationCode);
    if (!stored) {
      throw new InvalidGrantError("Authorization code is invalid or has expired");
    }
    return stored.codeChallenge;
  },

  /** Step 3: swap our authorization code for MCP access + refresh tokens. */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const stored = await consumeAuthCode(authorizationCode);
    if (!stored) {
      throw new InvalidGrantError("Authorization code is invalid or has expired");
    }
    if (stored.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to a different client");
    }
    // A brand-new grant starts its own refresh-token family.
    const jti = randomUUID();
    return issueTokens({
      userId: stored.userId,
      clientId: client.client_id,
      scopes: stored.scopes,
      jti,
      familyId: jti,
      persist: true,
    });
  },

  /** Rotate an access token using a refresh token. */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    let claims: Awaited<ReturnType<typeof verifyRefreshTokenJwt>>;
    try {
      claims = await verifyRefreshTokenJwt(refreshToken);
    } catch {
      // Bad signature, wrong issuer, wrong token type, or expired. This must be
      // invalid_grant (400) and never a 500: invalid_grant is the signal that
      // tells the client to start a fresh authorization, whereas a 500 reads as
      // "server is broken, retry later" and the client retries a dead token
      // forever without ever prompting the user to reconnect.
      throw new InvalidGrantError("Refresh token is invalid or has expired");
    }

    if (claims.client_id !== client.client_id) {
      throw new InvalidGrantError("Refresh token was issued to a different client");
    }

    // Only allow narrowing scope, never widening it. If the request narrows to
    // nothing, say so instead of minting a scopeless token that then fails
    // opaquely at the first scope-guarded call.
    const grantedScopes = claims.scope ? claims.scope.split(" ") : [];
    let nextScopes = grantedScopes;
    if (scopes && scopes.length > 0) {
      nextScopes = scopes.filter((s) => grantedScopes.includes(s));
      if (nextScopes.length === 0) {
        throw new InvalidScopeError(
          "Requested scopes exceed those granted by the original authorization",
        );
      }
    }

    const result = await rotateRefreshToken(claims.jti, randomUUID(), {
      scopes: nextScopes,
      graceMs: config.jwt.refreshRotationGraceMs,
    });

    switch (result.status) {
      case "rotated":
      case "replayed":
        // "replayed" means a concurrent retry already rotated this token; we
        // hand back the successor so the retry converges instead of failing.
        // Its record was written inside the rotation transaction.
        return issueTokens({
          userId: result.userId,
          clientId: result.clientId,
          scopes: result.scopes,
          jti: result.jti,
          familyId: result.familyId,
          persist: false,
        });

      case "reuse_detected":
        // A spent token presented outside the retry window. We cannot tell the
        // legitimate holder from an attacker, so the whole family goes.
        await revokeRefreshTokenFamily(result.familyId);
        throw new InvalidGrantError(
          "Refresh token has already been used; please reconnect",
        );

      default:
        throw new InvalidGrantError(
          "Refresh token is no longer valid; please reconnect",
        );
    }
  },

  /** Validate an incoming MCP access token and describe the caller. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: Awaited<ReturnType<typeof verifyAccessTokenJwt>>;
    try {
      claims = await verifyAccessTokenJwt(token);
    } catch {
      // Expired or unverifiable. This must surface as 401 invalid_token so the
      // client refreshes; anything else (a 500) makes it retry the same dead
      // token indefinitely, which silently bricks the connector.
      throw new InvalidTokenError("Access token is invalid or has expired");
    }
    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope ? claims.scope.split(" ") : [],
      expiresAt: claims.exp,
      // Tools read `extra.userId` to know who is calling.
      extra: { userId: claims.sub, email: claims.email },
    };
  },

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Best-effort: if it's one of our refresh tokens, drop it.
    try {
      const claims = await verifyRefreshTokenJwt(request.token);
      const record = await getRefreshToken(claims.jti);
      if (record) {
        // A live token means this is a genuine "disconnect", so end the whole
        // grant rather than leaving its already-rotated successors usable.
        await revokeRefreshTokenFamily(record.familyId ?? claims.jti);
      } else {
        // Already spent or unknown: drop just this record. Revoking the family
        // here would let a stale token kill the session that replaced it.
        await revokeRefreshToken(claims.jti);
      }
    } catch {
      /* not a refresh token (or already invalid) -- nothing to revoke */
    }
  },
};

interface IssueTokensOptions {
  userId: string;
  clientId: string;
  scopes: string[];
  jti: string;
  familyId: string;
  /**
   * Whether this call owns writing the refresh-token record. False when
   * rotateRefreshToken already wrote it inside its transaction, so that we
   * never overwrite a record another concurrent exchange depends on.
   */
  persist: boolean;
}

async function issueTokens({
  userId,
  clientId,
  scopes,
  jti,
  familyId,
  persist,
}: IssueTokensOptions): Promise<OAuthTokens> {
  const scope = scopes.join(" ");
  if (persist) {
    await saveRefreshToken(jti, { userId, clientId, scopes, familyId });
  }

  const [access_token, refresh_token] = await Promise.all([
    signAccessToken({ sub: userId, client_id: clientId, scope }),
    signRefreshToken({ sub: userId, client_id: clientId, scope, jti }),
  ]);

  return {
    access_token,
    token_type: "Bearer",
    expires_in: config.jwt.accessTokenTtlSeconds,
    refresh_token,
    scope,
  };
}
