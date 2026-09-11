import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type ToolResult = CallToolResult;

/** The authenticated user's id (IdP subject), set by the OAuth provider. */
export function userIdFrom(extra: ToolExtra): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    // Should be impossible: the MCP endpoint requires a valid bearer token.
    throw new Error("Unauthenticated request");
  }
  return userId;
}

/** The authenticated user's email, if present on the token. */
export function emailFrom(extra: ToolExtra): string | undefined {
  const email = extra.authInfo?.extra?.email;
  return typeof email === "string" ? email : undefined;
}

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

export function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Wraps a tool handler so downstream errors become clean, model-readable tool
 * errors instead of crashing the transport.
 */
export function guard<A>(
  handler: (args: A, extra: ToolExtra) => Promise<ToolResult>,
): (args: A, extra: ToolExtra) => Promise<ToolResult> {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  };
}
