// Report exports. All formats accept the same selection: ?criteria=3,5&metrics=5.2.1&status=partial,empty
import archiver from "archiver";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { docs, tagRoutes } from "../http/docs.js";
import { DOCX, XLSX, requireUser, sendFile } from "../http/helpers.js";
import { exportDocx } from "../services/docx-report.js";
import { badRequest } from "../services/errors.js";
import { writeEvidenceZip } from "../services/evidence-zip.js";
import { exportWorkbook } from "../services/excel.js";
import { exportPdf } from "../services/pdf-report.js";
import { buildReport, parseSelection, reportFileName } from "../services/report.js";
import type { RouteDeps } from "./shared.js";

type ExportParams = { Params: { cycleId: string }; Querystring: Record<string, string> };
const exportLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
// Documentation only: parseSelection reads these.
const SelectionQuery = z.object({
  criteria: z.string().optional().describe("Comma-separated criterion numbers, e.g. 3,5"),
  metrics: z.string().optional().describe("Comma-separated metric IDs, e.g. 5.2.1"),
  status: z.string().optional().describe("Comma-separated statuses, e.g. partial,empty"),
});
const exportDocs = (summary: string) => ({ ...docs({ summary, querystring: SelectionQuery }), ...exportLimit });

export const exportRoutes: FastifyPluginAsync<RouteDeps> = async (app, { cfg, db, frameworks, files, ws }) => {
  tagRoutes(app, "Exports");

  const report = async (req: FastifyRequest<ExportParams>) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return { a, r: await buildReport(db, ws, frameworks.get(a.cycle.framework_id), a, parseSelection(req.query), cfg.publicUrl) };
  };

  app.get<ExportParams>("/cycles/:cycleId/export.xlsx", exportDocs("Export to Excel"), async (req, reply) => {
    const { r } = await report(req);
    return sendFile(reply, await exportWorkbook(r), reportFileName(r, "xlsx"), XLSX);
  });

  app.get<ExportParams>("/cycles/:cycleId/export.docx", exportDocs("Export to Word"), async (req, reply) => {
    const { r } = await report(req);
    return sendFile(reply, await exportDocx(r), reportFileName(r, "docx"), DOCX);
  });

  app.get<ExportParams>("/cycles/:cycleId/export.pdf", exportDocs("Export to PDF"), async (req, reply) => {
    const { r } = await report(req);
    return sendFile(reply, await exportPdf(r), reportFileName(r, "pdf"), "application/pdf");
  });

  app.get<ExportParams>("/cycles/:cycleId/evidence.zip", exportDocs("Download evidence files as a ZIP"), async (req, reply) => {
    const { r } = await report(req);
    if (!r.criteria.some((c) => c.metrics.some((x) => x.evidence.length))) throw badRequest("No evidence files uploaded for this selection");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("warning", (err) => req.log.warn(err));
    archive.on("error", (err) => req.log.error(err));
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${reportFileName(r, "zip").replace(/\.zip$/, " - evidence.zip")}"`)
      .header("X-Content-Type-Options", "nosniff");
    // Files stream into the response as they are read; a failure mid-way aborts the download.
    writeEvidenceZip(r, files, archive).catch((err) => {
      req.log.error(err);
      archive.abort();
    });
    return reply.send(archive);
  });
};
