// One export model shared by every format (Excel, Word, PDF, evidence ZIP), so all of them
// include exactly the same metrics, values, narratives and evidence for a given selection.
import type { Db } from "../db/client.js";
import { rowColumns, type Column, type Framework, type MetricDef } from "../domain/framework.js";
import type { Row } from "../domain/formula.js";
import type { Status } from "../domain/metric-state.js";
import { renderDraft } from "../domain/narrative.js";
import { badRequest } from "./errors.js";
import type { CycleAccess, Workspace } from "./workspace.js";

export interface Selection {
  /** Criterion numbers, e.g. ["3", "5"]. Empty = all. */
  criteria: string[];
  /** Metric IDs, e.g. ["5.2.1"]. Empty = all (within the chosen criteria). */
  metrics: string[];
  /** Completion statuses to include. Empty = all. */
  statuses: Status[];
}

const STATUSES: Status[] = ["empty", "partial", "complete"];
const list = (v: unknown) =>
  typeof v === "string" && v.trim()
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** Reads ?criteria=3,5&metrics=5.2.1&status=partial,empty from the query string. */
export function parseSelection(q: Record<string, unknown>): Selection {
  const criteria = list(q.criteria);
  const metrics = list(q.metrics);
  const statuses = list(q.status);
  if (criteria.some((c) => !/^[1-7]$/.test(c))) throw badRequest("criteria must be numbers 1 to 7");
  if (metrics.some((m) => !/^[1-7]\.\d{1,2}\.\d{1,2}$/.test(m))) throw badRequest("metrics must look like 5.2.1");
  if (statuses.some((s) => !STATUSES.includes(s as Status))) throw badRequest("status must be empty, partial or complete");
  if (metrics.length > 200) throw badRequest("Too many metrics");
  return { criteria, metrics, statuses: statuses as Status[] };
}

export function isWholeReport(sel: Selection): boolean {
  return !sel.criteria.length && !sel.metrics.length && !sel.statuses.length;
}

/** A short human description, used in file names and on cover pages. */
export function describeSelection(sel: Selection): string {
  if (isWholeReport(sel)) return "Full report";
  const parts: string[] = [];
  if (sel.criteria.length) parts.push(`Criterion ${sel.criteria.join(", ")}`);
  if (sel.metrics.length) parts.push(sel.metrics.length <= 4 ? `Metric ${sel.metrics.join(", ")}` : `${sel.metrics.length} metrics`);
  if (sel.statuses.length) parts.push(sel.statuses.map((s) => (s === "empty" ? "not started" : s)).join(" + ") + " only");
  return parts.join(", ");
}

export interface ReportEvidence {
  id: string;
  key: string;
  label: string;
  filename: string;
  file_key: string;
  link: string;
}

export interface ReportMetric {
  m: MetricDef;
  columns: Column[];
  rows: Row[];
  narrative: Record<string, string>;
  /** The narrative fields joined by the metric's NAAC template ("" when nothing was written). */
  narrativeText: string;
  /** For tick-list and choice metrics: what was answered, in words. */
  answer: string[];
  value: number | null;
  points: number | null;
  reason?: string;
  status: Status;
  missing: string[];
  evidence: ReportEvidence[];
}

export interface ReportModel {
  title: string;
  collegeName: string;
  college: { state: string | null; type: string | null; aishe: string | null };
  kind: "AQAR" | "SSR";
  label: string;
  years: string[];
  framework: { name: string; version: string; verified: boolean };
  selection: string;
  wholeReport: boolean;
  generatedAt: Date;
  inputs: { label: string; perYear: boolean; values: (number | null)[]; value: number | null }[];
  criteria: { id: string; title: string; metrics: ReportMetric[] }[];
  counts: Record<Status, number>;
}

/** Text of a cell for documents: booleans as Yes/No, numbers as they are, blanks as "". */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export function formatValue(v: number | null, unit?: string): string {
  if (v === null) return "No value";
  const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : n;
}

