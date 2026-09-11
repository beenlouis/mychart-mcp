/**
 * Epic / SMART on FHIR client.
 *
 * This connector is an OAuth CLIENT of Epic, which is separate from the OAuth
 * SERVER it runs for Claude (see auth-provider.ts). Two different flows:
 *
 *   Claude  --OAuth-->  this connector      (auth-provider.ts, Google identity)
 *   this connector  --OAuth-->  Epic/MyChart  (this file, per-user Epic tokens)
 *
 * The Epic side is a SMART "standalone patient launch": the person signs into
 * MyChart in a browser, consents, and we get back an authorization code plus,
 * because we ask for `offline_access`, a refresh token we can use unattended.
 *
 * The app is registered with Epic as a CONFIDENTIAL client. That is not a
 * stylistic choice: Epic only offers "Requires Persistent Access" (i.e.
 * refresh tokens) to confidential clients, and without refresh tokens there is
 * no unattended sync at all. So we authenticate token requests with a client
 * secret AND still use PKCE, which Epic supports as S256 only.
 *
 * Epic is configured with ROLLING refresh tokens, meaning each refresh returns
 * a new refresh token and retires the old one. Persisting the new one is
 * mandatory; see epic-session.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

/** Subset of the SMART configuration document we actually use. */
export interface SmartConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  capabilities: string[];
}

/** Epic's token response for a standalone patient launch. */
export interface EpicTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
  /** FHIR id of the patient this token is scoped to. The whole ballgame. */
  patientId?: string;
  scope?: string;
}

export class EpicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "EpicError";
  }
}

/**
 * `.well-known/smart-configuration` is the supported way to find Epic's
 * authorize/token endpoints. Hardcoding them breaks whenever an org moves
 * hosts, so we discover and cache instead.
 */
const smartConfigCache = new Map<string, { value: SmartConfig; expiresAt: number }>();
const SMART_CONFIG_TTL_MS = 60 * 60 * 1000;

export async function getSmartConfig(fhirBase = config.epic.fhirBaseUrl): Promise<SmartConfig> {
  const cached = smartConfigCache.get(fhirBase);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = `${fhirBase.replace(/\/$/, "")}/.well-known/smart-configuration`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new EpicError(
      `Could not read SMART configuration from ${url}`,
      res.status,
      await safeText(res),
    );
  }
  const doc = (await res.json()) as Record<string, unknown>;
  const value: SmartConfig = {
    authorizationEndpoint: String(doc.authorization_endpoint ?? ""),
    tokenEndpoint: String(doc.token_endpoint ?? ""),
    capabilities: Array.isArray(doc.capabilities) ? (doc.capabilities as string[]) : [],
  };
  if (!value.authorizationEndpoint || !value.tokenEndpoint) {
    throw new EpicError(`SMART configuration at ${url} is missing endpoints`);
  }
  smartConfigCache.set(fhirBase, { value, expiresAt: Date.now() + SMART_CONFIG_TTL_MS });
  logger.info({ fhirBase, capabilities: value.capabilities }, "Loaded Epic SMART configuration");
  return value;
}

// ---- PKCE ----

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  // 43-128 chars of base64url per RFC 7636. 32 random bytes lands at 43.
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the MyChart consent URL. `state` is ours to correlate the callback
 * with the pending link record; Epic echoes it back untouched.
 */
export async function buildAuthorizeUrl(state: string, challenge: string): Promise<string> {
  const smart = await getSmartConfig();
  const url = new URL(smart.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.epic.clientId);
  url.searchParams.set("redirect_uri", config.epic.redirectUri);
  url.searchParams.set("scope", config.epic.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("aud", config.epic.fhirBaseUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(code: string, verifier: string): Promise<EpicTokenResponse> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.epic.redirectUri,
    client_id: config.epic.clientId,
    client_secret: config.epic.clientSecret,
    code_verifier: verifier,
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<EpicTokenResponse> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.epic.clientId,
    client_secret: config.epic.clientSecret,
  });
}

async function tokenRequest(params: Record<string, string>): Promise<EpicTokenResponse> {
  const smart = await getSmartConfig();
  const res = await fetch(smart.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });

  const text = await safeText(res);
  if (!res.ok) {
    // Epic returns OAuth-shaped errors; surface the code so an expired or
    // revoked refresh token is distinguishable from a transport problem.
    throw new EpicError(`Epic token request failed (${res.status})`, res.status, text);
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new EpicError("Epic token response was not JSON", res.status, text);
  }

  return {
    accessToken: String(doc.access_token ?? ""),
    refreshToken: typeof doc.refresh_token === "string" ? doc.refresh_token : undefined,
    expiresInSeconds: Number(doc.expires_in ?? 3600),
    // Standalone patient launch returns the patient context here. Without it
    // we have a token but no idea whose chart it opens.
    patientId: typeof doc.patient === "string" ? doc.patient : undefined,
    scope: typeof doc.scope === "string" ? doc.scope : undefined,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "";
  }
}

/**
 * Issue an authenticated FHIR request. `path` is relative to the FHIR base,
 * e.g. "Observation?patient=abc&category=laboratory".
 */
export async function fhirGet<T = unknown>(accessToken: string, path: string): Promise<T> {
  const base = config.epic.fhirBaseUrl.replace(/\/$/, "");
  const url = `${base}/${path.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/fhir+json",
    },
  });
  if (!res.ok) {
    throw new EpicError(`FHIR request failed: GET ${path}`, res.status, await safeText(res));
  }
  return (await res.json()) as T;
}

/**
 * Fetch a Binary (an attachment: PDF, RTF, scanned document) and return it
 * base64-encoded along with its content type.
 */
export async function fhirGetBinary(
  accessToken: string,
  binaryId: string,
): Promise<{ contentType: string; base64: string; bytes: number }> {
  const base = config.epic.fhirBaseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/Binary/${encodeURIComponent(binaryId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Epic returns the raw document when we don't ask for FHIR JSON.
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) {
    throw new EpicError(`Binary fetch failed: ${binaryId}`, res.status, await safeText(res));
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { contentType, base64: buf.toString("base64"), bytes: buf.byteLength };
}
