import { FieldValue, Firestore, Timestamp } from "@google-cloud/firestore";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "./config.js";

/**
 * All persistent state lives in Firestore. Collections (each prefixed by
 * config.gcp.collectionPrefix so multiple connectors can share one project):
 *   oauth_clients  - Dynamic Client Registration records (Claude registers here)
 *   pending_auth   - in-flight logins (bridge the round-trip out to the IdP and back)
 *   auth_codes     - short-lived authorization codes (single use, PKCE-bound)
 *   users          - one per person (identity only)
 *   refresh_tokens - OUR issued MCP refresh tokens (stored so they can be revoked)
 *   epic_links     - per-user MyChart link (Epic refresh token, KMS-ENCRYPTED)
 *   pending_epic_links - in-flight MyChart links (parks the PKCE verifier)
 *
 * The Epic refresh token is the only third-party secret here and it is the key
 * to a child's medical record. It is stored as KMS ciphertext (see crypto.ts)
 * and must never be written in plaintext or logged.
 */
const db = new Firestore({
  projectId: config.gcp.projectId,
  databaseId: config.gcp.firestoreDatabaseId,
  // Optional OAuth fields (state, resource) are frequently absent; treat
  // undefined as "don't write" rather than erroring.
  ignoreUndefinedProperties: true,
});

// Unique per connector so multiple connectors can share one Firestore database
// without colliding (e.g. "drive_oauth_clients" vs "coda_oauth_clients").
const p = config.gcp.collectionPrefix;
const clients = db.collection(`${p}oauth_clients`);
const authCodes = db.collection(`${p}auth_codes`);
const users = db.collection(`${p}users`);
const refreshTokens = db.collection(`${p}refresh_tokens`);
const pendingAuth = db.collection(`${p}pending_auth`);
const epicLinks = db.collection(`${p}epic_links`);
const pendingEpicLinks = db.collection(`${p}pending_epic_links`);
const linkTokens = db.collection(`${p}link_tokens`);

// ---- OAuth clients (Dynamic Client Registration) ----

export async function saveClient(client: OAuthClientInformationFull): Promise<void> {
  await clients.doc(client.client_id).set(client);
}

export async function getClient(
  clientId: string,
): Promise<OAuthClientInformationFull | undefined> {
  const snap = await clients.doc(clientId).get();
  return snap.exists ? (snap.data() as OAuthClientInformationFull) : undefined;
}

// ---- Pending authorizations (bridge the round-trip out to the IdP and back) ----

export interface StoredPendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  clientState?: string;
  resource?: string;
  expiresAt: Timestamp;
}

export async function savePendingAuth(
  id: string,
  data: Omit<StoredPendingAuth, "expiresAt">,
): Promise<void> {
  await pendingAuth.doc(id).set({
    ...data,
    expiresAt: Timestamp.fromMillis(Date.now() + config.jwt.authCodeTtlSeconds * 1000),
  });
}

export async function consumePendingAuth(
  id: string,
): Promise<StoredPendingAuth | undefined> {
  const ref = pendingAuth.doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return undefined;
    const data = snap.data() as StoredPendingAuth;
    tx.delete(ref);
    if (data.expiresAt.toMillis() < Date.now()) return undefined;
    return data;
  });
}

// ---- Authorization codes ----

export interface StoredAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  userId: string;
  resource?: string;
  expiresAt: Timestamp;
}

export async function saveAuthCode(
  code: string,
  data: Omit<StoredAuthCode, "expiresAt">,
): Promise<void> {
  await authCodes.doc(code).set({
    ...data,
    expiresAt: Timestamp.fromMillis(Date.now() + config.jwt.authCodeTtlSeconds * 1000),
  });
}

/** Read without consuming (used to answer the PKCE challenge lookup). */
export async function peekAuthCode(code: string): Promise<StoredAuthCode | undefined> {
  const snap = await authCodes.doc(code).get();
  if (!snap.exists) return undefined;
  const data = snap.data() as StoredAuthCode;
  if (data.expiresAt.toMillis() < Date.now()) return undefined;
  return data;
}

