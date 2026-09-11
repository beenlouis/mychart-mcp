/**
 * Integration test for refresh-token rotation.
 *
 * Guards the failure that took two live connectors down on 2026-09-01: a
 * legitimate client retry of a token exchange (Claude retries when a request
 * hangs, and a Cloud Run cold start does hang) presented the same refresh token
 * twice. Rotation deleted the spent record outright, so the retry could never
 * succeed, and because the resulting throw was a bare Error the SDK returned
 * 500 rather than 400 invalid_grant. A 500 reads as "retry later", so the
 * client retried forever and never prompted the user to reconnect. Permanently
 * wedged, with a valid token sitting unused in Firestore.
 *
 * Run against a real Firestore (transaction semantics are the thing under
 * test, so a stub would prove nothing) using a throwaway collection prefix:
 *
 *   gcloud auth application-default login   # ADC; `gcloud auth login` is NOT enough
 *   npm run build
 *   node test/refresh-rotation.test.mjs
 *
 * Set FIRESTORE_COLLECTION_PREFIX to something disposable. The test deletes
 * everything it writes.
 */
import { randomUUID } from "node:crypto";

// Minimal env so config.ts validates. Override GCP_PROJECT_ID as needed.
process.env.PUBLIC_BASE_URL ??= "https://example.invalid";
process.env.NODE_ENV = "test";
process.env.GCP_PROJECT_ID ??= "lewis-personal-finance-mcp";
process.env.FIRESTORE_COLLECTION_PREFIX ??= `ztest_rotation_${Date.now()}_`;
process.env.JWT_SIGNING_SECRET ??= "0".repeat(40);
// Per-connector required vars. config.ts validates the whole env up front, so
// every connector's own required keys need *some* value even though rotation
// touches none of them. Placeholders only; anything already set wins. Add a
// line here when you copy this test into a connector with extra requirements.
process.env.OIDC_CLIENT_ID ??= "x";
process.env.OIDC_CLIENT_SECRET ??= "x";
process.env.GOOGLE_CLIENT_ID ??= "x";
process.env.GOOGLE_CLIENT_SECRET ??= "x";
process.env.ALLOWED_DOMAIN ??= "example.com";
process.env.ALLOWED_EMAILS ??= "test@example.com";
process.env.WEBHOOK_INGEST_SECRET ??= "0123456789abcdef";
process.env.REPLICA_BUCKET ??= "x";
process.env.HOSPITABLE_PAT ??= "x";

const store = await import("../dist/store.js");

let pass = 0;
let fail = 0;
const written = new Set();
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
};
async function seed(jti) {
  await store.saveRefreshToken(jti, {
    userId: "test-user",
    clientId: "test-client",
    scopes: ["test"],
    familyId: jti,
  });
  written.add(jti);
  return jti;
}
const GRACE = 60_000;

// ---- 1. the happy path -----------------------------------------------------
const a = await seed(randomUUID());
const b = randomUUID();
const rotated = await store.rotateRefreshToken(a, b, { scopes: ["test"], graceMs: GRACE });
written.add(b);
ok("rotation returns 'rotated' with the new jti", rotated.status === "rotated" && rotated.jti === b, JSON.stringify(rotated));
ok("the spent token stops reading as valid", (await store.getRefreshToken(a)) === undefined);
ok("the successor reads as valid", (await store.getRefreshToken(b)) !== undefined);

// ---- 2. the regression: a retry of an exchange that already succeeded ------
const replay = await store.rotateRefreshToken(a, randomUUID(), { scopes: ["test"], graceMs: GRACE });
ok("retry inside the grace window returns 'replayed', not a failure", replay.status === "replayed", JSON.stringify(replay));
ok("the retry converges on the SAME successor jti", replay.jti === b, JSON.stringify(replay));

