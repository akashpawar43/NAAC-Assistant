// A college workspace: its members, its reports (cycles) and its audit log.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { docs, tagRoutes } from "../http/docs.js";
import { parse, requireUser } from "../http/helpers.js";
import { upsertUser } from "../services/auth.js";
import { ReportCollegeFields, type RouteDeps } from "./shared.js";

type CollegeParams = { Params: { collegeId: string } };

const AddMemberBody = z.object({
  email: z.string(),
  name: z.string().max(200).optional(),
  role: z.enum(["iqac_admin", "dept_editor", "viewer"]),
  department: z.string().max(200).nullish(),
});

const CreateCycleBody = z.object({
  kind: z.enum(["AQAR", "SSR"]),
  label: z.string().min(1).max(200),
  last_year: z.string(),
  framework_id: z.string(),
  previous_cycle_id: z.string().nullish(),
  ...ReportCollegeFields,
  college_name: z.string().min(1).max(300),
});

export const collegeRoutes: FastifyPluginAsync<RouteDeps> = async (app, { db, ws }) => {
  tagRoutes(app, "Colleges");

  app.get<CollegeParams>("/colleges/:collegeId/members", docs({ summary: "List workspace members" }), async (req) => {
    const a = await ws.collegeAccess(requireUser(req).id, req.params.collegeId);
    return ws.listMembers(a);
  });

  app.post<CollegeParams>("/colleges/:collegeId/members", docs({ summary: "Add a workspace member", body: AddMemberBody }), async (req) => {
    const a = await ws.collegeAccess(requireUser(req).id, req.params.collegeId, "iqac_admin");
    const b = parse(AddMemberBody, req.body);
    const uid = await upsertUser(db, b.email, b.name);
    await ws.addMember(a, uid, b.role, b.department ?? null);
    return { ok: true, user_id: uid };
  });

  app.delete<{ Params: { collegeId: string; userId: string } }>(
    "/colleges/:collegeId/members/:userId",
    docs({ summary: "Remove a workspace member", description: "Access ends immediately. The workspace owner cannot be removed." }),
    async (req) => {
      const a = await ws.collegeAccess(requireUser(req).id, req.params.collegeId, "iqac_admin");
      await ws.removeMember(a, req.params.userId);
      return { ok: true };
    },
  );

  app.get<CollegeParams>("/colleges/:collegeId/cycles", docs({ summary: "List reports in a workspace" }), async (req) => {
    const a = await ws.collegeAccess(requireUser(req).id, req.params.collegeId);
    return ws.listCycles(a);
  });

  app.post<CollegeParams>(
    "/colleges/:collegeId/cycles",
    docs({ summary: "Create a report", description: "AQAR covers one academic year (last_year); SSR covers five ending at last_year.", body: CreateCycleBody }),
    async (req) => {
      const a = await ws.collegeAccess(requireUser(req).id, req.params.collegeId, "iqac_admin");
      const b = parse(CreateCycleBody, req.body);
      return ws.createCycle(a, b);
    },
  );

  app.get<CollegeParams>("/colleges/:collegeId/audit-log", docs({ summary: "Workspace audit log" }), async (req) => {
    const a = await ws.collegeAccess(requireUser(req).id, req.params.collegeId, "iqac_admin");
    return ws.auditLog(a);
  });
};
