import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { fhirGet, fhirGetBinary } from "../epic.js";
import { EpicLinkRequiredError, getEpicSession } from "../epic-session.js";
import { deleteEpicLink, getEpicLink } from "../store.js";
import { guard, json, ok, userIdFrom, type ToolResult } from "./util.js";

/**
 * Tools that read a linked MyChart record.
 *
 * Every handler resolves the caller's Epic session first, which refreshes the
 * access token and yields the patient id the token is scoped to. Handlers
 * never accept a patient id as an argument: the token decides whose chart is
 * readable, so there is no way for the model to be talked into reading someone
 * else's record.
 */

// ---- FHIR shapes (only the fields we actually read) ----

interface FhirCoding {
  display?: string;
  code?: string;
  system?: string;
}
interface FhirCodeableConcept {
  text?: string;
  coding?: FhirCoding[];
}
interface FhirReference {
  reference?: string;
  display?: string;
}
interface FhirAttachment {
  contentType?: string;
  url?: string;
  title?: string;
  data?: string;
}
interface FhirBundleEntry<T> {
  resource?: T;
}
interface FhirBundle<T> {
  entry?: FhirBundleEntry<T>[];
  total?: number;
  link?: { relation?: string; url?: string }[];
}

function label(c?: FhirCodeableConcept): string | undefined {
  return c?.text ?? c?.coding?.find((x) => x.display)?.display ?? c?.coding?.[0]?.code;
}

/** Pull `Binary/abc` out of a FHIR reference or a full URL. */
function binaryIdFrom(urlOrRef?: string): string | undefined {
  if (!urlOrRef) return undefined;
  const m = /Binary\/([A-Za-z0-9\-._%]+)/.exec(urlOrRef);
  return m?.[1];
}

