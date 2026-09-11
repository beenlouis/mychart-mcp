/**
 * Turns a stored, encrypted Epic refresh token into a usable access token.
 *
 * Epic access tokens are short-lived (roughly an hour), so every tool call
 * mints a fresh one from the refresh token. Cloud Run is stateless and
 * horizontally scaled, so we deliberately do NOT cache access tokens in
 * process memory across requests; the refresh round-trip is cheap next to a
 * FHIR search.
 */
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { EpicError, refreshAccessToken } from "./epic.js";
import { logger } from "./logger.js";
import {
  getEpicLink,
  invalidateEpicLink,
  updateEpicRefreshToken,
  type StoredEpicLink,
} from "./store.js";

/**
 * Raised when the person has no usable MyChart link. This is a USER-actionable
 * state, not a server fault: the only fix is for them to (re)link. Tools must
 * surface it as guidance, never as a generic failure, for the same reason the
 * OAuth layer distinguishes invalid_grant from server_error.
 */
export class EpicLinkRequiredError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EpicLinkRequiredError";
  }
}

export interface EpicSession {
  accessToken: string;
  patientId: string;
  link: StoredEpicLink;
}

function linkUrl(): string {
  return `${config.baseUrl}/epic/link`;
}

export async function getEpicSession(userId: string): Promise<EpicSession> {
  const env = config.epic.environment;
  const link = await getEpicLink(userId, env);

  if (!link) {
    throw new EpicLinkRequiredError(
      `No MyChart account is linked for the ${env} environment. ` +
        `Open ${linkUrl()} in a browser and sign in to MyChart to link one.`,
    );
  }
  if (link.invalidatedAt) {
    throw new EpicLinkRequiredError(
      `The MyChart link stopped working (${link.invalidReason ?? "unknown reason"}). ` +
        `Re-link at ${linkUrl()}.`,
    );
  }

  const refreshToken = await decryptSecret(link.refreshTokenEnc);

  let tokens;
  try {
    tokens = await refreshAccessToken(refreshToken);
  } catch (err) {
    // A 400 from the token endpoint means the grant itself is dead (revoked,
    // expired, or consent withdrawn). Retrying will never help, so mark the
    // link invalid and tell the person to re-link. Anything else (5xx,
    // network) is transient: let it bubble so the caller can retry.
    if (err instanceof EpicError && err.status && err.status >= 400 && err.status < 500) {
      await invalidateEpicLink(userId, env, `token refresh rejected (${err.status})`);
      logger.warn(
        { userId, env, status: err.status },
        "Epic refresh token rejected; link marked invalid",
      );
      throw new EpicLinkRequiredError(
        `MyChart rejected the saved credential, which usually means access was revoked ` +
          `or expired. Re-link at ${linkUrl()}.`,
      );
    }
    throw err;
  }

  // Epic rotates refresh tokens: a refresh response usually carries a NEW one,
  // and the old one stops working. Failing to persist it bricks the link on
  // the next call, so this write is not optional.
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    await updateEpicRefreshToken(userId, env, await encryptSecret(tokens.refreshToken));
  }

  // Prefer the patient context from this exchange; fall back to what we stored
  // at link time.
  const patientId = tokens.patientId ?? link.patientId;
  if (!patientId) {
    throw new EpicLinkRequiredError(
      `The MyChart link has no patient context, so there is no chart to read. ` +
        `Re-link at ${linkUrl()} and make sure a patient is selected.`,
    );
  }

  return { accessToken: tokens.accessToken, patientId, link };
}
