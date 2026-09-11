import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMyChartTools } from "./tools/mychart.js";
import { registerExampleTools } from "./tools/example.js";

/**
 * Builds a fully-configured MCP server with every tool registered. A fresh
 * instance is created per request in index.ts (stateless, suits Cloud Run).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "mychart-care-record",
      version: "0.1.0",
    },
    {
      instructions: [
        "Reads a patient's own health records from an Epic MyChart portal, for a family keeping",
        "an organized copy of their care record.",
        "",
        "Start with `mychart_status` to confirm an account is linked and the credential still",
        "works. If it reports a problem, the fix is always for the person to open the link URL in",
        "a browser and sign in to MyChart; nothing here can repair it on their behalf.",
        "",
        "`mychart_patient` confirms WHOSE chart is linked. Run it before summarizing anything, and",
        "say whose records you are reading. Where a parent has proxy access, the linked chart may",
        "be their child's rather than their own.",
        "",
        "Reading: `mychart_labs` for lab values, `mychart_reports` for diagnostic and radiology",
        "reports, `mychart_documents` for notes and clinical documents. Reports and documents",
        "carry attachment ids; pass one to `mychart_attachment` to read the actual narrative,",
        "which is often where the substance of a radiology report lives.",
        "`mychart_appointments` covers upcoming visits.",
        "",
        "Everything here is READ-ONLY. Nothing can write to, change, or delete a medical record.",
        "",
        "Handling these results:",
        "- Report values exactly as returned, including units and the `interpretation` field.",
        "  Never restate a result flagged abnormal as normal, and never soften it.",
        "- Do not diagnose, do not interpret results clinically, and do not speculate about",
        "  prognosis. Organize, extract and surface; leave judgement to the person and their",
        "  care team.",
        "- If asked what a result means, give the plain factual content and point to the care",
        "  team rather than guessing.",
        "- These are real medical records for a real person. Read only what the task needs.",
      ].join("\n"),
    },
  );

  registerMyChartTools(server);
  registerExampleTools(server);

  return server;
}
