// The access gate for college data, and the audit log every change is written to.
import type { Db } from "../../db/client.js";
import type { Role } from "../auth.js";
import { forbidden, notFound } from "../errors.js";
import type { Access, CycleAccess, CycleRow } from "./model.js";

// editor: someone a single report was shared with; may change all of that report's data, but
// not its settings, sharing, or anything that reads the owner's other reports.
const ROLE_RANK: Record<Role, number> = { viewer: 0, dept_editor: 1, editor: 2, iqac_admin: 3 };
export const canEditData = (role: Role) => role === "iqac_admin" || role === "editor";

export class AccessGate {
  constructor(private readonly db: Db) {}

  async collegeAccess(userId: string, collegeId: string, min: Role = "viewer"): Promise<Access> {
    const m = (
      await this.db.query<{ role: Role }>("SELECT role FROM membership WHERE user_id = $1 AND college_id = $2", [userId, collegeId])
    ).rows[0];
    if (!m) throw notFound("College not found");
    if (ROLE_RANK[m.role] < ROLE_RANK[min]) throw forbidden();
    return { userId, collegeId, role: m.role };
  }

  /**
   * The single access gate for everything inside a report. Access comes from membership of the
   * report's workspace, or from a share of this one report; the stronger of the two wins.
   */
  async cycleAccess(userId: string, cycleId: string, min: Role = "viewer"): Promise<CycleAccess> {
    const rows = (
      await this.db.query<CycleRow & { role: Role }>(
        `SELECT c.*, m.role FROM cycle c JOIN membership m ON m.college_id = c.college_id AND m.user_id = $1 WHERE c.id = $2
         UNION ALL
         SELECT c.*, s.role FROM cycle c JOIN report_share s ON s.cycle_id = c.id AND s.user_id = $1 WHERE c.id = $2`,
        [userId, cycleId],
      )
    ).rows;
    // Same response for "does not exist" and "not yours".
    if (!rows.length) throw notFound("Cycle not found");
    const best = rows.reduce((x, y) => (ROLE_RANK[y.role] > ROLE_RANK[x.role] ? y : x));
    if (ROLE_RANK[best.role] < ROLE_RANK[min]) throw forbidden();
    const { role, ...cycle } = best;
    return { userId, collegeId: cycle.college_id, role, cycle };
  }

  /** Editors and the owner may change every metric; dept_editor only metrics assigned to them. */
  async canEditEntry(a: CycleAccess, entryId: string): Promise<void> {
    if (canEditData(a.role)) return;
    if (a.role === "viewer") throw forbidden("Viewers cannot change data");
    const r = (
      await this.db.query<{ assigned_to: string | null }>("SELECT assigned_to FROM metric_entry WHERE id = $1 AND college_id = $2", [
        entryId,
        a.collegeId,
      ])
    ).rows[0];
    if (!r || r.assigned_to !== a.userId) throw forbidden("This metric is not assigned to you");
  }

  async audit(a: Access, action: string, target: string, detail?: unknown) {
    await this.db.query("INSERT INTO audit_log (college_id, user_id, action, target, detail) VALUES ($1, $2, $3, $4, $5::jsonb)", [
      a.collegeId,
      a.userId,
      action,
      target,
      detail === undefined ? null : JSON.stringify(detail),
    ]);
  }

  async auditLog(a: Access, limit = 100) {
    return (
      await this.db.query(
        "SELECT l.action, l.target, l.detail, l.at, u.email FROM audit_log l LEFT JOIN app_user u ON u.id = l.user_id WHERE l.college_id = $1 ORDER BY l.at DESC LIMIT $2",
        [a.collegeId, Math.min(limit, 500)],
      )
    ).rows;
  }
}
