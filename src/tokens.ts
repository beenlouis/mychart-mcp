/**
 * We sign our OWN MCP access + refresh tokens (HS256 JWTs). These are the
 * tokens Claude sends back to us as bearer tokens on every /mcp call. They are
 * unrelated to the IdP's tokens; the IdP is only used once, to establish
 * identity during login.
 */
import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";

const ALG = "HS256";

export interface AccessTokenClaims {
  sub: string; // our user id (the IdP's stable subject)
  client_id: string;
  scope: string; // space-delimited
  email?: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ ...claims, token_type: "access" })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(config.jwt.issuer)
    .setIssuedAt()
    .setExpirationTime(`${config.jwt.accessTokenTtlSeconds}s`)
    .sign(config.jwt.signingSecret);
}

export interface RefreshTokenClaims {
  sub: string;
  client_id: string;
  scope: string;
  jti: string; // stored in Firestore so the token can be revoked
}

export async function signRefreshToken(claims: RefreshTokenClaims): Promise<string> {
  return new SignJWT({ ...claims, token_type: "refresh" })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(config.jwt.issuer)
    .setIssuedAt()
    .setExpirationTime(`${config.jwt.refreshTokenTtlSeconds}s`)
    .sign(config.jwt.signingSecret);
}

export async function verifyAccessTokenJwt(
  token: string,
): Promise<AccessTokenClaims & { exp: number }> {
  const { payload } = await jwtVerify(token, config.jwt.signingSecret, {
    issuer: config.jwt.issuer,
  });
  if (payload.token_type !== "access") throw new Error("Not an access token");
  return payload as unknown as AccessTokenClaims & { exp: number };
}

export async function verifyRefreshTokenJwt(
  token: string,
): Promise<RefreshTokenClaims & { exp: number }> {
  const { payload } = await jwtVerify(token, config.jwt.signingSecret, {
    issuer: config.jwt.issuer,
  });
  if (payload.token_type !== "refresh") throw new Error("Not a refresh token");
  return payload as unknown as RefreshTokenClaims & { exp: number };
}
