// Evidence files attached to a metric.
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/client.js";
import type { FileStore } from "../../infra/file-store.js";
import { AppError, badRequest, notFound } from "../errors.js";
import type { FrameworkRegistry } from "../frameworks.js";
import type { AccessGate } from "./access.js";
import type { Entries } from "./entries.js";
import type { CycleAccess, WorkspaceContext } from "./model.js";

export class Evidence {
  private readonly db: Db;
  private readonly frameworks: FrameworkRegistry;
  private readonly files: FileStore;
  private readonly access: AccessGate;
  private readonly entries: Entries;
  private readonly quotaBytes: number;

  constructor(ctx: WorkspaceContext) {
    this.db = ctx.db;
    this.frameworks = ctx.frameworks;
    this.files = ctx.files;
    this.access = ctx.access;
    this.entries = ctx.entries;
    this.quotaBytes = ctx.evidenceQuotaBytes;
  }

  /** Refuses an upload that would take the workspace over its storage quota. */
  private async assertQuota(a: CycleAccess, bytes: number): Promise<void> {
    const used = (await this.db.query<{ used: number }>("SELECT COALESCE(sum(bytes), 0)::bigint AS used FROM evidence WHERE college_id = $1", [a.collegeId])).rows[0].used;
    if (used + bytes > this.quotaBytes) {
      const mb = (n: number) => Math.round(n / 1048576);
      throw new AppError(413, "quota_exceeded", `This workspace has used ${mb(used)} MB of its ${mb(this.quotaBytes)} MB evidence storage. Delete files you no longer need.`);
    }
  }

  async addEvidence(a: CycleAccess, metricId: string, evidenceKey: string, file: { filename: string; contentType: string; body: Buffer }) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    if (!m.evidence.some((e) => e.key === evidenceKey)) throw badRequest(`Unknown evidence type ${evidenceKey} for ${metricId}`);
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    await this.assertQuota(a, file.body.length);
    const stored = await this.files.put(`college_${a.collegeId}`, file.body);
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO evidence (id, entry_id, college_id, evidence_key, file_key, filename, content_type, bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, entryId, a.collegeId, evidenceKey, stored.key, file.filename.slice(0, 255), file.contentType, stored.bytes, stored.sha256, a.userId],
    );
    await this.access.audit(a, "evidence.add", id, { metricId, evidenceKey, filename: file.filename, sha256: stored.sha256 });
    return { id, ...(await this.entries.refresh(a, m, entryId)) };
  }

  async getEvidence(a: CycleAccess, evidenceId: string) {
    const r = (
      await this.db.query<{ file_key: string; filename: string; content_type: string }>(
        "SELECT e.file_key, e.filename, e.content_type FROM evidence e JOIN metric_entry me ON me.id = e.entry_id WHERE e.id = $1 AND e.college_id = $2 AND me.cycle_id = $3",
        [evidenceId, a.collegeId, a.cycle.id],
      )
    ).rows[0];
    if (!r) throw notFound("File not found");
    return { ...r, body: await this.files.get(r.file_key) };
  }

  async deleteEvidence(a: CycleAccess, metricId: string, evidenceId: string) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    const r = await this.db.query<{ file_key: string }>("DELETE FROM evidence WHERE id = $1 AND entry_id = $2 AND college_id = $3 RETURNING file_key", [
      evidenceId,
      entryId,
      a.collegeId,
    ]);
    if (!r.rows.length) throw notFound("File not found");
    await this.files.delete(r.rows[0].file_key);
    await this.access.audit(a, "evidence.delete", evidenceId);
    return this.entries.refresh(a, m, entryId);
  }
}