/** Fetch-and-delete: authorization codes are single-use. */
export async function consumeAuthCode(code: string): Promise<StoredAuthCode | undefined> {
  const ref = authCodes.doc(code);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return undefined;
    const data = snap.data() as StoredAuthCode;
    tx.delete(ref);
    if (data.expiresAt.toMillis() < Date.now()) return undefined;
    return data;
  });
}

// ---- Users (identity only) ----

export interface StoredUser {
  userId: string; // the IdP's stable subject
  email: string;
  domain?: string;
  name?: string;
  updatedAt: Timestamp;
}

export async function upsertUser(user: Omit<StoredUser, "updatedAt">): Promise<void> {
  await users.doc(user.userId).set(
    { ...user, updatedAt: Timestamp.now() },
    { merge: true },
  );
}

export async function getUser(userId: string): Promise<StoredUser | undefined> {
  const snap = await users.doc(userId).get();
  return snap.exists ? (snap.data() as StoredUser) : undefined;
}

// ---- Epic / MyChart account link (per user) ----

/**
 * One linked MyChart account. `refreshTokenEnc` is KMS ciphertext -- never
 * store or log the plaintext. `patientId` is the FHIR id the token is scoped
 * to, which for a proxy link is the DEPENDENT's id (e.g. the child), not the
 * person who signed in.
 */
export interface StoredEpicLink {
  userId: string;
  /** Which Epic instance: "sandbox" or an org key like "stjude". */
  environment: string;
  fhirBaseUrl: string;
  refreshTokenEnc: string;
  patientId?: string;
  patientDisplay?: string;
  scope?: string;
  linkedAt: Timestamp;
  updatedAt: Timestamp;
  /** Set when a refresh fails terminally, so tools can tell the user to relink. */
  invalidatedAt?: Timestamp;
  invalidReason?: string;
}

/** Doc id is `${userId}:${environment}` so one person can link sandbox + prod. */
function epicLinkId(userId: string, environment: string): string {
  return `${userId}:${environment}`;
}

export async function saveEpicLink(
  link: Omit<StoredEpicLink, "linkedAt" | "updatedAt"> & { linkedAt?: Timestamp },
): Promise<void> {
  const id = epicLinkId(link.userId, link.environment);
  const now = Timestamp.now();
  const existing = await epicLinks.doc(id).get();
  await epicLinks.doc(id).set(
    {
      ...link,
      linkedAt: existing.exists
        ? ((existing.data() as StoredEpicLink).linkedAt ?? now)
        : now,
      updatedAt: now,
      // A successful (re)link clears any previous invalidation.
      invalidatedAt: FieldValue.delete(),
      invalidReason: FieldValue.delete(),
    },
    { merge: true },
  );
}

export async function getEpicLink(
  userId: string,
  environment: string,
): Promise<StoredEpicLink | undefined> {
  const snap = await epicLinks.doc(epicLinkId(userId, environment)).get();
  return snap.exists ? (snap.data() as StoredEpicLink) : undefined;
}

/** Rotate in a newly-issued refresh token without disturbing the rest. */
export async function updateEpicRefreshToken(
  userId: string,
  environment: string,
  refreshTokenEnc: string,
): Promise<void> {
  await epicLinks.doc(epicLinkId(userId, environment)).set(
    { refreshTokenEnc, updatedAt: Timestamp.now() },
    { merge: true },
  );
}

export async function invalidateEpicLink(
  userId: string,
  environment: string,
  reason: string,
): Promise<void> {
  await epicLinks.doc(epicLinkId(userId, environment)).set(
    { invalidatedAt: Timestamp.now(), invalidReason: reason, updatedAt: Timestamp.now() },
    { merge: true },
  );
}

export async function deleteEpicLink(userId: string, environment: string): Promise<void> {
  await epicLinks.doc(epicLinkId(userId, environment)).delete();
}

// ---- One-time link tokens ----
//
// /epic/link is opened in a BROWSER, which carries no MCP bearer token. So a
// tool mints a short-lived single-use token, and the browser presents that
// instead. This keeps the identity binding (we still know whose Epic token we
// are about to store) without requiring the browser to be authenticated.

export interface StoredLinkToken {
  userId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

export async function saveLinkToken(token: string, userId: string): Promise<void> {
  const now = Date.now();
  await linkTokens.doc(token).set({
    userId,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + LINK_TOKEN_TTL_MS),
  });
}

