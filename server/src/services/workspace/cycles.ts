// Reports (cycles): create, rename, delete, carry forward from the previous cycle, and fill an
// SSR from the same college's AQARs.
import { randomUUID } from "node:crypto";
import type { Db } from "../../db/client.js";
import { planFromAqars, type AqarSource, type CycleData, type MergePlan } from "../../domain/aqar-merge.js";
import type { Row } from "../../domain/formula.js";
import { academicYears, normalizeYear } from "../../domain/validation.js";
import type { FileStore } from "../../infra/file-store.js";
import { badRequest, forbidden } from "../errors.js";
import type { FrameworkRegistry } from "../frameworks.js";
import { recordVersion } from "../narrative-history.js";
import type { AccessGate } from "./access.js";
import type { Entries } from "./entries.js";
import type { Evaluation } from "./evaluation.js";
import { sameCollege, type Access, type CycleAccess, type CycleRow, type ReportCollege, type WorkspaceContext } from "./model.js";

function cleanCollege(c: ReportCollege) {
  const name = c.college_name.trim().slice(0, 300);
  if (!name) throw badRequest("College name is required");
  const opt = (v?: string | null) => (v && v.trim() ? v.trim().slice(0, 200) : null);
  return { college_name: name, state: opt(c.state), institution_type: opt(c.institution_type), aishe_id: opt(c.aishe_id) };
}

export class Cycles {
  private readonly db: Db;
  private readonly frameworks: FrameworkRegistry;
  private readonly files: FileStore;
  private readonly access: AccessGate;
  private readonly entries: Entries;

  constructor(
    ctx: WorkspaceContext,
    private readonly evaluation: Evaluation,
  ) {
    this.db = ctx.db;
    this.frameworks = ctx.frameworks;
    this.files = ctx.files;
    this.access = ctx.access;
    this.entries = ctx.entries;
  }

  async listCycles(a: Access): Promise<CycleRow[]> {
    return (await this.db.query<CycleRow>("SELECT * FROM cycle WHERE college_id = $1 ORDER BY created_at DESC", [a.collegeId])).rows;
  }

  async createCycle(
    a: Access,
    input: { kind: "AQAR" | "SSR"; label: string; last_year: string; framework_id: string; previous_cycle_id?: string | null } & ReportCollege,
  ): Promise<CycleRow> {
    if (a.role !== "iqac_admin") throw forbidden();
    const fw = this.frameworks.get(input.framework_id);
    if (!fw.applies_to.includes(input.kind)) throw badRequest(`${fw.name} does not support ${input.kind}`);
    const last = normalizeYear(input.last_year);
    if (!last) throw badRequest("last_year must look like 2024-25");
    const years = academicYears(last, input.kind === "AQAR" ? 1 : 5);
    if (input.previous_cycle_id) {
      const prev = await this.db.query("SELECT 1 FROM cycle WHERE id = $1 AND college_id = $2", [input.previous_cycle_id, a.collegeId]);
      if (!prev.rows.length) throw badRequest("previous_cycle_id is not a cycle of this college");
    }
    const c = cleanCollege(input);
    const id = randomUUID();
    const r = await this.db.query<CycleRow>(
      `INSERT INTO cycle (id, college_id, framework_id, kind, label, years, previous_cycle_id, college_name, state, institution_type, aishe_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) RETURNING *`,
      [id, a.collegeId, fw.id, input.kind, input.label.trim().slice(0, 200), JSON.stringify(years), input.previous_cycle_id ?? null,
       c.college_name, c.state, c.institution_type, c.aishe_id],
    );
    await this.access.audit(a, "cycle.create", id, { kind: input.kind, years });
    return r.rows[0];
  }

