// One metric inside a report: its data rows, Excel template and import, narrative and its
// history, assignment and evidence files.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { docs, tagRoutes } from "../http/docs.js";
import { XLSX, parse, requireUser, sendFile } from "../http/helpers.js";
import { clientMetric } from "../http/views.js";
import { badRequest } from "../services/errors.js";
import { metricTemplate, parseImport } from "../services/excel.js";
import type { MetricParams, RouteDeps } from "./shared.js";

const isOfficeZip = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && b.includes("[Content_Types].xml");
/** Allowed evidence types, each with a check that the bytes really are that type (not just the label). */
const ALLOWED_UPLOADS: Record<string, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1").startsWith("%PDF"),
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": isOfficeZip,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": isOfficeZip,
};
const TYPE_NAMES: Record<string, string> = { "application/pdf": "PDF", "image/jpeg": "JPG", "image/png": "PNG" };

const Row = z.record(z.string(), z.unknown());
const RowsBody = z.union([Row, z.array(Row).max(500)]);
const NarrativeBody = z.record(z.string(), z.string().max(20000));
const NarrativePreviewBody = z.object({ fields: z.record(z.string(), z.string().max(20000)), fact_metrics: z.array(z.string()).max(10).optional() });
const AssignBody = z.object({ user_id: z.string().nullable() });
// Documentation only: the import handler reads these two query values directly.
const MetricImportQuery = z.object({
  commit: z.enum(["true", "false"]).optional().describe("true saves; anything else only checks and previews"),
  mode: z.enum(["append", "replace"]).optional().describe("append (default) or replace"),
});

type RowParams = { Params: { cycleId: string; metricId: string; rowId: string } };
type VersionParams = { Params: { cycleId: string; metricId: string; versionId: string } };
const versionId = (raw: string) => parse(z.coerce.number().int().positive(), raw);

