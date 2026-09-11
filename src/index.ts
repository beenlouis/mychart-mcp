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
import { consumePendingAuth, saveAuthCode, upsertUser } from "./store.js";

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
