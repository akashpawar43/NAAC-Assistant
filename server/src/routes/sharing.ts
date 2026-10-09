// Sharing one report with another person by email, and the reports shared with the signed-in user.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { docs, tagRoutes } from "../http/docs.js";
import { parse, requireUser } from "../http/helpers.js";
import { normalizeEmail, upsertUser } from "../services/auth.js";
import { AppError } from "../services/errors.js";
import type { CycleParams, RouteDeps } from "./shared.js";

const ShareBody = z.object({ email: z.string().max(254), role: z.enum(["editor", "viewer"]) });

export const sharingRoutes: FastifyPluginAsync<RouteDeps> = async (app, { cfg, db, mailer, ws, appBase }) => {
  tagRoutes(app, "Sharing");

  app.get("/shared-reports", docs({ summary: "Reports shared with me" }), async (req) => ws.sharedWithMe(requireUser(req).id));

  app.get<CycleParams>("/cycles/:cycleId/shares", docs({ summary: "List who a report is shared with" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    return ws.listShares(a);
  });

  app.post<CycleParams>(
    "/cycles/:cycleId/shares",
    { ...docs({ summary: "Share a report by email", description: "The person gets an email the first time or when their role changes.", body: ShareBody }), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const user = requireUser(req);
      const a = await ws.cycleAccess(user.id, req.params.cycleId, "iqac_admin");
      const b = parse(ShareBody, req.body);
      const email = normalizeEmail(b.email);
      // Each new share emails someone, so one account may only trigger so many notices a day.
      const sent = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'report.share_notice' AND at > now() - interval '1 day'",
        [user.id],
      );
      if (sent.rows[0].n >= cfg.shareEmailsPerDay) {
        throw new AppError(429, "share_limit", `You can share with at most ${cfg.shareEmailsPerDay} people a day. Try again tomorrow.`);
      }
      const changed = await ws.shareReport(a, await upsertUser(db, email), b.role);
      if (changed) {
        // Only fixed text: report and college names are typed by the sharer, and putting them in
        // an email from this server's address would let anyone send their own text to anyone.
        await mailer.send(
          email,
          "A report was shared with you in NAAC Assistant",
          `${user.email} gave you ${b.role === "editor" ? "edit" : "view"} access to a report in NAAC Assistant.\n\n` +
            `Open ${appBase} and sign in with this email address (${email}). It will be under "Shared with me".`,
        );
        await db.query("INSERT INTO audit_log (college_id, user_id, action, target) VALUES ($1, $2, 'report.share_notice', $3)", [a.collegeId, user.id, a.cycle.id]);
      }
      return ws.listShares(a);
    },
  );

  app.delete<{ Params: { cycleId: string; userId: string } }>("/cycles/:cycleId/shares/:userId", docs({ summary: "Stop sharing a report with someone" }), async (req) => {
    const a = await ws.cycleAccess(requireUser(req).id, req.params.cycleId, "iqac_admin");
    await ws.unshareReport(a, req.params.userId);
    return ws.listShares(a);
  });
};
