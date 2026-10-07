// A report's data: extended-profile inputs, metric rows (typed, imported per metric or as a
// whole workbook), assignment of metrics to people, and one metric's full detail.
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/client.js";
import type { MetricDef } from "../../domain/framework.js";
import { rowColumns } from "../../domain/framework.js";
import type { Row } from "../../domain/formula.js";
import { checklist, compute, status } from "../../domain/metric-state.js";
import { wordCount } from "../../domain/narrative.js";
import { normalizeYear, validateRows, type RowError } from "../../domain/validation.js";
import { AppError, badRequest, forbidden, notFound } from "../errors.js";
import type { ParsedWorkbook } from "../excel.js";
import type { FrameworkRegistry } from "../frameworks.js";
import { canEditData, type AccessGate } from "./access.js";
import type { Entries } from "./entries.js";
import type { CycleAccess, InputValue, WorkbookReport, WorkspaceContext } from "./model.js";

/** A metric calculated from another metric's records takes no rows of its own. */
function assertOwnRows(m: MetricDef): void {
  if (m.data_from) throw badRequest(`${m.id} is calculated from the records entered under ${m.data_from}; add rows there`);
}

export class MetricData {
  private readonly db: Db;
  private readonly frameworks: FrameworkRegistry;
  private readonly access: AccessGate;
  private readonly entries: Entries;

  constructor(ctx: WorkspaceContext) {
    this.db = ctx.db;
    this.frameworks = ctx.frameworks;
    this.access = ctx.access;
    this.entries = ctx.entries;
  }

  // ---------------------------------------------------------------- extended profile

  async setInputs(a: CycleAccess, values: InputValue[]) {
    if (!canEditData(a.role)) throw forbidden();
    await this.db.tx((t) => this.writeInputs(t, a, values));
    await this.access.audit(a, "inputs.set", a.cycle.id, values);
  }

  /** Validates and writes extended-profile values inside the caller's transaction. */
  private async writeInputs(t: Db, a: CycleAccess, values: InputValue[]): Promise<void> {
    const defs = new Map(this.frameworks.get(a.cycle.framework_id).inputs.map((i) => [i.key, i]));
    for (const v of values) {
      const def = defs.get(v.key);
      if (!def) throw badRequest(`Unknown extended-profile field ${v.key}`);
      const year = def.per_year ? normalizeYear(v.year) : "";
      if (def.per_year && (!year || !a.cycle.years.includes(year))) throw badRequest(`${def.label}: year must be one of ${a.cycle.years.join(", ")}`);
      if (v.value === null) {
        await t.query("DELETE FROM cycle_input WHERE cycle_id = $1 AND key = $2 AND year = $3", [a.cycle.id, v.key, year]);
        continue;
      }
      if (!Number.isFinite(v.value) || v.value < 0) throw badRequest(`${def.label} must be a non-negative number`);
      await t.query(
        "INSERT INTO cycle_input (cycle_id, key, year, value) VALUES ($1,$2,$3,$4) ON CONFLICT (cycle_id, key, year) DO UPDATE SET value = EXCLUDED.value",
        [a.cycle.id, v.key, year, v.value],
      );
    }
  }

  // ---------------------------------------------------------------- whole workbook

  /** Current rows of every data metric, keyed by metric ID (for the pre-filled workbook). */
  async rowsByMetric(a: CycleAccess): Promise<Map<string, Row[]>> {
    const rows = (
      await this.db.query<{ metric_id: string; data: Row }>(
        `SELECT e.metric_id, r.data FROM metric_row r JOIN metric_entry e ON e.id = r.entry_id
         WHERE e.cycle_id = $1 AND r.college_id = $2 ORDER BY r.seq`,
        [a.cycle.id, a.collegeId],
      )
    ).rows;
    const out = new Map<string, Row[]>();
    for (const r of rows) (out.get(r.metric_id) ?? out.set(r.metric_id, []).get(r.metric_id)!).push(r.data);
    return out;
  }

