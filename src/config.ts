/**
 * Central, validated configuration. Fails fast at startup if a required
 * value is missing so we never deploy a half-configured server.
 */
import { z } from "zod";

const RawEnv = z.object({
  PUBLIC_BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // --- Identity provider (Google by default; see src/idp.ts to swap) ---
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  // WHO may connect this server. Prefer ALLOWED_EMAILS: this connector reads a
  // child's medical records, so an explicit allowlist of individuals is the
  // right gate, not "anyone who happens to hold an address at this domain".
  // Comma-separated, case-insensitive.
  ALLOWED_EMAILS: z.string().optional(),
  // Fallback org-domain gate, checked against Google's verified "hd" claim.
  // Only consulted when ALLOWED_EMAILS is empty.
  ALLOWED_DOMAIN: z.string().optional(),

  // --- Storage ---
  GCP_PROJECT_ID: z.string().min(1),
  FIRESTORE_DATABASE_ID: z.string().default("(default)"),
  // Prefix for every Firestore collection this connector owns. Set a unique
  // value per connector (e.g. "drive_", "coda_") so multiple connectors can
  // share ONE GCP project / Firestore database without colliding. Empty is
  // fine for a single-connector project.
  FIRESTORE_COLLECTION_PREFIX: z.string().default(""),

  // Secret used to sign OUR OWN MCP access/refresh JWTs. 32+ bytes.
  // Generate with:  openssl rand -base64 48
  JWT_SIGNING_SECRET: z.string().min(32),

  // --- Cloud KMS (encrypts the Epic refresh token at rest) ---
  // projects/P/locations/L/keyRings/R/cryptoKeys/K
  KMS_KEY_NAME: z.string().min(1),

  // --- Epic / MyChart ---
  // Which Epic instance this deployment talks to. "sandbox" is Epic's shared
  // synthetic-data environment; anything else is a real org.
  EPIC_ENVIRONMENT: z.string().default("sandbox"),
  // FHIR R4 base URL, WITH trailing slash tolerated.
  //   sandbox: https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/
  //   St. Jude: https://rp.stjude.org/oauth2-prd/api/FHIR/R4/
  EPIC_FHIR_BASE_URL: z
    .string()
    .url()
    .default("https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/"),
  // Epic app client id. Use the NON-PRODUCTION id against the sandbox and the
  // production id against a real org.
  EPIC_CLIENT_ID: z.string().min(1),
  // Epic app client secret. The app is registered as a CONFIDENTIAL client,
  // which is what unlocks "Requires Persistent Access" (refresh tokens) in
  // Epic's app record. Public clients cannot get refresh tokens at all, so
  // this secret is what makes unattended background sync possible.
  // Injected from Secret Manager in prod; never commit it.
  EPIC_CLIENT_SECRET: z.string().min(1),
  // Space-delimited SMART scopes. offline_access is what makes unattended
  // background sync possible.
  EPIC_SCOPES: z
    .string()
    .default("openid fhirUser offline_access patient/*.read"),
});

const parsed = RawEnv.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "Invalid environment configuration:\n" +
      JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

const env = parsed.data;

/**
 * IdP scopes. Identity-only: we ask for just enough to know WHO logged in.
 * This connector never touches the user's data at the IdP. If you later add
 * tools that call a backend API on the user's behalf, add those scopes here
 * (and store the resulting refresh token encrypted -- see docs).
 */
export const OIDC_SCOPES = ["openid", "email", "profile"] as const;

export const config = {
  baseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  logLevel: env.LOG_LEVEL,

  idp: {
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    allowedEmails: (env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    allowedDomain: env.ALLOWED_DOMAIN,
    /** Where the IdP redirects back to us after user consent. */
    get redirectUri() {
      return `${config.baseUrl}/oauth/idp/callback`;
    },
  },

  gcp: {
    projectId: env.GCP_PROJECT_ID,
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID,
    collectionPrefix: env.FIRESTORE_COLLECTION_PREFIX,
    kmsKeyName: env.KMS_KEY_NAME,
  },

  epic: {
    environment: env.EPIC_ENVIRONMENT,
    /** Normalised, no trailing slash. */
    fhirBaseUrl: env.EPIC_FHIR_BASE_URL.replace(/\/$/, ""),
    clientId: env.EPIC_CLIENT_ID,
    clientSecret: env.EPIC_CLIENT_SECRET,
    scopes: env.EPIC_SCOPES,
    /** Must exactly match a redirect URI registered on the Epic app record. */
    get redirectUri() {
      return `${config.baseUrl}/epic/callback`;
    },
    /** Refresh a little early so a long tool call can't expire mid-flight. */
    accessTokenSkewSeconds: 120,
  },

  jwt: {
    signingSecret: new TextEncoder().encode(env.JWT_SIGNING_SECRET),
    issuer: env.PUBLIC_BASE_URL.replace(/\/$/, ""),
    /** MCP access tokens are short-lived; refresh tokens rotate them. */
    accessTokenTtlSeconds: 60 * 60, // 1h
    refreshTokenTtlSeconds: 60 * 60 * 24 * 30, // 30d
    // How long a just-rotated refresh token still answers a repeat exchange.
    // Covers client retries around a hung request or a cold start; beyond it,
    // re-presenting a spent token is treated as reuse.
    refreshRotationGraceMs: 60_000, // 60s
    authCodeTtlSeconds: 60 * 5, // 5m
  },
} as const;

export type AppConfig = typeof config;
