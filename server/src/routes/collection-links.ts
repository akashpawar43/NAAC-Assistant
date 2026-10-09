// Collection links: the owner side (create, list, close, review submissions) and the public side,
// where a department fills one metric without an account.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { docs, tagRoutes } from "../http/docs.js";
import { XLSX, parse, requireUser, sendFile } from "../http/helpers.js";
import { badRequest } from "../services/errors.js";
import { metricTemplate, parseImport } from "../services/excel.js";
import type { CycleParams, MetricParams, RouteDeps } from "./shared.js";

type LinkParams = { Params: { cycleId: string; linkId: string } };
type SubmissionParams = { Params: { cycleId: string; submissionId: string } };
type TokenParams = { Params: { token: string } };
const publicLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

const CreateLinkBody = z.object({ label: z.string().max(120).default(""), days: z.number().int().optional() });
const SubmissionStatus = z.enum(["pending", "accepting", "accepted", "rejected"]).optional();
const SubmitBody = z.object({ name: z.string().max(120), note: z.string().max(1000).optional(), rows: z.array(z.record(z.string(), z.unknown())).max(500) });
const UploadQuery = z.object({ name: z.string().max(120).optional().describe("Who is submitting"), note: z.string().max(1000).optional() });

export const collectionLinkRoutes: FastifyPluginAsync<RouteDeps> = async (app, { cfg, ws, collection, appBase }) => {
  tagRoutes(app, "Collection links");

  // ---------------------------------------------------------------- owner side
  app.post<MetricParams>(
    "/cycles/:cycleId/metrics/:metricId/collection-links",
    docs({ summary: "Create a collection link", description: "The full URL is returned only here; only a hash of the token is stored.", body: CreateLinkBody }),
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
      const b = parse(CreateLinkBody, req.body ?? {});
      const { link, token } = await collection.createLink(a, req.params.metricId, b.label, b.days);
      // The only time the full link is available: only a hash of the token is stored.
      return { ...link, url: `${appBase}/collect/${token}` };
    },
  );

  app.get<CycleParams>("/cycles/:cycleId/collection-links", docs({ summary: "List collection links" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
    return collection.listLinks(a);
  });

  app.delete<LinkParams>("/cycles/:cycleId/collection-links/:linkId", docs({ summary: "Close a collection link" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    await collection.revokeLink(a, req.params.linkId);
    return { ok: true };
  });

  app.get<CycleParams & { Querystring: { status?: string } }>(
    "/cycles/:cycleId/submissions",
    docs({ summary: "List submissions", querystring: z.object({ status: SubmissionStatus }) }),
    async (req) => {
      const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
      const status = parse(SubmissionStatus, req.query.status);
      return collection.listSubmissions(a, status);
    },
  );

  app.post<SubmissionParams>("/cycles/:cycleId/submissions/:submissionId/accept", docs({ summary: "Accept a submission into the report" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
    return collection.accept(a, req.params.submissionId);
  });

  app.post<SubmissionParams>("/cycles/:cycleId/submissions/:submissionId/reject", docs({ summary: "Reject a submission" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "editor");
    await collection.reject(a, req.params.submissionId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- public, no account
  app.get<TokenParams>(
    "/collect/:token",
    { ...docs({ summary: "Public: the metric's form for a collection link", isPublic: true }), ...publicLimit },
    async (req) => collection.publicInfo(req.params.token),
  );

  app.get<TokenParams>(
    "/collect/:token/template.xlsx",
    { ...docs({ summary: "Public: download the metric's Excel template", isPublic: true }), ...publicLimit },
    async (req, reply) => {
      const { m, years } = await collection.templateFor(req.params.token);
      return sendFile(reply, await metricTemplate(m, years), `${m.id}_template.xlsx`, XLSX);
    },
  );

  app.post<TokenParams>(
    "/collect/:token/submit",
    { ...docs({ summary: "Public: submit typed rows for review", body: SubmitBody, isPublic: true }), ...publicLimit },
    async (req) => {
      const b = parse(SubmitBody, req.body);
      return collection.submit(req.params.token, b);
    },
  );

  app.post<TokenParams & { Querystring: { name?: string; note?: string } }>(
    "/collect/:token/upload",
    { ...docs({ summary: "Public: submit the filled template for review", querystring: UploadQuery, upload: {}, isPublic: true }), ...publicLimit },
    async (req) => {
      // Validated like every body: a repeated ?name= arrives as an array, not a string.
      const q = parse(UploadQuery, req.query);
      const { m } = await collection.templateFor(req.params.token);
      const file = await req.file();
      if (!file) throw badRequest("Attach the filled .xlsx template");
      const body = await file.toBuffer();
      if (file.file.truncated) throw badRequest(`File is larger than ${cfg.maxUploadBytes / 1024 / 1024} MB`);
      const parsed = await parseImport(m, body);
      return collection.submit(req.params.token, { name: q.name ?? "", note: q.note, ...parsed });
    },
  );
};
