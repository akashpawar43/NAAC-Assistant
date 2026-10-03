// Computed value, completeness status and review checklist for one metric entry. Pure functions.
import { evaluate, pointsFor, type Formula, type Row } from "./formula.js";
import type { Framework, MetricDef, RuleDef } from "./framework.js";
import { wordCount } from "./narrative.js";

export type Status = "empty" | "partial" | "complete";

export interface EntryState {
  /** The metric's own rows, or for a `data_from` metric its source metric's rows. */
  rows: Row[];
  /** Rows of other metrics the formula reads (see `rowSources`). */
  rowsOf?: Record<string, Row[]>;
  narrative: Record<string, string>;
  evidenceKeys: string[];
  years: string[];
  inputs: Record<string, Record<string, number>>;
  /** Computed value of the same metric in the previous cycle, if any. */
  previousValue?: number | null;
}

export interface Computed {
  value: number | null;
  points: number | null;
  reason?: string;
  unit?: string;
}

export function compute(m: MetricDef, s: EntryState): Computed {
  if (!m.formula) return { value: null, points: null };
  // A data-table metric with no rows has no value yet; showing "0" would look like a real result.
  if (m.type === "quantitative" && ((m.template?.columns.length ?? 0) > 0 || m.data_from) && s.rows.length === 0) {
    return { value: null, points: null, reason: m.data_from ? `No records entered under ${m.data_from} yet` : "No rows entered yet", unit: m.unit };
  }
  const optionPoints = Object.fromEntries((m.options ?? []).map((o) => [o.key.toUpperCase(), o.points]));
  const r = evaluate(m.formula as Formula, { rows: s.rows, rowsOf: s.rowsOf, years: s.years, inputs: s.inputs, optionPoints });
  const points = m.type === "choice" ? r.value : pointsFor(r.value, m.bands, m.lower_is_better);
  return { value: r.value, points, reason: r.reason, unit: m.unit };
}

export interface StatusResult {
  status: Status;
  missing: string[];
}

export function status(m: MetricDef, s: EntryState, c: Computed): StatusResult {
  const missing: string[] = [];
  const requiredEvidence = m.evidence.filter((e) => e.required !== false);
  const haveEvidence = requiredEvidence.filter((e) => s.evidenceKeys.includes(e.key));
  for (const e of requiredEvidence) if (!s.evidenceKeys.includes(e.key)) missing.push(`Evidence: ${e.label}`);

  let hasData = false;
  let dataDone = false;
  if (m.type === "qualitative" && m.narrative) {
    const filled = m.narrative.fields.filter((f) => (s.narrative[f.key] ?? "").trim());
    hasData = filled.length > 0;
    const req = m.narrative.fields.filter((f) => f.required);
    const missingFields = req.filter((f) => !(s.narrative[f.key] ?? "").trim());
    for (const f of missingFields) missing.push(`Narrative: ${f.label}`);
    const words = wordCount(Object.values(s.narrative).join(" "));
    if (words < m.narrative.min_words) missing.push(`Narrative: at least ${m.narrative.min_words} words (now ${words})`);
    dataDone = missingFields.length === 0 && words >= m.narrative.min_words;
  } else if (m.type === "external") {
    hasData = true;
    dataDone = true;
  } else {
    hasData = s.rows.length > 0 || (m.template?.columns.length === 0 && c.value !== null);
    if (c.value === null) missing.push(c.reason ? `Value: ${c.reason}` : "Value cannot be calculated yet");
    dataDone = c.value !== null;
  }

  if (!hasData && haveEvidence.length === 0) return { status: "empty", missing };
  if (dataDone && haveEvidence.length === requiredEvidence.length) return { status: "complete", missing: [] };
  return { status: "partial", missing };
}

export interface Flag {
  metric_id: string;
  rule: string;
  severity: RuleDef["severity"];
  message: string;
  detail?: string;
}

export function checklist(fw: Framework, m: MetricDef, s: EntryState, c: Computed): Flag[] {
  const flags: Flag[] = [];
  const add = (r: RuleDef, detail?: string) =>
    flags.push({ metric_id: m.id, rule: r.rule, severity: r.severity, message: r.message, detail });
  const yearField = m.template?.columns.some((col) => col.key === "academic_year");
  for (const r of fw.checklist) {
    switch (r.rule) {
      case "no_data":
        if (m.type === "qualitative" ? !Object.values(s.narrative).some((t) => t.trim()) : m.type !== "external" && !s.rows.length && !(m.template?.columns.length === 0 && c.value !== null))
          add(r);
        break;
      case "missing_evidence": {
        const miss = m.evidence.filter((e) => e.required !== false && !s.evidenceKeys.includes(e.key));
        if (miss.length) add(r, miss.map((e) => e.label).join(", "));
        break;
      }
      case "missing_years":
        if (yearField && s.rows.length) {
          const present = new Set(s.rows.map((row) => String(row.academic_year)));
          const miss = s.years.filter((y) => !present.has(y));
          if (miss.length) add(r, miss.join(", "));
        }
        break;
      case "below_band":
        if (c.points !== null && m.type !== "choice" && m.bands && c.points < (r.min_points ?? 2)) add(r, `${c.value}${m.unit ? " " + m.unit : ""} -> ${c.points} points`);
        break;
      case "drop_vs_previous":
        if (c.value !== null && s.previousValue) {
          const drop = m.lower_is_better
            ? ((c.value - s.previousValue) / s.previousValue) * 100
            : ((s.previousValue - c.value) / s.previousValue) * 100;
          if (drop >= (r.min_drop_pct ?? 10)) add(r, `${s.previousValue} -> ${c.value}`);
        }
        break;
      case "narrative_short":
        if (m.narrative) {
          const w = wordCount(Object.values(s.narrative).join(" "));
          if (w > 0 && w < m.narrative.min_words) add(r, `${w} words, recommended at least ${m.narrative.min_words}`);
        }
        break;
      case "narrative_too_long":
        if (m.narrative) {
          const w = wordCount(Object.values(s.narrative).join(" "));
          if (w > m.narrative.word_limit) add(r, `${w} words, limit ${m.narrative.word_limit}`);
        }
        break;
    }
  }
  return flags;
}