  async updateCycle(a: CycleAccess, input: { label?: string } & Partial<ReportCollege>): Promise<CycleRow> {
    if (a.role !== "iqac_admin") throw forbidden();
    const c = cleanCollege({ ...a.cycle, ...input, college_name: input.college_name ?? a.cycle.college_name });
    const label = input.label?.trim() ? input.label.trim().slice(0, 200) : a.cycle.label;
    const r = await this.db.query<CycleRow>(
      `UPDATE cycle SET label = $1, college_name = $2, state = $3, institution_type = $4, aishe_id = $5
       WHERE id = $6 AND college_id = $7 RETURNING *`,
      [label, c.college_name, c.state, c.institution_type, c.aishe_id, a.cycle.id, a.collegeId],
    );
    await this.access.audit(a, "cycle.update", a.cycle.id, { label, ...c });
    return r.rows[0];
  }

  /** Deletes a report with all its rows, narratives and evidence files. */
  async deleteCycle(a: CycleAccess): Promise<void> {
    if (a.role !== "iqac_admin") throw forbidden();
    const files = (
      await this.db.query<{ file_key: string }>(
        "SELECT v.file_key FROM evidence v JOIN metric_entry e ON e.id = v.entry_id WHERE e.cycle_id = $1 AND v.college_id = $2",
        [a.cycle.id, a.collegeId],
      )
    ).rows;
    await this.db.query("DELETE FROM cycle WHERE id = $1 AND college_id = $2", [a.cycle.id, a.collegeId]);
    for (const f of files) await this.files.delete(f.file_key);
    await this.access.audit(a, "cycle.delete", a.cycle.id, { label: a.cycle.label, files: files.length });
  }

  /**
   * Year-over-year carry-forward: copies the previous cycle's non-yearly inputs, checklist and
   * choice answers, and qualitative narratives so the new cycle starts pre-filled.
   */
  async carryForward(a: CycleAccess): Promise<{ inputs: number; entries: number }> {
    if (a.role !== "iqac_admin") throw forbidden();
    const prevId = a.cycle.previous_cycle_id;
    if (!prevId) throw badRequest("This cycle has no previous cycle set");
    const fw = this.frameworks.get(a.cycle.framework_id);
    let inputs = 0;
    let entries = 0;
    await this.db.tx(async (t) => {
      const ins = await t.query(
        `INSERT INTO cycle_input (cycle_id, key, year, value)
         SELECT $1, key, year, value FROM cycle_input WHERE cycle_id = $2 AND year = '' ON CONFLICT DO NOTHING RETURNING key`,
        [a.cycle.id, prevId],
      );
      inputs = ins.rows.length;
      for (const m of fw.metrics) {
        if (!["checklist", "choice", "qualitative"].includes(m.type)) continue;
        const prev = (
          await t.query<{ id: string }>("SELECT id FROM metric_entry WHERE cycle_id = $1 AND metric_id = $2 AND college_id = $3", [
            prevId,
            m.id,
            a.collegeId,
          ])
        ).rows[0];
        if (!prev) continue;
        const entryId = await this.entries.ensureEntry(a, m.id, t);
        const existing = await t.query("SELECT 1 FROM metric_row WHERE entry_id = $1 UNION ALL SELECT 1 FROM narrative_field WHERE entry_id = $1", [entryId]);
        if (existing.rows.length) continue;
        await t.query(
          `INSERT INTO metric_row (id, entry_id, college_id, data, created_by)
           SELECT md5(random()::text || id), $1, college_id, data, $3 FROM metric_row WHERE entry_id = $2 ORDER BY seq`,
          [entryId, prev.id, a.userId],
        );
        await t.query(
          `INSERT INTO narrative_field (entry_id, college_id, field_key, text, updated_by)
           SELECT $1, college_id, field_key, text, $3 FROM narrative_field WHERE entry_id = $2`,
          [entryId, prev.id, a.userId],
        );
        entries++;
      }
    });
    await this.access.audit(a, "cycle.carry_forward", a.cycle.id, { from: prevId, inputs, entries });
    return { inputs, entries };
  }