/** Single-use: read and delete, so a leaked URL cannot be replayed. */
export async function consumeLinkToken(token: string): Promise<string | undefined> {
  const ref = linkTokens.doc(token);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return undefined;
    const data = snap.data() as StoredLinkToken;
    tx.delete(ref);
    if (data.expiresAt.toMillis() < Date.now()) return undefined;
    return data.userId;
  });
}

// ---- Pending Epic link (PKCE verifier parked between authorize and callback) ----

export interface StoredPendingEpicLink {
  state: string;
  userId: string;
  environment: string;
  codeVerifier: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

const PENDING_EPIC_LINK_TTL_MS = 10 * 60 * 1000;

export async function savePendingEpicLink(
  state: string,
  data: Omit<StoredPendingEpicLink, "state" | "createdAt" | "expiresAt">,
): Promise<void> {
  const now = Date.now();
  await pendingEpicLinks.doc(state).set({
    state,
    ...data,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + PENDING_EPIC_LINK_TTL_MS),
  });
}

/** Single-use: read and delete, so a replayed callback cannot re-link. */
export async function consumePendingEpicLink(
  state: string,
): Promise<StoredPendingEpicLink | undefined> {
  const ref = pendingEpicLinks.doc(state);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return undefined;
    const data = snap.data() as StoredPendingEpicLink;
    tx.delete(ref);
    if (data.expiresAt.toMillis() < Date.now()) return undefined;
    return data;
  });
}

// ---- Our issued MCP refresh tokens (revocable) ----

/** Firestore caps a batched write at 500 operations. */
const FIRESTORE_BATCH_LIMIT = 450;
/** Guard against following a corrupted/cyclic rotation chain forever. */
const MAX_ROTATION_CHAIN_HOPS = 10;

export interface StoredRefreshToken {
  userId: string;
  clientId: string;
  scopes: string[];
  expiresAt: Timestamp;
  /**
   * Every refresh token descended from a single authorization grant shares a
   * familyId, so that detecting reuse of a spent token lets us revoke the whole
   * chain rather than just the one token (RFC 9700 refresh-token protection).
   * Absent on records written before rotation tracking existed; those are
   * treated as a family of one, keyed by their own id.
   */
  familyId?: string;
  /** Set once this token has been rotated away. A rotated token is spent. */
  rotatedAt?: Timestamp;
  /** The token id that superseded this one. */
  replacedByJti?: string;
}

export async function saveRefreshToken(
  tokenId: string,
  data: Omit<StoredRefreshToken, "expiresAt">,
): Promise<void> {
  await refreshTokens.doc(tokenId).set({
    ...data,
    expiresAt: Timestamp.fromMillis(Date.now() + config.jwt.refreshTokenTtlSeconds * 1000),
  });
}

export async function getRefreshToken(
  tokenId: string,
): Promise<StoredRefreshToken | undefined> {
  const snap = await refreshTokens.doc(tokenId).get();
  if (!snap.exists) return undefined;
  const data = snap.data() as StoredRefreshToken;
  if (data.expiresAt.toMillis() < Date.now()) return undefined;
  // A rotated token is spent, even while its record is kept for reuse detection.
  if (data.replacedByJti) return undefined;
  return data;
}

export async function revokeRefreshToken(tokenId: string): Promise<void> {
  await refreshTokens.doc(tokenId).delete();
}

export type RotateRefreshTokenResult =
  | {
      /** Rotation succeeded; `jti` is live and its record is already written. */
      status: "rotated" | "replayed";
      jti: string;
      userId: string;
      clientId: string;
      scopes: string[];
      familyId: string;
    }
  /** No such token: never issued, already revoked, or long since cleaned up. */
  | { status: "unknown" }
  | { status: "expired" }
  /** A spent token presented outside the retry window. Treat as compromise. */
  | { status: "reuse_detected"; familyId: string };