// ---- 3. the actual trigger: concurrent exchanges ---------------------------
const c = await seed(randomUUID());
const concurrent = await Promise.all(
  Array.from({ length: 6 }, () => {
    const next = randomUUID();
    written.add(next);
    return store.rotateRefreshToken(c, next, { scopes: ["test"], graceMs: GRACE });
  }),
);
const statuses = concurrent.map((r) => r.status);
const liveJtis = new Set(concurrent.map((r) => r.jti).filter(Boolean));
ok("6 concurrent exchanges: exactly one wins", statuses.filter((s) => s === "rotated").length === 1, JSON.stringify(statuses));
ok("6 concurrent exchanges: none hard-fail", !statuses.some((s) => s === "unknown" || s === "reuse_detected"), JSON.stringify(statuses));
ok("6 concurrent exchanges: all converge on one live jti", liveJtis.size === 1, [...liveJtis].join(","));

// ---- 4. genuine reuse, outside the window, still revokes the family --------
const d = await seed(randomUUID());
const e = randomUUID();
await store.rotateRefreshToken(d, e, { scopes: ["test"], graceMs: GRACE });
written.add(e);
const reuse = await store.rotateRefreshToken(d, randomUUID(), { scopes: ["test"], graceMs: 0 });
ok("reuse outside the grace window is detected", reuse.status === "reuse_detected", JSON.stringify(reuse));
if (reuse.status === "reuse_detected") {
  await store.revokeRefreshTokenFamily(reuse.familyId);
  ok("family revoke also kills the live successor", (await store.getRefreshToken(e)) === undefined);
}

// ---- 5. a chain rotated more than once inside the window ------------------
// Regression: returning the *immediate* successor could hand back a token that
// had itself already been rotated. The client's next refresh would then look
// like reuse and wrongly revoke the family. The walk must reach the live tip.
const chainA = await seed(randomUUID());
const chainB = randomUUID();
const chainC = randomUUID();
await store.rotateRefreshToken(chainA, chainB, { scopes: ["test"], graceMs: GRACE });
written.add(chainB);
await store.rotateRefreshToken(chainB, chainC, { scopes: ["test"], graceMs: GRACE });
written.add(chainC);
const deep = await store.rotateRefreshToken(chainA, randomUUID(), { scopes: ["test"], graceMs: GRACE });
ok("a twice-rotated chain replays to the LIVE tip, not the middle", deep.status === "replayed" && deep.jti === chainC, JSON.stringify({ status: deep.status, got: deep.jti, wantTip: chainC, middle: chainB }));

// ---- 6. a family larger than one Firestore batch ---------------------------
// Regression: Firestore caps a batch at 500 writes. Hourly refreshes over a
// 30-day token lifetime produce ~720 records in a family, so an unchunked
// revoke would throw exactly when it mattered most.
const bigFamily = randomUUID();
const OVERSIZED = 520;
for (let i = 0; i < OVERSIZED; i += 400) {
  await Promise.all(
    Array.from({ length: Math.min(400, OVERSIZED - i) }, () => {
      const jti = randomUUID();
      written.add(jti);
      return store.saveRefreshToken(jti, {
        userId: "test-user",
        clientId: "test-client",
        scopes: ["test"],
        familyId: bigFamily,
      });
    }),
  );
}
let bigRevokeError = null;
try {
  await store.revokeRefreshTokenFamily(bigFamily);
} catch (err) {
  bigRevokeError = err;
}
ok(`revoking a ${OVERSIZED}-token family does not hit the 500-write batch cap`, bigRevokeError === null, String(bigRevokeError));

// ---- 7. a token we never issued -------------------------------------------
const unknown = await store.rotateRefreshToken(randomUUID(), randomUUID(), { scopes: ["test"], graceMs: GRACE });
ok("an unknown token reports 'unknown' (maps to invalid_grant, never 500)", unknown.status === "unknown", JSON.stringify(unknown));

// ---- teardown --------------------------------------------------------------
for (const jti of written) {
  try {
    await store.revokeRefreshToken(jti);
  } catch {
    /* already gone */
  }
}
console.log(`\n  ${pass} passed, ${fail} failed  (prefix ${process.env.FIRESTORE_COLLECTION_PREFIX})`);
process.exit(fail ? 1 : 0);