export async function buildReport(
  db: Db,
  ws: Workspace,
  fw: Framework,
  a: CycleAccess,
  sel: Selection,
  publicUrl: string,
): Promise<ReportModel> {
  const all = await ws.evaluateAll(a);
  const chosen = all.filter(
    (x) =>
      (!sel.criteria.length || sel.criteria.includes(x.m.criterion)) &&
      (!sel.metrics.length || sel.metrics.includes(x.m.id)) &&
      (!sel.statuses.length || sel.statuses.includes(x.status)),
  );
  if (!chosen.length) throw badRequest("Nothing matches this selection");

  const ev = (
    await db.query<{ metric_id: string; id: string; evidence_key: string; filename: string; file_key: string }>(
      `SELECT e.metric_id, v.id, v.evidence_key, v.filename, v.file_key FROM evidence v JOIN metric_entry e ON e.id = v.entry_id
       WHERE e.cycle_id = $1 AND v.college_id = $2 ORDER BY v.created_at`,
      [a.cycle.id, a.collegeId],
    )
  ).rows;
  const base = publicUrl.replace(/\/$/, "");
  const inputs = await ws.getInputs(a);

  const metrics: ReportMetric[] = chosen.map((x) => {
    const m = x.m;
    let narrativeText = "";
    if (m.narrative && Object.values(x.s.narrative).some((t) => t.trim())) {
      narrativeText = renderDraft({ template: fw.narrative_templates[m.narrative.template], fields: x.s.narrative }).text;
    }
    const first = x.s.rows[0] ?? {};
    const answer =
      m.type === "checklist"
        ? (m.items ?? []).map((it) => `${first[it.key] === true ? "[x]" : "[ ]"} ${it.label}`)
        : m.type === "choice"
          ? (m.options ?? []).filter((o) => String(first.option ?? "").toUpperCase() === o.key).map((o) => `${o.key}. ${o.label}`)
          : [];
    return {
      m,
      columns: m.type === "quantitative" ? rowColumns(m) : [],
      rows: m.type === "quantitative" ? x.s.rows : [],
      narrative: x.s.narrative,
      narrativeText,
      answer,
      value: x.computed.value,
      points: x.computed.points,
      reason: x.computed.reason,
      status: x.status,
      missing: x.missing,
      evidence: ev
        .filter((e) => e.metric_id === m.id)
        .map((e) => ({
          id: e.id,
          key: e.evidence_key,
          label: m.evidence.find((d) => d.key === e.evidence_key)?.label ?? e.evidence_key,
          filename: e.filename,
          file_key: e.file_key,
          link: `${base}/api/v1/cycles/${a.cycle.id}/evidence/${e.id}`,
        })),
    };
  });

  const counts: Record<Status, number> = { empty: 0, partial: 0, complete: 0 };
  for (const x of metrics) counts[x.status]++;
  const kindLabel = a.cycle.label.toUpperCase().startsWith(a.cycle.kind) ? a.cycle.label : `${a.cycle.kind} ${a.cycle.label}`;

  return {
    title: kindLabel,
    collegeName: a.cycle.college_name,
    college: { state: a.cycle.state, type: a.cycle.institution_type, aishe: a.cycle.aishe_id },
    kind: a.cycle.kind,
    label: a.cycle.label,
    years: a.cycle.years,
    framework: { name: fw.name, version: fw.version, verified: fw.verified },
    selection: describeSelection(sel),
    wholeReport: isWholeReport(sel),
    generatedAt: new Date(),
    inputs: fw.inputs.map((i) => ({
      label: i.label,
      perYear: i.per_year,
      values: a.cycle.years.map((y) => (i.per_year ? (inputs[i.key]?.[y] ?? null) : null)),
      value: i.per_year ? null : (inputs[i.key]?.[""] ?? null),
    })),
    criteria: fw.criteria
      .map((c) => ({ id: c.id, title: c.title, metrics: metrics.filter((x) => x.m.criterion === c.id) }))
      .filter((c) => c.metrics.length),
    counts,
  };
}

/** "<College> - AQAR 2024-25 - Criterion 3" (safe for a Content-Disposition file name). */
export function reportFileName(r: ReportModel, ext: string): string {
  const parts = [r.collegeName, r.title, r.wholeReport ? "" : r.selection].filter(Boolean);
  const name = parts.join(" - ").replace(/[^\w.\- ,()+]+/g, "_").slice(0, 150);
  return `${name}.${ext}`;
}