/** Turn a link-required error into guidance rather than a stack trace. */
function asToolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerMyChartTools(server: McpServer): void {
  // ---- Link status ----

  server.registerTool(
    "mychart_status",
    {
      title: "MyChart link status",
      description:
        "Check whether a MyChart account is linked, which patient chart it opens, and whether the " +
        "stored credential still works. Run this first if any other tool reports a problem.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async (_args, extra) => {
      const userId = userIdFrom(extra);
      const link = await getEpicLink(userId, config.epic.environment);
      if (!link) {
        return json({
          linked: false,
          environment: config.epic.environment,
          linkUrl: `${config.baseUrl}/epic/link`,
          hint: "Open linkUrl in a browser and sign in to MyChart.",
        });
      }
      // Actually exercise the credential. "A row exists" is not the same as
      // "this still works", and the difference matters here.
      let credentialWorks = true;
      let problem: string | undefined;
      try {
        await getEpicSession(userId);
      } catch (err) {
        credentialWorks = false;
        problem = err instanceof Error ? err.message : String(err);
      }
      return json({
        linked: true,
        environment: link.environment,
        fhirBaseUrl: link.fhirBaseUrl,
        patientId: link.patientId,
        scope: link.scope,
        linkedAt: link.linkedAt?.toDate?.().toISOString(),
        credentialWorks,
        problem,
      });
    }),
  );

  // ---- Who the chart belongs to ----

  server.registerTool(
    "mychart_patient",
    {
      title: "Get the linked patient",
      description:
        "Return demographics for the patient whose chart this link opens: name, birth date, sex, " +
        "and MRN-style identifiers. Use this to confirm WHOSE records you are about to read.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async (_args, extra) => {
      try {
        const { accessToken, patientId } = await getEpicSession(userIdFrom(extra));
        const p = await fhirGet<{
          id?: string;
          name?: { text?: string; given?: string[]; family?: string }[];
          birthDate?: string;
          gender?: string;
          identifier?: { system?: string; value?: string; type?: FhirCodeableConcept }[];
        }>(accessToken, `Patient/${encodeURIComponent(patientId)}`);
        const n = p.name?.[0];
        return json({
          patientId: p.id ?? patientId,
          name: n?.text ?? [n?.given?.join(" "), n?.family].filter(Boolean).join(" "),
          birthDate: p.birthDate,
          gender: p.gender,
          identifiers: p.identifier?.map((i) => ({ type: label(i.type), value: i.value })),
        });
      } catch (err) {
        if (err instanceof EpicLinkRequiredError) return asToolError(err);
        throw err;
      }
    }),
  );

  // ---- Lab results ----

  server.registerTool(
    "mychart_labs",
    {
      title: "Get lab results",
      description:
        "List laboratory results (FHIR Observation, category=laboratory) for the linked patient, " +
        "newest first. Optionally filter by date. Returns the test name, value, units, reference " +
        "range and abnormal flag.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("Only results on or after this date, YYYY-MM-DD."),
        until: z.string().optional().describe("Only results on or before this date, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(200).default(50).describe("Max results to return."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      try {
        const { accessToken, patientId } = await getEpicSession(userIdFrom(extra));
        const q = new URLSearchParams({ patient: patientId, category: "laboratory" });
        if (args.since) q.append("date", `ge${args.since}`);
        if (args.until) q.append("date", `le${args.until}`);
        q.set("_count", String(args.limit));

        const bundle = await fhirGet<
          FhirBundle<{
            id?: string;
            code?: FhirCodeableConcept;
            effectiveDateTime?: string;
            issued?: string;
            valueQuantity?: { value?: number; unit?: string };
            valueString?: string;
            valueCodeableConcept?: FhirCodeableConcept;
            interpretation?: FhirCodeableConcept[];
            referenceRange?: { text?: string; low?: { value?: number }; high?: { value?: number } }[];
            status?: string;
          }>
        >(accessToken, `Observation?${q.toString()}`);

        const results = (bundle.entry ?? [])
          .map((e) => e.resource)
          .filter(Boolean)
          .map((o) => ({
            id: o!.id,
            test: label(o!.code),
            when: o!.effectiveDateTime ?? o!.issued,
            value:
              o!.valueQuantity?.value !== undefined
                ? `${o!.valueQuantity.value}${o!.valueQuantity.unit ? " " + o!.valueQuantity.unit : ""}`
                : (o!.valueString ?? label(o!.valueCodeableConcept)),
            referenceRange: o!.referenceRange?.[0]?.text,
            // Epic uses the standard interpretation codes (H, L, A, N...).
            // Surfacing this verbatim matters: never restate an abnormal
            // result as normal.
            interpretation: o!.interpretation?.map((i) => label(i)).filter(Boolean),
            status: o!.status,
          }))
          .sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));

        return json({ count: results.length, total: bundle.total, results });
      } catch (err) {
        if (err instanceof EpicLinkRequiredError) return asToolError(err);
        throw err;
      }
    }),
  );

  // ---- Diagnostic reports (incl. radiology narratives) ----

  server.registerTool(
    "mychart_reports",
    {
      title: "Get diagnostic reports",
      description:
        "List diagnostic reports (FHIR DiagnosticReport) for the linked patient: radiology and " +
        "imaging reports, pathology, and lab panels. Includes any attachment ids, which can be " +
        "fetched with mychart_attachment.",
      inputSchema: {
        since: z.string().optional().describe("Only reports on or after this date, YYYY-MM-DD."),
        until: z.string().optional().describe("Only reports on or before this date, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max reports to return."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      try {
        const { accessToken, patientId } = await getEpicSession(userIdFrom(extra));
        const q = new URLSearchParams({ patient: patientId });
        if (args.since) q.append("date", `ge${args.since}`);
        if (args.until) q.append("date", `le${args.until}`);
        q.set("_count", String(args.limit));

        const bundle = await fhirGet<
          FhirBundle<{
            id?: string;
            code?: FhirCodeableConcept;
            category?: FhirCodeableConcept[];
            effectiveDateTime?: string;
            issued?: string;
            status?: string;
            conclusion?: string;
            presentedForm?: FhirAttachment[];
            result?: FhirReference[];
          }>
        >(accessToken, `DiagnosticReport?${q.toString()}`);

        const reports = (bundle.entry ?? [])
          .map((e) => e.resource)
          .filter(Boolean)
          .map((r) => ({
            id: r!.id,
            name: label(r!.code),
            category: r!.category?.map((c) => label(c)).filter(Boolean),
            when: r!.effectiveDateTime ?? r!.issued,
            status: r!.status,
            conclusion: r!.conclusion,
            // The readable narrative often lives in an attachment rather than
            // in the resource itself.
            attachments: (r!.presentedForm ?? []).map((a) => ({
              contentType: a.contentType,
              title: a.title,
              binaryId: binaryIdFrom(a.url),
            })),
            resultCount: r!.result?.length ?? 0,
          }))
          .sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));

        return json({ count: reports.length, total: bundle.total, reports });
      } catch (err) {
        if (err instanceof EpicLinkRequiredError) return asToolError(err);
        throw err;
      }
    }),
  );

  // ---- Documents ----

  server.registerTool(
    "mychart_documents",
    {
      title: "Get clinical documents",
      description:
        "List clinical documents (FHIR DocumentReference) for the linked patient: notes, " +
        "radiology result documents, lab documents and CCDAs. Each entry carries a binaryId that " +
        "mychart_attachment can fetch.",
      inputSchema: {
        since: z.string().optional().describe("Only documents on or after this date, YYYY-MM-DD."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max documents to return."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      try {
        const { accessToken, patientId } = await getEpicSession(userIdFrom(extra));
        const q = new URLSearchParams({ patient: patientId });
        if (args.since) q.append("date", `ge${args.since}`);
        q.set("_count", String(args.limit));

        const bundle = await fhirGet<
          FhirBundle<{
            id?: string;
            type?: FhirCodeableConcept;
            category?: FhirCodeableConcept[];
            date?: string;
            description?: string;
            status?: string;
            content?: { attachment?: FhirAttachment }[];
          }>
        >(accessToken, `DocumentReference?${q.toString()}`);

        const documents = (bundle.entry ?? [])
          .map((e) => e.resource)
          .filter(Boolean)
          .map((d) => ({
            id: d!.id,
            type: label(d!.type),
            category: d!.category?.map((c) => label(c)).filter(Boolean),
            when: d!.date,
            description: d!.description,
            status: d!.status,
            attachments: (d!.content ?? [])
              .map((c) => c.attachment)
              .filter(Boolean)
              .map((a) => ({
                contentType: a!.contentType,
                title: a!.title,
                binaryId: binaryIdFrom(a!.url),
              })),
          }))
          .sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));

        return json({ count: documents.length, total: bundle.total, documents });
      } catch (err) {
        if (err instanceof EpicLinkRequiredError) return asToolError(err);
        throw err;
      }
    }),
  );

  // ---- Attachments ----

  server.registerTool(
    "mychart_attachment",
    {
      title: "Fetch an attachment",
      description:
        "Download one attachment (FHIR Binary) by its binaryId, as returned by mychart_reports or " +
        "mychart_documents. Text and HTML come back as readable text; PDFs and images come back " +
        "base64-encoded with their content type.",
      inputSchema: {
        binaryId: z.string().min(1).describe("The Binary resource id, e.g. from a report."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      try {
        const { accessToken } = await getEpicSession(userIdFrom(extra));
        const { contentType, base64, bytes } = await fhirGetBinary(accessToken, args.binaryId);

        // Decode the things a model can actually read; leave binary formats
        // encoded rather than emitting mojibake.
        if (/^(text\/|application\/(xml|json|xhtml))/i.test(contentType)) {
          const text = Buffer.from(base64, "base64").toString("utf8");
          return ok(text, { binaryId: args.binaryId, contentType, bytes });
        }
        return json({
          binaryId: args.binaryId,
          contentType,
          bytes,
          encoding: "base64",
          data: base64,
        });
      } catch (err) {
        if (err instanceof EpicLinkRequiredError) return asToolError(err);
        throw err;
      }
    }),
  );

  // ---- Appointments ----

  server.registerTool(
    "mychart_appointments",
    {
      title: "Get appointments",
      description:
        "List appointments for the linked patient, including upcoming visits. Returns the " +
        "appointment type, date and time, status, practitioner and location.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("Only appointments on or after this date, YYYY-MM-DD. Defaults to today."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max appointments."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args, extra) => {
      try {
        const { accessToken, patientId } = await getEpicSession(userIdFrom(extra));
        const q = new URLSearchParams({ patient: patientId });
        q.append("date", `ge${args.since ?? new Date().toISOString().slice(0, 10)}`);
        q.set("_count", String(args.limit));

        const bundle = await fhirGet<
          FhirBundle<{
            id?: string;
            status?: string;
            start?: string;
            end?: string;
            minutesDuration?: number;
            description?: string;
            serviceType?: FhirCodeableConcept[];
            appointmentType?: FhirCodeableConcept;
            participant?: { actor?: FhirReference }[];
            comment?: string;
          }>
        >(accessToken, `Appointment?${q.toString()}`);

        const appointments = (bundle.entry ?? [])
          .map((e) => e.resource)
          .filter(Boolean)
          .map((a) => ({
            id: a!.id,
            what: a!.description ?? label(a!.appointmentType) ?? a!.serviceType?.map(label).join(", "),
            start: a!.start,
            end: a!.end,
            minutes: a!.minutesDuration,
            status: a!.status,
            participants: a!.participant?.map((p) => p.actor?.display).filter(Boolean),
            comment: a!.comment,
          }))
          .sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));

        return json({ count: appointments.length, total: bundle.total, appointments });
      } catch (err) {
        if (err instanceof EpicLinkRequiredError) return asToolError(err);
        throw err;
      }
    }),
  );

  // ---- Unlink / delete ----
  //
  // The published Terms promise that data is deleted when the user asks, and
  // that unlinking alone does NOT erase anything. This tool is that promise in
  // code: it revokes access, and only erases stored data when explicitly told
  // to.

  server.registerTool(
    "mychart_unlink",
    {
      title: "Unlink MyChart",
      description:
        "Disconnect the MyChart account, deleting the stored credential so this connector can no " +
        "longer read the chart. This does NOT delete any records already saved elsewhere. " +
        "Requires confirm=true, because re-linking needs a browser sign-in.",
      inputSchema: {
        confirm: z
          .boolean()
          .describe("Must be true. Guards against unlinking on a vague instruction."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(async (args, extra) => {
      if (!args.confirm) {
        return ok(
          "Not unlinked. Call again with confirm=true if you really want to disconnect MyChart. " +
            "Re-linking requires signing in to MyChart again in a browser.",
        );
      }
      const userId = userIdFrom(extra);
      const link = await getEpicLink(userId, config.epic.environment);
      if (!link) return ok("There was no MyChart link to remove.");
      await deleteEpicLink(userId, config.epic.environment);
      return ok(
        `MyChart link removed for the ${config.epic.environment} environment. The stored ` +
          `credential is deleted and this connector can no longer read the chart. Records saved ` +
          `elsewhere are untouched. Re-link at ${config.baseUrl}/epic/link`,
      );
    }),
  );
}
