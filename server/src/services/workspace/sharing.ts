// Who else can see college data: workspace members, and shares of one report.
import type { Db } from "../../db/client.js";
import type { Role } from "../auth.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import type { AccessGate } from "./access.js";
import type { Access, CycleAccess, CycleRow, ShareRole, WorkspaceContext } from "./model.js";

export class Sharing {
  private readonly db: Db;
  private readonly access: AccessGate;

  constructor(ctx: WorkspaceContext) {
    this.db = ctx.db;
    this.access = ctx.access;
  }

  async listMembers(a: Access) {
    return (
      await this.db.query(
        "SELECT u.id, u.email, u.name, m.role, m.department FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.college_id = $1 ORDER BY u.email",
        [a.collegeId],
      )
    ).rows;
  }

  /** The workspace owner's own membership is never changed or removed by anyone (no lock-out). */
  private async assertNotOwner(a: Access, userId: string): Promise<void> {
    const owner = (await this.db.query<{ owner_id: string | null }>("SELECT owner_id FROM college WHERE id = $1", [a.collegeId])).rows[0]?.owner_id;
    if (owner && owner === userId) throw forbidden("The workspace owner's access cannot be changed");
  }

  async addMember(a: Access, userId: string, role: Role, department: string | null) {
    if (a.role !== "iqac_admin") throw forbidden();
    await this.assertNotOwner(a, userId);
    await this.db.query(
      `INSERT INTO membership (user_id, college_id, role, department) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, college_id) DO UPDATE SET role = EXCLUDED.role, department = EXCLUDED.department`,
      [userId, a.collegeId, role, department],
    );
    await this.access.audit(a, "member.upsert", userId, { role, department });
  }

  /** Removes someone from the workspace: their access ends with their next request. */
  async removeMember(a: Access, userId: string): Promise<void> {
    if (a.role !== "iqac_admin") throw forbidden();
    await this.assertNotOwner(a, userId);
    await this.db.tx(async (t) => {
      const r = await t.query("DELETE FROM membership WHERE user_id = $1 AND college_id = $2 RETURNING user_id", [userId, a.collegeId]);
      if (!r.rows.length) throw notFound("That person is not a member of this workspace");
      // Assignments are only meaningful for members; leave the metrics unassigned.
      await t.query("UPDATE metric_entry SET assigned_to = NULL WHERE college_id = $1 AND assigned_to = $2", [a.collegeId, userId]);
    });
    await this.access.audit(a, "member.remove", userId);
  }

  async listShares(a: CycleAccess): Promise<{ user_id: string; email: string; role: ShareRole; created_at: string }[]> {
    if (a.role !== "iqac_admin") throw forbidden("Only the owner can see who a report is shared with");
    return (
      await this.db.query<{ user_id: string; email: string; role: ShareRole; created_at: string }>(
        "SELECT s.user_id, u.email, s.role, s.created_at FROM report_share s JOIN app_user u ON u.id = s.user_id WHERE s.cycle_id = $1 ORDER BY u.email",
        [a.cycle.id],
      )
    ).rows;
  }

  /** Adds or changes a share. Returns false when it already existed with the same role (no new notice needed). */
  async shareReport(a: CycleAccess, userId: string, role: ShareRole): Promise<boolean> {
    if (a.role !== "iqac_admin") throw forbidden("Only the owner can share a report");
    if (userId === a.userId) throw badRequest("You already own this report");
    const member = await this.db.query("SELECT 1 FROM membership WHERE user_id = $1 AND college_id = $2", [userId, a.collegeId]);
    if (member.rows.length) throw badRequest("This person already has access to your workspace");
    const r = await this.db.query<{ role: ShareRole }>("SELECT role FROM report_share WHERE cycle_id = $1 AND user_id = $2", [a.cycle.id, userId]);
    await this.db.query(
      `INSERT INTO report_share (cycle_id, user_id, role, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (cycle_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [a.cycle.id, userId, role, a.userId],
    );
    await this.access.audit(a, "report.share", a.cycle.id, { userId, role });
    return r.rows[0]?.role !== role;
  }

  async unshareReport(a: CycleAccess, userId: string): Promise<void> {
    if (a.role !== "iqac_admin") throw forbidden("Only the owner can change sharing");
    const r = await this.db.query("DELETE FROM report_share WHERE cycle_id = $1 AND user_id = $2 RETURNING user_id", [a.cycle.id, userId]);
    if (!r.rows.length) throw notFound("This report is not shared with that person");
    await this.access.audit(a, "report.unshare", a.cycle.id, { userId });
  }

  /** Reports other people shared with this user, with the owner's email. */
  async sharedWithMe(userId: string): Promise<(CycleRow & { access: ShareRole; owner_email: string | null })[]> {
    return (
      await this.db.query<CycleRow & { access: ShareRole; owner_email: string | null }>(
        `SELECT c.*, s.role AS access, u.email AS owner_email FROM report_share s
         JOIN cycle c ON c.id = s.cycle_id JOIN college w ON w.id = c.college_id LEFT JOIN app_user u ON u.id = w.owner_id
         WHERE s.user_id = $1 ORDER BY c.created_at DESC`,
        [userId],
      )
    ).rows;
  }
}