/**
 * Atomically spend `oldJti` and mint `newJti` in its place.
 *
 * Rotation is single-use, which is what makes a leaked refresh token useless
 * after one exchange. The hazard is that a *legitimate* client retry (Claude
 * retries when a request hangs, and Cloud Run cold starts do hang) presents the
 * same token twice. Deleting the spent record outright turns that retry into a
 * permanent failure: the client is left holding a token the server has thrown
 * away, and no amount of retrying recovers it.
 *
 * So a spent record is kept and marked, and a replay inside `graceMs` returns
 * the successor that the winning call already created. The retry converges on
 * the same outcome instead of wedging. Outside that window, presenting a spent
 * token is real reuse and the caller should revoke the whole family.
 *
 * The read and both writes run in one transaction, so concurrent exchanges
 * cannot both win.
 */
export async function rotateRefreshToken(
  oldJti: string,
  newJti: string,
  opts: { scopes: string[]; graceMs: number },
): Promise<RotateRefreshTokenResult> {
  const oldRef = refreshTokens.doc(oldJti);

  return db.runTransaction<RotateRefreshTokenResult>(async (tx) => {
    const snap = await tx.get(oldRef);
    if (!snap.exists) return { status: "unknown" };

    const current = snap.data() as StoredRefreshToken;
    const now = Date.now();
    if (current.expiresAt.toMillis() < now) return { status: "expired" };

    const familyId = current.familyId ?? oldJti;

    if (current.replacedByJti) {
      const rotatedAtMs = current.rotatedAt?.toMillis() ?? 0;
      if (now - rotatedAtMs > opts.graceMs) {
        return { status: "reuse_detected", familyId };
      }

      // Inside the window: a retry of an exchange that already succeeded. Walk
      // to the LIVE tip of the chain rather than handing back the immediate
      // successor, which may itself have been rotated already. Returning a
      // spent token would look like reuse on the client's next refresh and
      // would wrongly revoke the whole family.
      let nextJti: string = current.replacedByJti;
      for (let hop = 0; hop < MAX_ROTATION_CHAIN_HOPS; hop++) {
        const nextSnap = await tx.get(refreshTokens.doc(nextJti));
        if (!nextSnap.exists) return { status: "unknown" };
        const next = nextSnap.data() as StoredRefreshToken;
        if (next.expiresAt.toMillis() < now) return { status: "expired" };
        if (!next.replacedByJti) {
          return {
            status: "replayed",
            jti: nextJti,
            userId: next.userId,
            clientId: next.clientId,
            scopes: next.scopes,
            familyId,
          };
        }
        nextJti = next.replacedByJti;
      }
      // Pathologically long or cyclic chain; fail closed rather than loop.
      return { status: "unknown" };
    }

    tx.set(refreshTokens.doc(newJti), {
      userId: current.userId,
      clientId: current.clientId,
      scopes: opts.scopes,
      familyId,
      expiresAt: Timestamp.fromMillis(now + config.jwt.refreshTokenTtlSeconds * 1000),
    });
    // The spent record is retained (not deleted) so that retries land on
    // "replayed" and later reuse is still detectable.
    tx.update(oldRef, {
      rotatedAt: Timestamp.fromMillis(now),
      replacedByJti: newJti,
    });

    return {
      status: "rotated",
      jti: newJti,
      userId: current.userId,
      clientId: current.clientId,
      scopes: opts.scopes,
      familyId,
    };
  });
}

/**
 * Revoke every refresh token descended from one authorization grant. Called
 * when a spent token is replayed outside the retry window, since at that point
 * we cannot tell the legitimate holder from an attacker and must invalidate
 * both. The user simply reconnects.
 */
export async function revokeRefreshTokenFamily(familyId: string): Promise<void> {
  const byFamily = await refreshTokens.where("familyId", "==", familyId).get();

  const refs = byFamily.docs.map((d) => d.ref);
  // Records predating familyId tracking are their own family, keyed by id.
  if (!byFamily.docs.some((d) => d.id === familyId)) {
    refs.push(refreshTokens.doc(familyId));
  }

  // A family is one document per rotation, so with hourly refreshes over a
  // 30-day token lifetime it can run to hundreds. Firestore caps a batch at
  // 500 writes, so chunk rather than assuming the family is small.
  for (let i = 0; i < refs.length; i += FIRESTORE_BATCH_LIMIT) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + FIRESTORE_BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}
