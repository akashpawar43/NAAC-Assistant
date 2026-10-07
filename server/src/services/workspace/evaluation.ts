// Read-only views over a whole report: every metric evaluated at once, the dashboard, the CGPA
// estimate, the review checklist, and trends across the same college's AQARs.
import type { Db } from "../../db/client.js";
import { rowSources } from "../../domain/framework.js";
import { estimateCgpa, type CgpaEstimate } from "../../domain/cgpa.js";
import type { Row } from "../../domain/formula.js";
import { checklist, compute, status, type EntryState, type Flag } from "../../domain/metric-state.js";
import { buildTrends, type ReportValues, type Trends } from "../../domain/trends.js";
import type { FrameworkRegistry } from "../frameworks.js";
import type { Entries } from "./entries.js";
import { sameCollege, type CycleAccess, type CycleRow, type WorkspaceContext } from "./model.js";

export type Evaluated = Awaited<ReturnType<Evaluation["evaluateAll"]>>;

export class Evaluation {
  private readonly db: Db;
  private readonly frameworks: FrameworkRegistry;
  private readonly entries: Entries;

  constructor(ctx: WorkspaceContext) {
    this.db = ctx.db;
    this.frameworks = ctx.frameworks;
    this.entries = ctx.entries;
  }

  /** Computes every metric of the cycle in memory from three queries. */
  async evaluateAll(a: CycleAccess) {
    const fw = this.frameworks.get(a.cycle.framework_id);
    const [entries, rows, narr, ev, prev, inputs] = await Promise.all([
      this.db.query<{ id: string; metric_id: string; assigned_to: string | null }>(
        "SELECT id, metric_id, assigned_to FROM metric_entry WHERE cycle_id = $1 AND college_id = $2",
        [a.cycle.id, a.collegeId],
      ),
      this.db.query<{ entry_id: string; data: Row }>(
        "SELECT r.entry_id, r.data FROM metric_row r JOIN metric_entry e ON e.id = r.entry_id WHERE e.cycle_id = $1 AND r.college_id = $2 ORDER BY r.seq",
        [a.cycle.id, a.collegeId],
      ),
      this.db.query<{ entry_id: string; field_key: string; text: string }>(
        "SELECT n.entry_id, n.field_key, n.text FROM narrative_field n JOIN metric_entry e ON e.id = n.entry_id WHERE e.cycle_id = $1 AND n.college_id = $2",
        [a.cycle.id, a.collegeId],
      ),
      this.db.query<{ entry_id: string; evidence_key: string }>(
        "SELECT DISTINCT v.entry_id, v.evidence_key FROM evidence v JOIN metric_entry e ON e.id = v.entry_id WHERE e.cycle_id = $1 AND v.college_id = $2",
        [a.cycle.id, a.collegeId],
      ),
      a.cycle.previous_cycle_id
        ? this.db.query<{ metric_id: string; computed_value: number | null }>(
            "SELECT metric_id, computed_value FROM metric_entry WHERE cycle_id = $1 AND college_id = $2",
            [a.cycle.previous_cycle_id, a.collegeId],
          )
        : Promise.resolve({ rows: [] as { metric_id: string; computed_value: number | null }[] }),
      this.entries.getInputs(a),
    ]);
    const byMetric = new Map(entries.rows.map((e) => [e.metric_id, e]));
    const group = <T extends { entry_id: string }>(xs: T[]) => {
      const mp = new Map<string, T[]>();
      for (const x of xs) (mp.get(x.entry_id) ?? mp.set(x.entry_id, []).get(x.entry_id)!).push(x);
      return mp;
    };
    const rowsBy = group(rows.rows);
    const narrBy = group(narr.rows);
    const evBy = group(ev.rows);
    const prevBy = new Map(prev.rows.map((p) => [p.metric_id, p.computed_value]));
    const ownRows = (id: string) => {
      const e = byMetric.get(id);
      return e ? (rowsBy.get(e.id) ?? []).map((r) => r.data) : [];
    };
    return fw.metrics.map((m) => {
      const e = byMetric.get(m.id);
      const rowsOf = Object.fromEntries(rowSources(m).map((id) => [id, ownRows(id)]));
      const s: EntryState = {
        rows: m.data_from ? rowsOf[m.data_from] : ownRows(m.id),
        rowsOf,
        narrative: e ? Object.fromEntries((narrBy.get(e.id) ?? []).map((n) => [n.field_key, n.text])) : {},
        evidenceKeys: e ? (evBy.get(e.id) ?? []).map((x) => x.evidence_key) : [],
        years: a.cycle.years,
        inputs,
        previousValue: prevBy.get(m.id) ?? null,
      };
      const computed = compute(m, s);
      const st = status(m, s, computed);
      return { m, s, computed, status: st.status, missing: st.missing, assigned_to: e?.assigned_to ?? null };
    });
  }