  /**
   * Imports a whole workbook. Every sheet is validated first; nothing is written unless all of
   * them are valid, and then everything is written in one transaction. In "replace" mode a sheet
   * with no data rows leaves its metric untouched, so a blank template can never wipe data.
   */
  async importWorkbook(a: CycleAccess, wb: ParsedWorkbook, opts: { commit: boolean; mode: "append" | "replace" }): Promise<WorkbookReport> {
    if (!canEditData(a.role)) throw forbidden("Only the owner or an editor can import a whole workbook");
    const existing = await this.rowsByMetric(a);
    const sheets: WorkbookReport["sheets"] = [];
    const toWrite: { m: MetricDef; rows: Row[] }[] = [];
    for (const s of wb.sheets) {
      const m = this.frameworks.metric(a.cycle.framework_id, s.metricId);
      const current = existing.get(m.id) ?? [];
      const base = { metric_id: m.id, title: m.title, in_file: s.rows.length, existing: current.length };
      if (s.error) {
        sheets.push({ ...base, valid: 0, action: "error", errors: [{ message: s.error }] });
        continue;
      }
      if (!s.rows.length) {
        sheets.push({ ...base, valid: 0, action: "unchanged", errors: [] });
        continue;
      }
      const v = validateRows(rowColumns(m), s.rows, {
        years: a.cycle.years,
        unique: m.template?.unique,
        existing: opts.mode === "append" ? current : [],
        rowNumbers: s.rowNumbers,
      });
      sheets.push({ ...base, valid: v.rows.length, action: opts.mode === "replace" ? "replace" : "add", errors: v.errors });
      if (!v.errors.length) toWrite.push({ m, rows: v.rows });
    }
    const errorCount = sheets.reduce((n, s) => n + s.errors.length, 0) + wb.profileErrors.length;
    const report: WorkbookReport = {
      committed: false,
      mode: opts.mode,
      error_count: errorCount,
      sheets,
      profile: { values: wb.profile.length, errors: wb.profileErrors },
      ignored_sheets: wb.ignored,
    };
    if (!opts.commit || errorCount) return report;

    await this.db.tx(async (t) => {
      await this.writeInputs(t, a, wb.profile);
      for (const { m, rows } of toWrite) {
        const entryId = await this.entries.ensureEntry(a, m.id, t);
        if (opts.mode === "replace") await t.query("DELETE FROM metric_row WHERE entry_id = $1 AND college_id = $2", [entryId, a.collegeId]);
        for (const row of rows) {
          await t.query("INSERT INTO metric_row (id, entry_id, college_id, data, created_by) VALUES ($1,$2,$3,$4::jsonb,$5)", [
            randomUUID(),
            entryId,
            a.collegeId,
            JSON.stringify(row),
            a.userId,
          ]);
        }
      }
    });
    for (const { m } of toWrite) await this.entries.refresh(a, m, await this.entries.ensureEntry(a, m.id));
    await this.access.audit(a, "workbook.import", a.cycle.id, { mode: opts.mode, metrics: toWrite.map((x) => x.m.id), profile_values: wb.profile.length });
    return { ...report, committed: true };
  }

  // ---------------------------------------------------------------- one metric

