import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { provider } from "./auth-provider.js";
import { buildMcpServer } from "./mcp-server.js";
import { exchangeIdpCode, IdentityNotAllowedError } from "./idp.js";
import { buildAuthorizeUrl, createPkcePair, exchangeCode } from "./epic.js";
import { encryptSecret } from "./crypto.js";
import {
  consumePendingAuth,
  consumePendingEpicLink,
  saveAuthCode,
  saveEpicLink,
  savePendingEpicLink,
  upsertUser,
} from "./store.js";

const app = express();
// Behind Cloud Run's reverse proxy: trust the first X-Forwarded-* hop so
// req.protocol/ip and the SDK's rate limiter resolve correctly.
app.set("trust proxy", 1);
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: "4mb" }));

// ---- Health / info ----
// Note: use /health, not /healthz -- Cloud Run's frontend reserves /healthz.
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) =>
  res
    .status(200)
    .type("text/plain")
    .send(`MCP connector. Add this URL in Claude as a Custom Connector: ${config.baseUrl}/mcp`),
);

// ---- OAuth Authorization Server (federates to the IdP) ----
// This ONE call mounts /authorize, /token, /register, /revoke and the
// discovery metadata documents. That is what makes us a real OAuth 2.1 AS,
// which claude.ai custom connectors require. DCR is included for free.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.baseUrl),
    baseUrl: new URL(config.baseUrl),
    scopesSupported: ["mcp"],
    resourceName: "Example MCP Connector",
  }),
);

// ---- IdP callback: finish the flow provider.authorize() started ----
app.get("/oauth/idp/callback", async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const pending = state ? await consumePendingAuth(state) : undefined;

  if (!pending) {
    res
      .status(400)
      .type("text/plain")
      .send("Login session expired. Please retry adding the connector.");
    return;
  }
  const redirectBack = (params: Record<string, string>) => {
    const url = new URL(pending.redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (pending.clientState) url.searchParams.set("state", pending.clientState);
    res.redirect(url.toString());
  };

  if (error || !code) {
    redirectBack({ error: error ?? "access_denied" });
    return;
  }

  try {
    const identity = await exchangeIdpCode(code);
    await upsertUser({
      userId: identity.sub,
      email: identity.email,
      domain: identity.domain,
      name: identity.name,
    });

    const authCode = randomUUID();
    await saveAuthCode(authCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      userId: identity.sub,
      resource: pending.resource,
    });
    redirectBack({ code: authCode });
  } catch (err) {
    if (err instanceof IdentityNotAllowedError) {
      // The person signed in fine; we are refusing them. Say so, so the client
      // stops instead of retrying a request that can never succeed.
      req.log.warn({ err }, "IdP callback denied");
      redirectBack({ error: "access_denied" });
      return;
    }
    req.log.error({ err }, "IdP callback failed");
    redirectBack({ error: "server_error" });
  }
});

// ---- MCP endpoint (bearer-protected, stateless per request) ----
const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${config.baseUrl}/.well-known/oauth-protected-resource`,
});

// ---- MyChart account linking ----
//
// Separate from the OAuth flow above. That one proves who is talking to this
// connector; this one obtains permission to read a chart from Epic. A person
// opens /epic/link in a browser, signs in to MyChart, and we store the
// resulting refresh token (encrypted) against their user id.

/**
 * Start the link. Bearer-protected so we know WHOSE link this is: the Epic
 * refresh token we end up with must be filed against a real user, never
 * against an anonymous browser session.
 */
app.get("/epic/link", bearer, async (req: Request, res: Response) => {
  const userId = (req as Request & { auth?: { extra?: { userId?: string } } }).auth?.extra?.userId;
  if (!userId) {
    res.status(401).type("text/plain").send("Unauthenticated.");
    return;
  }
  try {
    const { verifier, challenge } = createPkcePair();
    const state = randomUUID();
    await savePendingEpicLink(state, {
      userId,
      environment: config.epic.environment,
      codeVerifier: verifier,
    });
    res.redirect(await buildAuthorizeUrl(state, challenge));
  } catch (err) {
    req.log.error({ err }, "Could not start MyChart link");
    res.status(502).type("text/plain").send("Could not reach MyChart to start the link.");
  }
});

/**
 * Finish the link. Epic redirects here with ?code and our ?state. This URL
 * must exactly match a redirect URI registered on the Epic app record.
 */
app.get("/epic/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description: errorDescription } =
    req.query as Record<string, string | undefined>;

  const page = (title: string, body: string, status = 200) =>
    res.status(status).type("text/html").send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${title}</title>` +
        `<body style="font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem">` +
        `<h1 style="font-size:1.3rem">${title}</h1>${body}</body>`,
    );

  if (error) {
    // The person declined, or Epic refused. Say so plainly rather than
    // pretending it was a server fault.
    req.log.warn({ error, errorDescription }, "MyChart link denied");
    page("MyChart link was not completed", `<p>${errorDescription ?? error}</p>`, 400);
    return;
  }
  if (!code || !state) {
    page("Missing authorization code", "<p>Start again from the link page.</p>", 400);
    return;
  }

  // Single-use: a replayed callback finds nothing and cannot re-link.
  const pending = await consumePendingEpicLink(state);
  if (!pending) {
    page(
      "This link request expired",
      "<p>Link requests are valid for 10 minutes and can only be used once. Please start again.</p>",
      400,
    );
    return;
  }

  try {
    const tokens = await exchangeCode(code, pending.codeVerifier);
    if (!tokens.refreshToken) {
      // Without a refresh token there is no unattended sync, which is the
      // whole point. Fail loudly rather than storing a link that dies in an
      // hour and looks like a mystery later.
      throw new Error(
        "MyChart did not return a refresh token. The Epic app record needs " +
          "'Requires Persistent Access' enabled and the request must include the " +
          "offline_access scope.",
      );
    }

    await saveEpicLink({
      userId: pending.userId,
      environment: pending.environment,
      fhirBaseUrl: config.epic.fhirBaseUrl,
      refreshTokenEnc: await encryptSecret(tokens.refreshToken),
      patientId: tokens.patientId,
      scope: tokens.scope,
    });

    req.log.info(
      { userId: pending.userId, env: pending.environment, hasPatient: !!tokens.patientId },
      "MyChart link established",
    );

    page(
      "MyChart is linked",
      `<p>You can close this tab and go back to your conversation.</p>` +
        (tokens.patientId
          ? `<p style="color:#5a5f66">Linked chart: <code>${tokens.patientId}</code></p>`
          : `<p style="color:#b23"><strong>Note:</strong> MyChart did not tell us which patient this token opens. Reads may fail.</p>`),
    );
  } catch (err) {
    req.log.error({ err }, "MyChart link failed");
    page(
      "Could not finish linking MyChart",
      `<p>${err instanceof Error ? err.message : String(err)}</p>`,
      502,
    );
  }
});

app.post("/mcp", bearer, async (req: Request, res: Response) => {
  // Stateless: a fresh server + transport per request suits Cloud Run's
  // horizontally-scaled, non-sticky instances.
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    req.log.error({ err }, "MCP request failed");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE on /mcp aren't used in stateless mode; respond per spec.
app.get("/mcp", bearer, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed; this server is stateless." },
    id: null,
  });
});

app.listen(config.port, () => {
  logger.info(
    { baseUrl: config.baseUrl, port: config.port, env: config.nodeEnv },
    "MCP connector server listening",
  );
});
