// Narrative answers: saving fields, version history, and the draft preview.
import type { Db } from "../../db/client.js";
import { renderDraft } from "../../domain/narrative.js";
import { badRequest, notFound } from "../errors.js";
import type { FrameworkRegistry } from "../frameworks.js";
import { getVersion, listVersions, recordVersion, type VersionSummary } from "../narrative-history.js";
import type { AccessGate } from "./access.js";
import type { Entries } from "./entries.js";
import type { CycleAccess, WorkspaceContext } from "./model.js";

export class Narratives {
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

  async saveNarrative(a: CycleAccess, metricId: string, fields: Record<string, string>) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    if (!m.narrative) throw badRequest("This metric has no narrative");
    const entryId = await this.entries.ensureEntry(a, metricId);
    await this.access.canEditEntry(a, entryId);
    const allowed = new Set(m.narrative.fields.map((f) => f.key));
    await this.db.tx(async (t) => {
      for (const [k, v] of Object.entries(fields)) {
        if (!allowed.has(k)) throw badRequest(`Unknown narrative field ${k}`);
        await t.query(
          `INSERT INTO narrative_field (entry_id, college_id, field_key, text, updated_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (entry_id, field_key) DO UPDATE SET text = EXCLUDED.text, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [entryId, a.collegeId, k, String(v ?? "").slice(0, 20000), a.userId],
        );
      }
      await recordVersion(t, entryId, a.collegeId, a.userId);
    });
    await this.access.audit(a, "narrative.save", `${a.cycle.id}/${metricId}`, { fields: Object.keys(fields) });
    return this.entries.refresh(a, m, entryId);
  }

  /**
   * Version history. `saved_by` is a workspace member's email, so someone who reaches the report
   * only through a share (and may not list the members) sees null there instead.
   */
  async narrativeVersions(a: CycleAccess, metricId: string): Promise<VersionSummary[]> {
    const entryId = await this.entries.existingEntryId(a, metricId);
    if (!entryId) return [];
    const versions = await listVersions(this.db, entryId, a.collegeId);
    const member = await this.db.query("SELECT 1 FROM membership WHERE user_id = $1 AND college_id = $2", [a.userId, a.collegeId]);
    return member.rows.length ? versions : versions.map((v) => ({ ...v, saved_by: null }));
  }

  async narrativeVersion(a: CycleAccess, metricId: string, versionId: number): Promise<Record<string, string>> {
    const entryId = await this.entries.existingEntryId(a, metricId);
    const fields = entryId ? await getVersion(this.db, entryId, a.collegeId, versionId) : null;
    if (!fields) throw notFound("Version not found");
    return fields;
  }

  /** Restoring saves the old text as the current text, which itself becomes a new version. */
  async restoreNarrativeVersion(a: CycleAccess, metricId: string, versionId: number) {
    const fields = await this.narrativeVersion(a, metricId, versionId);
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    // Fields added to the framework after this version was saved are cleared, not left stale.
    const complete = Object.fromEntries((m.narrative?.fields ?? []).map((f) => [f.key, fields[f.key] ?? ""]));
    return this.saveNarrative(a, metricId, complete);
  }

  /** Draft text from the structured fields plus chosen facts from the college's own computed values. */
  async previewNarrative(a: CycleAccess, metricId: string, fields: Record<string, string>, factMetricIds: string[] = []) {
    const m = this.frameworks.metric(a.cycle.framework_id, metricId);
    if (!m.narrative) throw badRequest("This metric has no narrative");
    const fw = this.frameworks.get(a.cycle.framework_id);
    const facts: string[] = [];
    if (factMetricIds.length) {
      const vals = (
        await this.db.query<{ metric_id: string; computed_value: number | null }>(
          "SELECT metric_id, computed_value FROM metric_entry WHERE cycle_id = $1 AND college_id = $2 AND computed_value IS NOT NULL",
          [a.cycle.id, a.collegeId],
        )
      ).rows;
      for (const id of factMetricIds.slice(0, 10)) {
        const v = vals.find((x) => x.metric_id === id);
        const fm = fw.metrics.find((x) => x.id === id);
        if (v && fm) facts.push(`${fm.title.split(/[,(]/)[0].trim()}: ${v.computed_value}${fm.unit ? " " + fm.unit : ""}`);
      }
    }
    const d = renderDraft({ template: fw.narrative_templates[m.narrative.template], fields, facts });
    return { ...d, word_limit: m.narrative.word_limit, min_words: m.narrative.min_words, over_limit: d.words > m.narrative.word_limit, is_draft: true };
  }
}