  async metricDetail(a: CycleAccess, metricId: string) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    const entry = (
      await this.db.query<{ id: string; assigned_to: string | null }>(
        "SELECT id, assigned_to FROM metric_entry WHERE cycle_id = $1 AND metric_id = $2 AND college_id = $3",
        [a.cycle.id, metricId, a.collegeId],
      )
    ).rows[0];
    const s = await this.entries.loadState(a, m, entry?.id ?? null);
    const computed = compute(m, s);
    const st = status(m, s, computed);
    const rows = entry
      ? (
          await this.db.query("SELECT id, data, created_at, updated_at FROM metric_row WHERE entry_id = $1 AND college_id = $2 ORDER BY seq", [
            entry.id,
            a.collegeId,
          ])
        ).rows
      : [];
    const evidence = entry
      ? (
          await this.db.query(
            "SELECT id, evidence_key, filename, content_type, bytes, sha256, created_at FROM evidence WHERE entry_id = $1 AND college_id = $2 ORDER BY created_at",
            [entry.id, a.collegeId],
          )
        ).rows
      : [];
    const fw = this.frameworks.get(a.cycle.framework_id);
    return {
      metric: m,
      columns: rowColumns(m),
      entry_id: entry?.id ?? null,
      assigned_to: entry?.assigned_to ?? null,
      rows,
      narrative: s.narrative,
      narrative_words: wordCount(Object.values(s.narrative).join(" ")),
      evidence,
      computed,
      status: st.status,
      missing: st.missing,
      flags: checklist(fw, m, s, computed),
      previous_value: s.previousValue,
      can_edit: canEditData(a.role) || (a.role === "dept_editor" && entry?.assigned_to === a.userId),
    };
  }

  async addRows(a: CycleAccess, metricId: string, input: Row[], idempotencyKey?: string) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    if (m.type === "qualitative" || m.type === "external") throw badRequest("This metric takes a narrative, not rows");
    assertOwnRows(m);
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    if (idempotencyKey) {
      const prior = await this.db.query<{ id: string }>("SELECT id FROM metric_row WHERE entry_id = $1 AND idempotency_key = $2", [entryId, idempotencyKey]);
      if (prior.rows.length) return { created: [], errors: [] as RowError[], replayed: true, ...(await this.entries.refresh(a, m, entryId)) };
    }
    const existing = (await this.db.query<{ data: Row }>("SELECT data FROM metric_row WHERE entry_id = $1", [entryId])).rows.map((r) => r.data);
    // Checklist, choice and "latest year" metrics keep a single answer row.
    const single = m.type === "checklist" || m.type === "choice" || !!m.template?.single_row;
    const v = validateRows(rowColumns(m), input, { years: a.cycle.years, unique: single ? undefined : m.template?.unique, existing: single ? [] : existing });
    if (v.errors.length) throw new AppError(422, "validation_failed", "Some rows are not valid", v.errors);
    const created: string[] = [];
    await this.db.tx(async (t) => {
      if (single) await t.query("DELETE FROM metric_row WHERE entry_id = $1", [entryId]);
      for (const [i, row] of v.rows.entries()) {
        const id = randomUUID();
        // The idempotency key is attached to the first row of the request; a retry finds it and does nothing.
        await t.query("INSERT INTO metric_row (id, entry_id, college_id, data, idempotency_key, created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6)", [
          id,
          entryId,
          a.collegeId,
          JSON.stringify(row),
          i === 0 ? (idempotencyKey ?? null) : null,
          a.userId,
        ]);
        created.push(id);
      }
    });
    await this.access.audit(a, "rows.add", `${a.cycle.id}/${metricId}`, { count: created.length });
    return { created, errors: [] as RowError[], replayed: false, ...(await this.entries.refresh(a, m, entryId)) };
  }

  async updateRow(a: CycleAccess, metricId: string, rowId: string, data: Row) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    assertOwnRows(m);
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    const others = (await this.db.query<{ data: Row }>("SELECT data FROM metric_row WHERE entry_id = $1 AND id <> $2", [entryId, rowId])).rows.map((r) => r.data);
    const v = validateRows(rowColumns(m), [data], { years: a.cycle.years, unique: m.template?.unique, existing: others });
    if (v.errors.length) throw new AppError(422, "validation_failed", "Row is not valid", v.errors);
    const r = await this.db.query("UPDATE metric_row SET data = $1::jsonb, updated_at = now() WHERE id = $2 AND entry_id = $3 AND college_id = $4 RETURNING id", [
      JSON.stringify(v.rows[0]),
      rowId,
      entryId,
      a.collegeId,
    ]);
    if (!r.rows.length) throw notFound("Row not found");
    await this.access.audit(a, "rows.update", rowId, v.rows[0]);
    return this.entries.refresh(a, m, entryId);
  }

  async deleteRow(a: CycleAccess, metricId: string, rowId: string) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    const r = await this.db.query("DELETE FROM metric_row WHERE id = $1 AND entry_id = $2 AND college_id = $3 RETURNING data", [rowId, entryId, a.collegeId]);
    if (!r.rows.length) throw notFound("Row not found");
    await this.access.audit(a, "rows.delete", rowId, r.rows[0]);
    return this.entries.refresh(a, m, entryId);
  }

  /** Excel import: validate everything first; commit only when asked and only if there are no errors. */
  async importRows(a: CycleAccess, metricId: string, rows: Row[], opts: { commit: boolean; mode: "append" | "replace"; rowNumbers?: number[] }) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    if (m.type !== "quantitative") throw badRequest("Excel import is for data-table metrics");
    assertOwnRows(m);
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    const existing =
      opts.mode === "append" ? (await this.db.query<{ data: Row }>("SELECT data FROM metric_row WHERE entry_id = $1", [entryId])).rows.map((r) => r.data) : [];
    const v = validateRows(rowColumns(m), rows, { years: a.cycle.years, unique: m.template?.unique, existing, firstRowNumber: 2, rowNumbers: opts.rowNumbers });
    const report = { total: rows.length, valid: v.rows.length, errors: v.errors, committed: false };
    if (!opts.commit || v.errors.length) return report;
    await this.db.tx(async (t) => {
      if (opts.mode === "replace") await t.query("DELETE FROM metric_row WHERE entry_id = $1 AND college_id = $2", [entryId, a.collegeId]);
      for (const row of v.rows) {
        await t.query("INSERT INTO metric_row (id, entry_id, college_id, data, created_by) VALUES ($1,$2,$3,$4::jsonb,$5)", [
          randomUUID(),
          entryId,
          a.collegeId,
          JSON.stringify(row),
          a.userId,
        ]);
      }
    });
    await this.access.audit(a, "rows.import", `${a.cycle.id}/${metricId}`, { mode: opts.mode, rows: v.rows.length });
    await this.entries.refresh(a, m, entryId);
    return { ...report, committed: true };
  }

  // ---------------------------------------------------------------- assignment

  async assign(a: CycleAccess, metricId: string, userId: string | null) {
    if (a.role !== "iqac_admin") throw forbidden();
    if (userId) {
      const ok = await this.db.query("SELECT 1 FROM membership WHERE user_id = $1 AND college_id = $2", [userId, a.collegeId]);
      if (!ok.rows.length) throw badRequest("That user is not a member of this college");
    }
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.db.query("UPDATE metric_entry SET assigned_to = $1 WHERE id = $2 AND college_id = $3", [userId, entryId, a.collegeId]);
    await this.access.audit(a, "metric.assign", `${a.cycle.id}/${metricId}`, { userId });
  }
}
