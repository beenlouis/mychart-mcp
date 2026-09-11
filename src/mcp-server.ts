import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExampleTools } from "./tools/example.js";

/**
 * Builds a fully-configured MCP server with every tool registered. A fresh
 * instance is created per request in index.ts (stateless, suits Cloud Run).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "example-mcp-connector",
      version: "0.1.0",
    },
    {
      instructions:
        "Example MCP connector. Replace this text with a description of what your " +
        "tools do and how the model should use them. The `whoami` tool confirms " +
        "the signed-in identity; `echo` confirms tool calls work.",
    },
  );

  registerExampleTools(server);
  // registerYourOtherTools(server);

  return server;
}
