import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getUser } from "../store.js";
import { guard, json, ok, userIdFrom, emailFrom } from "./util.js";

/**
 * Example tools. These prove the whole pipeline works end to end: Claude
 * connected over OAuth, a valid bearer token arrived, and the handler can see
 * WHO is calling. Replace these with your real tools.
 *
 * The important pattern: every handler gets the authenticated user for free via
 * `userIdFrom(extra)` / `emailFrom(extra)`. That identity was established during
 * the OAuth login and is carried on every request's bearer token, so you never
 * ask the model who it is -- you read it from the token.
 */
export function registerExampleTools(server: McpServer): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the identity of the signed-in user (from the OAuth token). Useful to confirm the connector is authenticated.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async (_args, extra) => {
      const userId = userIdFrom(extra);
      const stored = await getUser(userId);
      return json({
        userId,
        email: emailFrom(extra) ?? stored?.email,
        name: stored?.name,
        domain: stored?.domain,
      });
    }),
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echo back a message. A trivial tool to confirm tool calls work.",
      inputSchema: {
        message: z.string().min(1).describe("Text to echo back."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args) => ok(args.message)),
  );

  // ---- Where your real tools go ----
  //
  // To call a backend API on the user's behalf, register a tool here and, inside
  // the handler, look up whatever credential you stored for `userIdFrom(extra)`
  // during login, then make the call. Keep any third-party secret ENCRYPTED at
  // rest (e.g. Cloud KMS) -- see docs/EXTENDING.md.
}
