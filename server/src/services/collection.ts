// Collection links: a department (no account) submits rows for one metric of one report through
// a secret link. Submissions are held for review; only the owner or an editor can accept them.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { rowColumns, type MetricDef } from "../domain/framework.js";
import type { Row } from "../domain/formula.js";
import { validateRows } from "../domain/validation.js";
import { AppError, badRequest, forbidden, notFound } from "./errors.js";
import type { FrameworkRegistry } from "./frameworks.js";
import type { CycleAccess, CycleRow, Workspace } from "./workspace.js";

export const MAX_SUBMISSION_ROWS = 500;
export const DEFAULT_LINK_DAYS = 14;
export const MAX_LINK_DAYS = 60;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export interface LinkInfo {
  id: string;
  metric_id: string;
  label: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  max_submissions: number;
  submissions: number;
  pending: number;
}

export interface SubmissionView {
  id: string;
  link_id: string;
  link_label: string;
  metric_id: string;
  submitter_name: string;
  note: string | null;
  rows: Row[];
  row_count: number;
  status: "pending" | "accepting" | "accepted" | "rejected";
  created_at: string;
}

/** What someone holding the link may see: the metric's form, never existing data. */
export interface PublicLink {
  college_name: string;
  report: string;
  label: string;
  expires_at: string;
  years: string[];
  metric: { id: string; title: string; explain: string };
  columns: ReturnType<typeof rowColumns>;
  submissions_left: number;
}

const canManage = (a: CycleAccess) => a.role === "iqac_admin";
const canReview = (a: CycleAccess) => a.role === "iqac_admin" || a.role === "editor";

export class Collection {
  constructor(
    private readonly db: Db,
    private readonly frameworks: FrameworkRegistry,
    private readonly ws: Workspace,
  ) {}

  private dataMetric(a: CycleAccess, metricId: string): MetricDef {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    if (m.type !== "quantitative" || !rowColumns(m).length) throw badRequest("Collection links are for metrics with a data table");
    return m;
  }