  /** Indicative CGPA range from the metrics' current state (see domain/cgpa.ts for the rules). */
  async cgpa(a: CycleAccess, evaluated?: Evaluated): Promise<CgpaEstimate> {
    const all = evaluated ?? (await this.evaluateAll(a));
    return estimateCgpa(
      this.frameworks.get(a.cycle.framework_id),
      all.map((x) => ({
        m: x.m,
        value: x.computed.value,
        points: x.computed.points,
        hasData: x.s.rows.length > 0 || Object.values(x.s.narrative).some((t) => t.trim()),
      })),
    );
  }

  async dashboard(a: CycleAccess) {
    const fw = this.frameworks.get(a.cycle.framework_id);
    const all = await this.evaluateAll(a);
    const counts = { empty: 0, partial: 0, complete: 0 };
    for (const x of all) counts[x.status]++;
    // Partial work counts half so the bar moves as people fill data in.
    const readiness = Math.round(((counts.complete + counts.partial * 0.5) / all.length) * 100);
    const est = await this.cgpa(a, all);
    return {
      cycle: a.cycle,
      framework: { id: fw.id, name: fw.name, version: fw.version, verified: fw.verified },
      role: a.role,
      readiness_pct: readiness,
      cgpa: { available: est.available, min: est.min, max: est.max, grade_min: est.grade_min, grade_max: est.grade_max, calculated_share: est.calculated_share },
      counts,
      criteria: fw.criteria.map((c) => ({
        ...c,
        metrics: all
          .filter((x) => x.m.criterion === c.id)
          .map((x) => ({
            id: x.m.id,
            title: x.m.title,
            type: x.m.type,
            key_indicator: x.m.key_indicator,
            status: x.status,
            value: x.computed.value,
            unit: x.m.unit ?? null,
            points: x.computed.points,
            assigned_to: x.assigned_to,
          })),
      })),
    };
  }

  async reviewChecklist(a: CycleAccess): Promise<{ flags: Flag[]; summary: Record<string, number> }> {
    const fw = this.frameworks.get(a.cycle.framework_id);
    const flags = (await this.evaluateAll(a)).flatMap((x) => checklist(fw, x.m, x.s, x.computed));
    const order = { high: 0, medium: 1, low: 2 };
    flags.sort((x, y) => order[x.severity] - order[y.severity]);
    const summary = { high: 0, medium: 0, low: 0 } as Record<string, number>;
    for (const f of flags) summary[f.severity]++;
    return { flags, summary };
  }

  /**
   * The same college's AQARs in this workspace, oldest first, with each metric's value. SSRs are
   * left out: their values average five years, so they would not compare like for like.
   * Someone a single report was shared with sees only that report: a share never reveals the
   * owner's other reports.
   */
  async trends(a: CycleAccess): Promise<Trends> {
    const member = await this.db.query("SELECT 1 FROM membership WHERE user_id = $1 AND college_id = $2", [a.userId, a.collegeId]);
    const cycles = member.rows.length
      ? (
          await this.db.query<CycleRow>("SELECT * FROM cycle WHERE college_id = $1 AND framework_id = $2 AND kind = 'AQAR'", [
            a.collegeId,
            a.cycle.framework_id,
          ])
        ).rows.filter((c) => sameCollege(a.cycle, c))
      : a.cycle.kind === "AQAR"
        ? [a.cycle]
        : [];
    const reports: ReportValues[] = [];
    for (const c of cycles) {
      const all = await this.evaluateAll({ ...a, cycle: c });
      reports.push({
        cycleId: c.id,
        label: c.label,
        year: c.years[0],
        values: new Map(all.map((x) => [x.m.id, x.computed.value])),
      });
    }
    return buildTrends(this.frameworks.get(a.cycle.framework_id).metrics, reports);
  }
}
