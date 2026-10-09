// One report (cycle) as a whole: dashboard, settings, extended profile, insights, the data
// workbooks, carry-forward and filling an SSR from AQARs.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { MergePlan } from "../domain/aqar-merge.js";
import { docs, tagRoutes } from "../http/docs.js";
import { XLSX, parse, requireUser, sendFile } from "../http/helpers.js";
import { badRequest } from "../services/errors.js";
import { parseWorkbook, workbookTemplate } from "../services/excel.js";
import { naacTemplateWorkbook, parseNaacWorkbook } from "../services/naac-template.js";
import { ReportCollegeFields, type CycleParams, type RouteDeps } from "./shared.js";

type ImportQuery = { Querystring: { commit?: string; mode?: string } };

const UpdateCycleBody = z.object({ label: z.string().max(200).optional(), ...ReportCollegeFields });
const InputsBody = z.array(z.object({ key: z.string(), year: z.string().optional(), value: z.number().nullable() })).max(500);
// Documentation only: the import handlers read these two query values directly.
const WorkbookImportQuery = z.object({
  commit: z.enum(["true", "false"]).optional().describe("true saves; anything else only checks and previews"),
  mode: z.enum(["replace", "append"]).optional().describe("replace (default) or append"),
});
const workbookImportDocs = (summary: string) =>
  docs({ summary, description: "Every sheet is checked first; saving is all or nothing.", querystring: WorkbookImportQuery, upload: {} });

/** The plan without the copied row contents, which the preview does not need to show. */
function summarisePlan(p: MergePlan) {
  return {
    sources: p.sources,
    years_without_aqar: p.yearsWithoutAqar,
    rows: p.rows.map((r) => ({ metric_id: r.metricId, add: r.add.length, duplicates: r.duplicates })),
    inputs: p.inputs.length,
    answers: p.answers.map((x) => ({ metric_id: x.metricId, from: x.fromLabel })),
  };
}

export const cycleRoutes: FastifyPluginAsync<RouteDeps> = async (app, { cfg, frameworks, ws }) => {
  tagRoutes(app, "Reports");

  app.get<CycleParams>("/cycles/:cycleId", docs({ summary: "Report dashboard and extended-profile inputs" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return { ...(await ws.dashboard(a)), inputs: await ws.getInputs(a) };
  });

  app.patch<CycleParams>("/cycles/:cycleId", docs({ summary: "Update a report's name and college details", body: UpdateCycleBody }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    return ws.updateCycle(a, parse(UpdateCycleBody, req.body));
  });

  app.delete<CycleParams>("/cycles/:cycleId", docs({ summary: "Delete a report" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    await ws.deleteCycle(a);
    return { ok: true };
  });

  app.put<CycleParams>("/cycles/:cycleId/inputs", docs({ summary: "Set extended-profile inputs", body: InputsBody }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
    const b = parse(InputsBody, req.body);
    await ws.setInputs(a, b);
    return ws.getInputs(a);
  });

  app.get<CycleParams>("/cycles/:cycleId/fill-from-aqars", docs({ summary: "Preview filling an SSR from the college's AQARs" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    return summarisePlan(await ws.planSsrFromAqars(a));
  });

  app.post<CycleParams>("/cycles/:cycleId/fill-from-aqars", docs({ summary: "Fill an SSR from the college's AQARs (never overwrites)" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    return summarisePlan(await ws.fillSsrFromAqars(a));
  });

  app.post<CycleParams>("/cycles/:cycleId/carry-forward", docs({ summary: "Copy narratives, answers and inputs from the previous report" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    return ws.carryForward(a);
  });

  app.get<CycleParams>("/cycles/:cycleId/trends", docs({ summary: "Year-over-year trends across the college's AQARs" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return ws.trends(a);
  });

  app.get<CycleParams>("/cycles/:cycleId/cgpa", docs({ summary: "Estimated CGPA range with breakdown" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return ws.cgpa(a);
  });

  app.get<CycleParams>("/cycles/:cycleId/review-checklist", docs({ summary: "Rule-based review checklist" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    return ws.reviewChecklist(a);
  });

  app.get<CycleParams>("/cycles/:cycleId/workbook.xlsx", docs({ summary: "Download the data workbook (.xlsx)" }), async (req, reply) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    const fw = frameworks.get(a.cycle.framework_id);
    const buf = await workbookTemplate(fw, a.cycle.years, await ws.rowsByMetric(a), await ws.getInputs(a));
    const name = `${a.cycle.college_name} - ${a.cycle.label} - data workbook.xlsx`;
    return sendFile(reply, buf, name, XLSX);
  });

  app.post<CycleParams & ImportQuery>(
    "/cycles/:cycleId/workbook/import",
    { ...workbookImportDocs("Upload the data workbook"), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
      const file = await req.file();
      if (!file) throw badRequest("Attach the filled .xlsx workbook");
      const body = await file.toBuffer();
      if (file.file.truncated) throw badRequest(`File is larger than ${cfg.maxUploadBytes / 1024 / 1024} MB`);
      const parsed = await parseWorkbook(frameworks.get(a.cycle.framework_id), a.cycle.years, body);
      return ws.importWorkbook(a, parsed, { commit: req.query.commit === "true", mode: req.query.mode === "append" ? "append" : "replace" });
    },
  );

  // NAAC's own data-template workbook layout (frameworks whose metrics carry a naac_sheet).
  app.get<CycleParams>("/cycles/:cycleId/naac-workbook.xlsx", docs({ summary: "Download data in NAAC's data-template layout (.xlsx)" }), async (req, reply) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId);
    const fw = frameworks.get(a.cycle.framework_id);
    const buf = await naacTemplateWorkbook(fw, a.cycle.years, await ws.rowsByMetric(a), { college: a.cycle.college_name, report: a.cycle.label });
    return sendFile(reply, buf, `${a.cycle.college_name} - ${a.cycle.label} - NAAC data templates.xlsx`, XLSX);
  });

  app.post<CycleParams & ImportQuery>(
    "/cycles/:cycleId/naac-workbook/import",
    { ...workbookImportDocs("Upload a workbook in NAAC's data-template layout"), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
      const file = await req.file();
      if (!file) throw badRequest("Attach the filled .xlsx workbook");
      const body = await file.toBuffer();
      if (file.file.truncated) throw badRequest(`File is larger than ${cfg.maxUploadBytes / 1024 / 1024} MB`);
      const parsed = await parseNaacWorkbook(frameworks.get(a.cycle.framework_id), a.cycle.years, body);
      return ws.importWorkbook(a, parsed, { commit: req.query.commit === "true", mode: req.query.mode === "append" ? "append" : "replace" });
    },
  );
};