  private async cycleData(a: CycleAccess): Promise<CycleData> {
    const all = await this.evaluation.evaluateAll(a);
    return {
      rowsByMetric: new Map(all.filter((x) => x.s.rows.length).map((x) => [x.m.id, x.s.rows])),
      narrativeByMetric: new Map(all.filter((x) => Object.values(x.s.narrative).some((t) => t.trim())).map((x) => [x.m.id, x.s.narrative])),
      inputs: all[0]?.s.inputs ?? (await this.entries.getInputs(a)),
    };
  }

  /** AQARs in this workspace about the same college, on the same framework, newest first. */
  private async aqarSources(a: CycleAccess): Promise<AqarSource[]> {
    const rows = (
      await this.db.query<CycleRow>(
        "SELECT * FROM cycle WHERE college_id = $1 AND kind = 'AQAR' AND framework_id = $2 ORDER BY created_at DESC",
        [a.collegeId, a.cycle.framework_id],
      )
    ).rows;
    const out: AqarSource[] = [];
    for (const c of rows.filter((r) => sameCollege(a.cycle, r) && a.cycle.years.includes(r.years[0]))) {
      out.push({ cycleId: c.id, label: c.label, year: c.years[0], ...(await this.cycleData({ ...a, cycle: c })) });
    }
    return out;
  }

  async planSsrFromAqars(a: CycleAccess): Promise<MergePlan> {
    if (a.cycle.kind !== "SSR") throw badRequest("Only an SSR can be filled from AQARs");
    if (a.role !== "iqac_admin") throw forbidden();
    const fw = this.frameworks.get(a.cycle.framework_id);
    return planFromAqars(a.cycle.years, fw.metrics, await this.cycleData(a), await this.aqarSources(a));
  }

  /** Applies the plan in one transaction. Re-planned here, so a stale preview cannot be applied. */
  async fillSsrFromAqars(a: CycleAccess): Promise<MergePlan> {
    const plan = await this.planSsrFromAqars(a);
    const touched = new Set<string>();
    await this.db.tx(async (t) => {
      const insertRows = async (metricId: string, rows: Row[]) => {
        const entryId = await this.entries.ensureEntry(a, metricId, t);
        for (const row of rows) {
          await t.query("INSERT INTO metric_row (id, entry_id, college_id, data, created_by) VALUES ($1,$2,$3,$4::jsonb,$5)", [
            randomUUID(),
            entryId,
            a.collegeId,
            JSON.stringify(row),
            a.userId,
          ]);
        }
        touched.add(metricId);
      };
      for (const r of plan.rows) if (r.add.length) await insertRows(r.metricId, r.add);
      for (const ans of plan.answers) {
        if (ans.rows) await insertRows(ans.metricId, ans.rows);
        if (!ans.narrative) continue;
        const entryId = await this.entries.ensureEntry(a, ans.metricId, t);
        for (const [k, v] of Object.entries(ans.narrative)) {
          await t.query(
            "INSERT INTO narrative_field (entry_id, college_id, field_key, text, updated_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (entry_id, field_key) DO NOTHING",
            [entryId, a.collegeId, k, v, a.userId],
          );
        }
        await recordVersion(t, entryId, a.collegeId, a.userId);
        touched.add(ans.metricId);
      }
      for (const i of plan.inputs) {
        await t.query("INSERT INTO cycle_input (cycle_id, key, year, value) VALUES ($1,$2,$3,$4) ON CONFLICT (cycle_id, key, year) DO NOTHING", [
          a.cycle.id,
          i.key,
          i.year,
          i.value,
        ]);
      }
    });
    const fw = this.frameworks.get(a.cycle.framework_id);
    for (const id of touched) await this.entries.refresh(a, fw.metrics.find((m) => m.id === id)!, await this.entries.ensureEntry(a, id));
    await this.access.audit(a, "ssr.fill_from_aqars", a.cycle.id, {
      sources: plan.sources.map((s) => s.label),
      rows: plan.rows.reduce((n, r) => n + r.add.length, 0),
      inputs: plan.inputs.length,
      answers: plan.answers.length,
    });
    return plan;
  }
}