  /** Returns the secret token once; only its hash is stored. */
  async createLink(a: CycleAccess, metricId: string, label: string, days = DEFAULT_LINK_DAYS): Promise<{ link: LinkInfo; token: string }> {
    if (!canManage(a)) throw forbidden("Only the report owner can create collection links");
    this.dataMetric(a, metricId);
    if (!Number.isInteger(days) || days < 1 || days > MAX_LINK_DAYS) throw badRequest(`Days must be between 1 and ${MAX_LINK_DAYS}`);
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO collection_link (id, token_hash, cycle_id, college_id, metric_id, label, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8))`,
      [id, hashToken(token), a.cycle.id, a.collegeId, metricId, label.trim().slice(0, 120) || "Collection link", a.userId, days],
    );
    const link = (await this.listLinks(a)).find((l) => l.id === id)!;
    return { link, token };
  }

  async listLinks(a: CycleAccess): Promise<LinkInfo[]> {
    if (!canReview(a)) throw forbidden();
    return (
      await this.db.query<LinkInfo>(
        `SELECT l.id, l.metric_id, l.label, l.created_at, l.expires_at, l.revoked_at, l.max_submissions,
                count(s.id)::int AS submissions, count(s.id) FILTER (WHERE s.status = 'pending')::int AS pending
         FROM collection_link l LEFT JOIN collection_submission s ON s.link_id = l.id
         WHERE l.cycle_id = $1 AND l.college_id = $2 GROUP BY l.id ORDER BY l.created_at DESC`,
        [a.cycle.id, a.collegeId],
      )
    ).rows;
  }

  async revokeLink(a: CycleAccess, linkId: string): Promise<void> {
    if (!canManage(a)) throw forbidden("Only the report owner can revoke collection links");
    const r = await this.db.query("UPDATE collection_link SET revoked_at = now() WHERE id = $1 AND cycle_id = $2 AND revoked_at IS NULL RETURNING id", [
      linkId,
      a.cycle.id,
    ]);
    if (!r.rows.length) throw notFound("Link not found or already revoked");
  }

  /** Every invalid, expired or revoked token gets the same answer, so tokens cannot be probed. */
  private async resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("This link is not valid any more");
    const r = (
      await this.db.query<{ id: string; label: string; metric_id: string; expires_at: string; max_submissions: number; used: number } & { cycle: CycleRow }>(
        `SELECT l.id, l.label, l.metric_id, l.expires_at, l.max_submissions,
                (SELECT count(*)::int FROM collection_submission s WHERE s.link_id = l.id) AS used, row_to_json(c.*) AS cycle
         FROM collection_link l JOIN cycle c ON c.id = l.cycle_id
         WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now()`,
        [hashToken(token)],
      )
    ).rows[0];
    if (!r) throw notFound("This link is not valid any more");
    const m = this.frameworks.metric(r.cycle.framework_id, r.metric_id);
    return { ...r, m };
  }

  async publicInfo(token: string): Promise<PublicLink> {
    const r = await this.resolve(token);
    return {
      college_name: r.cycle.college_name,
      report: r.cycle.label,
      label: r.label,
      expires_at: r.expires_at,
      years: r.cycle.years,
      metric: { id: r.m.id, title: r.m.title, explain: r.m.explain },
      columns: rowColumns(r.m),
      submissions_left: Math.max(0, r.max_submissions - r.used),
    };
  }

  async templateFor(token: string) {
    const r = await this.resolve(token);
    return { m: r.m, years: r.cycle.years as string[] };
  }

  /** Validates (types, years, duplicates within the submission) and queues the rows for review. */
  async submit(token: string, input: { name: string; note?: string; rows: Row[]; rowNumbers?: number[] }): Promise<{ id: string; rows: number }> {
    const r = await this.resolve(token);
    const name = input.name.trim().slice(0, 120);
    if (!name) throw badRequest("Enter your name or department so the reviewer knows who sent this");
    if (!input.rows.length) throw badRequest("Add at least one row");
    if (input.rows.length > MAX_SUBMISSION_ROWS) throw badRequest(`At most ${MAX_SUBMISSION_ROWS} rows per submission`);
    const full = () => new AppError(429, "link_full", "This link has received its maximum number of submissions. Ask for a new link.");
    if (r.used >= r.max_submissions) throw full();
    const v = validateRows(rowColumns(r.m), input.rows, { years: r.cycle.years, unique: r.m.template?.unique, rowNumbers: input.rowNumbers });
    if (v.errors.length) throw new AppError(422, "validation_failed", "Some rows are not valid", v.errors);
    const id = randomUUID();
    // Count and insert under a lock on the link row, so simultaneous submissions cannot all see
    // room for one more and together go past max_submissions.
    await this.db.tx(async (t) => {
      const link = (
        await t.query<{ max_submissions: number; used: number }>(
          `SELECT l.max_submissions, (SELECT count(*)::int FROM collection_submission s WHERE s.link_id = l.id) AS used
           FROM collection_link l WHERE l.id = $1 AND l.revoked_at IS NULL AND l.expires_at > now() FOR UPDATE`,
          [r.id],
        )
      ).rows[0];
      if (!link) throw notFound("This link is not valid any more");
      if (link.used >= link.max_submissions) throw full();
      await t.query(
        `INSERT INTO collection_submission (id, link_id, cycle_id, college_id, metric_id, submitter_name, note, rows, row_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [id, r.id, r.cycle.id, r.cycle.college_id, r.m.id, name, input.note?.trim().slice(0, 1000) || null, JSON.stringify(v.rows), v.rows.length],
      );
    });
    return { id, rows: v.rows.length };
  }

  async listSubmissions(a: CycleAccess, status?: SubmissionView["status"]): Promise<SubmissionView[]> {
    if (!canReview(a)) throw forbidden();
    return (
      await this.db.query<SubmissionView>(
        `SELECT s.id, s.link_id, l.label AS link_label, s.metric_id, s.submitter_name, s.note, s.rows, s.row_count, s.status, s.created_at
         FROM collection_submission s JOIN collection_link l ON l.id = s.link_id
         WHERE s.cycle_id = $1 AND s.college_id = $2 AND ($3::text IS NULL OR s.status = $3) ORDER BY s.created_at`,
        [a.cycle.id, a.collegeId, status ?? null],
      )
    ).rows;
  }

  /**
   * Adds the rows to the report through the normal row path, so they are re-validated against
   * the data as it is now (duplicates, years). Claiming the submission first means two
   * reviewers clicking Accept at once cannot add the rows twice.
   */
  async accept(a: CycleAccess, submissionId: string) {
    if (!canReview(a)) throw forbidden();
    const claimed = (
      await this.db.query<{ metric_id: string; rows: Row[] }>(
        "UPDATE collection_submission SET status = 'accepting' WHERE id = $1 AND cycle_id = $2 AND status = 'pending' RETURNING metric_id, rows",
        [submissionId, a.cycle.id],
      )
    ).rows[0];
    if (!claimed) throw notFound("Submission not found or already reviewed");
    try {
      const result = await this.ws.addRows(a, claimed.metric_id, claimed.rows);
      await this.db.query("UPDATE collection_submission SET status = 'accepted', reviewed_by = $1, reviewed_at = now() WHERE id = $2", [a.userId, submissionId]);
      return result;
    } catch (e) {
      await this.db.query("UPDATE collection_submission SET status = 'pending' WHERE id = $1", [submissionId]);
      throw e;
    }
  }

  async reject(a: CycleAccess, submissionId: string): Promise<void> {
    if (!canReview(a)) throw forbidden();
    const r = await this.db.query(
      "UPDATE collection_submission SET status = 'rejected', reviewed_by = $1, reviewed_at = now() WHERE id = $2 AND cycle_id = $3 AND status = 'pending' RETURNING id",
      [a.userId, submissionId, a.cycle.id],
    );
    if (!r.rows.length) throw notFound("Submission not found or already reviewed");
  }
}
