// Metric entries: creating them, loading one metric's state, and storing its recomputed value.
// Shared by every service that changes a metric's rows, narrative or evidence.
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/client.js";
import type { MetricDef } from "../../domain/framework.js";
import { dependents, rowSources } from "../../domain/framework.js";
import type { Row } from "../../domain/formula.js";
import { compute, status, type Computed, type EntryState, type Status } from "../../domain/metric-state.js";
import type { FrameworkRegistry } from "../frameworks.js";
import type { CycleAccess } from "./model.js";

export class Entries {
  constructor(
    private readonly db: Db,
    private readonly frameworks: FrameworkRegistry,
  ) {}

  async ensureEntry(a: CycleAccess, metricId: string, db: Db = this.db): Promise<string> {
    this.frameworks.metric(a.cycle.framework_id, metricId);
    await db.query(
      "INSERT INTO metric_entry (id, cycle_id, college_id, metric_id) VALUES ($1, $2, $3, $4) ON CONFLICT (cycle_id, metric_id) DO NOTHING",
      [randomUUID(), a.cycle.id, a.collegeId, metricId],
    );
    return (
      await db.query<{ id: string }>("SELECT id FROM metric_entry WHERE cycle_id = $1 AND metric_id = $2 AND college_id = $3", [
        a.cycle.id,
        metricId,
        a.collegeId,
      ])
    ).rows[0].id;
  }

  async existingEntryId(a: CycleAccess, metricId: string): Promise<string | null> {
    this.frameworks.metric(a.cycle.framework_id, metricId);
    const r = await this.db.query<{ id: string }>("SELECT id FROM metric_entry WHERE cycle_id = $1 AND metric_id = $2 AND college_id = $3", [
      a.cycle.id,
      metricId,
      a.collegeId,
    ]);
    return r.rows[0]?.id ?? null;
  }

  async getInputs(a: CycleAccess): Promise<Record<string, Record<string, number>>> {
    const rows = (
      await this.db.query<{ key: string; year: string; value: number }>("SELECT key, year, value FROM cycle_input WHERE cycle_id = $1", [a.cycle.id])
    ).rows;
    const out: Record<string, Record<string, number>> = {};
    for (const r of rows) (out[r.key] ??= {})[r.year] = r.value;
    return out;
  }

  async loadState(a: CycleAccess, m: MetricDef, entryId: string | null, inputs?: Record<string, Record<string, number>>): Promise<EntryState> {
    const [rows, narr, ev, prev] = await Promise.all([
      entryId ? this.db.query<{ data: Row }>("SELECT data FROM metric_row WHERE entry_id = $1 AND college_id = $2 ORDER BY seq", [entryId, a.collegeId]) : { rows: [] },
      entryId ? this.db.query<{ field_key: string; text: string }>("SELECT field_key, text FROM narrative_field WHERE entry_id = $1 AND college_id = $2", [entryId, a.collegeId]) : { rows: [] },
      entryId ? this.db.query<{ evidence_key: string }>("SELECT DISTINCT evidence_key FROM evidence WHERE entry_id = $1 AND college_id = $2", [entryId, a.collegeId]) : { rows: [] },
      a.cycle.previous_cycle_id
        ? this.db.query<{ computed_value: number | null }>("SELECT computed_value FROM metric_entry WHERE cycle_id = $1 AND metric_id = $2 AND college_id = $3", [
            a.cycle.previous_cycle_id,
            m.id,
            a.collegeId,
          ])
        : { rows: [] },
    ]);
    const rowsOf = await this.rowsOfMetrics(a, rowSources(m));
    return {
      rows: m.data_from ? (rowsOf[m.data_from] ?? []) : rows.rows.map((r) => r.data),
      rowsOf,
      narrative: Object.fromEntries(narr.rows.map((r) => [r.field_key, r.text])),
      evidenceKeys: ev.rows.map((r) => r.evidence_key),
      years: a.cycle.years,
      inputs: inputs ?? (await this.getInputs(a)),
      previousValue: prev.rows[0]?.computed_value ?? null,
    };
  }

  /** Rows of the given metrics in this cycle, by metric id (for formulas that read other metrics). */
  private async rowsOfMetrics(a: CycleAccess, metricIds: string[]): Promise<Record<string, Row[]>> {
    if (!metricIds.length) return {};
    const res = await this.db.query<{ metric_id: string; data: Row }>(
      `SELECT e.metric_id, r.data FROM metric_row r JOIN metric_entry e ON e.id = r.entry_id
       WHERE e.cycle_id = $1 AND r.college_id = $2 AND e.metric_id = ANY($3::text[]) ORDER BY r.seq`,
      [a.cycle.id, a.collegeId, metricIds],
    );
    const out: Record<string, Row[]> = Object.fromEntries(metricIds.map((id) => [id, []]));
    for (const r of res.rows) out[r.metric_id].push(r.data);
    return out;
  }

  /** Recompute and store value + status so dashboards and benchmarks can read them cheaply. Metrics
   *  calculated from this one's records (data_from, or a formula naming it) are refreshed too. */
  async refresh(a: CycleAccess, m: MetricDef, entryId: string): Promise<{ computed: Computed; status: Status; missing: string[] }> {
    const s = await this.loadState(a, m, entryId);
    const computed = compute(m, s);
    const st = status(m, s, computed);
    await this.db.query(
      "UPDATE metric_entry SET status = $1, computed_value = $2, computed_points = $3, computed_reason = $4, updated_at = now() WHERE id = $5 AND college_id = $6",
      [st.status, computed.value, computed.points, computed.reason ?? null, entryId, a.collegeId],
    );
    for (const d of dependents(this.frameworks.get(a.cycle.framework_id), m.id)) {
      const ds = await this.loadState(a, d, await this.ensureEntry(a, d.id));
      const dc = compute(d, ds);
      const dst = status(d, ds, dc);
      await this.db.query(
        "UPDATE metric_entry SET status = $1, computed_value = $2, computed_points = $3, computed_reason = $4, updated_at = now() WHERE cycle_id = $5 AND metric_id = $6 AND college_id = $7",
        [dst.status, dc.value, dc.points, dc.reason ?? null, a.cycle.id, d.id, a.collegeId],
      );
    }
    return { computed, status: st.status, missing: st.missing };
  }
}