export const metricRoutes: FastifyPluginAsync<RouteDeps> = async (app, { cfg, frameworks, ws }) => {
  tagRoutes(app, "Metrics");

  app.get<MetricParams>("/cycles/:cycleId/metrics/:metricId", docs({ summary: "Metric detail: definition, rows, value, narrative, evidence" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    const detail = await ws.metricDetail(a, req.params.metricId);
    return { ...detail, metric: clientMetric(detail.metric) };
  });

  app.post<MetricParams>(
    "/cycles/:cycleId/metrics/:metricId/rows",
    docs({
      summary: "Add one row or up to 500 rows",
      description: "Send an `Idempotency-Key` header to make retries safe: a replay returns 200 instead of 201 and adds nothing.",
      body: RowsBody,
    }),
    async (req, reply) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
      const b = parse(RowsBody, req.body);
      const key = req.headers["idempotency-key"];
      const idem = typeof key === "string" && key.length <= 200 ? key : undefined;
      const r = await ws.addRows(a, req.params.metricId, Array.isArray(b) ? b : [b], idem);
      return reply.status(r.replayed ? 200 : 201).send(r);
    },
  );

  app.put<RowParams>("/cycles/:cycleId/metrics/:metricId/rows/:rowId", docs({ summary: "Update a row", body: Row }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
    return ws.updateRow(a, req.params.metricId, req.params.rowId, parse(Row, req.body));
  });

  app.delete<RowParams>("/cycles/:cycleId/metrics/:metricId/rows/:rowId", docs({ summary: "Delete a row" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
    return ws.deleteRow(a, req.params.metricId, req.params.rowId);
  });

  app.get<MetricParams>("/cycles/:cycleId/metrics/:metricId/template.xlsx", docs({ summary: "Download the metric's Excel template" }), async (req, reply) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    const m = frameworks.metric(a.cycle.framework_id, req.params.metricId);
    return sendFile(reply, await metricTemplate(m, a.cycle.years), `${m.id}_template.xlsx`, XLSX);
  });

  app.post<MetricParams & { Querystring: { commit?: string; mode?: string } }>(
    "/cycles/:cycleId/metrics/:metricId/import",
    {
      ...docs({ summary: "Import rows from the filled template", description: "Every row is checked before anything is saved.", querystring: MetricImportQuery, upload: {} }),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
      const m = frameworks.metric(a.cycle.framework_id, req.params.metricId);
      const file = await req.file();
      if (!file) throw badRequest("Attach the filled .xlsx file");
      const body = await file.toBuffer();
      const parsed = await parseImport(m, body);
      return ws.importRows(a, m.id, parsed.rows, {
        commit: req.query.commit === "true",
        mode: req.query.mode === "replace" ? "replace" : "append",
        rowNumbers: parsed.rowNumbers,
      });
    },
  );

  app.put<MetricParams>("/cycles/:cycleId/metrics/:metricId/narrative", docs({ summary: "Save narrative fields", body: NarrativeBody }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
    return ws.saveNarrative(a, req.params.metricId, parse(NarrativeBody, req.body));
  });

  app.get<MetricParams>("/cycles/:cycleId/metrics/:metricId/narrative/versions", docs({ summary: "List narrative versions" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return ws.narrativeVersions(a, req.params.metricId);
  });

  app.get<VersionParams>("/cycles/:cycleId/metrics/:metricId/narrative/versions/:versionId", docs({ summary: "One narrative version" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return ws.narrativeVersion(a, req.params.metricId, versionId(req.params.versionId));
  });

  app.post<VersionParams>(
    "/cycles/:cycleId/metrics/:metricId/narrative/versions/:versionId/restore",
    docs({ summary: "Restore a narrative version (saved as a new version)" }),
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
      return ws.restoreNarrativeVersion(a, req.params.metricId, versionId(req.params.versionId));
    },
  );

  app.post<MetricParams>("/cycles/:cycleId/metrics/:metricId/narrative/preview", docs({ summary: "Render a narrative draft", body: NarrativePreviewBody }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    const b = parse(NarrativePreviewBody, req.body);
    return ws.previewNarrative(a, req.params.metricId, b.fields, b.fact_metrics);
  });

  app.put<MetricParams>("/cycles/:cycleId/metrics/:metricId/assign", docs({ summary: "Assign the metric to a member (or null)", body: AssignBody }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    const b = parse(AssignBody, req.body);
    await ws.assign(a, req.params.metricId, b.user_id);
    return { ok: true };
  });

  app.post<MetricParams>(
    "/cycles/:cycleId/metrics/:metricId/evidence",
    {
      ...docs({
        summary: "Upload an evidence file",
        description: "PDF, JPG, PNG, XLSX or DOCX. Send `evidence_key` before the file field. 413 when the workspace's storage quota is used up.",
        upload: { fields: { evidence_key: "Which required document this file is" } },
      }),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
      const file = await req.file();
      if (!file) throw badRequest("Attach a file");
      const key = (file.fields.evidence_key as { value?: string } | undefined)?.value;
      if (!key) throw badRequest("evidence_key is required (send it before the file field)");
      const matches = Object.hasOwn(ALLOWED_UPLOADS, file.mimetype) ? ALLOWED_UPLOADS[file.mimetype] : undefined;
      if (!matches) throw badRequest("Allowed files: PDF, JPG, PNG, XLSX, DOCX");
      const body = await file.toBuffer();
      if (file.file.truncated) throw badRequest(`File is larger than ${cfg.maxUploadBytes / 1024 / 1024} MB`);
      if (!matches(body)) throw badRequest(`File is not a valid ${TYPE_NAMES[file.mimetype] ?? (file.mimetype.includes("sheet") ? "XLSX" : "DOCX")} file`);
      return ws.addEvidence(a, req.params.metricId, key, { filename: file.filename, contentType: file.mimetype, body });
    },
  );

  app.get<{ Params: { cycleId: string; evidenceId: string } }>("/cycles/:cycleId/evidence/:evidenceId", docs({ summary: "Download an evidence file" }), async (req, reply) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    const f = await ws.getEvidence(a, req.params.evidenceId);
    return sendFile(reply, f.body, f.filename, f.content_type, f.content_type === "application/pdf" || f.content_type.startsWith("image/"));
  });

  app.delete<{ Params: { cycleId: string; metricId: string; evidenceId: string } }>(
    "/cycles/:cycleId/metrics/:metricId/evidence/:evidenceId",
    docs({ summary: "Delete an evidence file" }),
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "dept_editor");
      return ws.deleteEvidence(a, req.params.metricId, req.params.evidenceId);
    },
  );
};
