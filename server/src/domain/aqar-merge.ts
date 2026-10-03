// Plans how to fill an SSR from the college's AQARs. Pure: no database, so it is easy to test.
// Rules: never overwrite or delete what the SSR already has, and running it twice adds nothing.
import type { MetricDef } from "./framework.js";
import type { Row } from "./formula.js";

export interface CycleData {
  rowsByMetric: Map<string, Row[]>;
  narrativeByMetric: Map<string, Record<string, string>>;
  inputs: Record<string, Record<string, number>>;
}

export interface AqarSource extends CycleData {
  cycleId: string;
  label: string;
  year: string;
}

export interface MergePlan {
  sources: { cycleId: string; label: string; year: string }[];
  yearsWithoutAqar: string[];
  rows: { metricId: string; add: Row[]; duplicates: number }[];
  inputs: { key: string; year: string; value: number }[];
  /** Narratives and tick-list/choice answers copied from the most recent AQAR that has them. */
  answers: { metricId: string; fromLabel: string; narrative?: Record<string, string>; rows?: Row[] }[];
}

const hasText = (n?: Record<string, string>) => !!n && Object.values(n).some((t) => t.trim());

/** Same row = same values in the metric's unique columns, or in every column when it has none. */
function rowKey(m: MetricDef, r: Row): string {
  const cols = m.template?.unique?.length ? m.template.unique : Object.keys(r).sort();
  return cols.map((c) => String(r[c] ?? "").trim().toLowerCase()).join("\u0001");
}

/**
 * @param sources AQARs of the same college; when several share a year, the most recent one
 *                should come first (the caller sorts), and only it is used.
 */
export function planFromAqars(ssrYears: string[], metrics: MetricDef[], ssr: CycleData, sources: AqarSource[]): MergePlan {
  const byYear = new Map<string, AqarSource>();
  for (const s of sources) if (ssrYears.includes(s.year) && !byYear.has(s.year)) byYear.set(s.year, s);
  const used = ssrYears.filter((y) => byYear.has(y)).map((y) => byYear.get(y)!);
  const plan: MergePlan = {
    sources: used.map(({ cycleId, label, year }) => ({ cycleId, label, year })),
    yearsWithoutAqar: ssrYears.filter((y) => !byYear.has(y)),
    rows: [],
    inputs: [],
    answers: [],
  };

  for (const m of metrics.filter((x) => x.type === "quantitative")) {
    const seen = new Set((ssr.rowsByMetric.get(m.id) ?? []).map((r) => rowKey(m, r)));
    const add: Row[] = [];
    let duplicates = 0;
    for (const src of used) {
      // An AQAR covers one year; rows tagged with another year are not trusted for the SSR.
      for (const r of (src.rowsByMetric.get(m.id) ?? []).filter((x) => x.academic_year === undefined || x.academic_year === src.year)) {
        const k = rowKey(m, r);
        if (seen.has(k)) {
          duplicates++;
          continue;
        }
        seen.add(k);
        add.push(r);
      }
    }
    if (add.length || duplicates) plan.rows.push({ metricId: m.id, add, duplicates });
  }

  for (const src of used) {
    for (const [key, byY] of Object.entries(src.inputs)) {
      const v = byY[src.year];
      if (v !== undefined && ssr.inputs[key]?.[src.year] === undefined) plan.inputs.push({ key, year: src.year, value: v });
    }
  }
  // Values that are not per year (classrooms, computers): latest AQAR that has one.
  const newestFirst = [...used].reverse();
  const singleKeys = new Set(used.flatMap((s) => Object.entries(s.inputs).filter(([, y]) => y[""] !== undefined).map(([k]) => k)));
  for (const key of singleKeys) {
    if (ssr.inputs[key]?.[""] !== undefined) continue;
    const src = newestFirst.find((s) => s.inputs[key]?.[""] !== undefined)!;
    plan.inputs.push({ key, year: "", value: src.inputs[key][""] });
  }

  for (const m of metrics) {
    if (m.type === "qualitative") {
      if (hasText(ssr.narrativeByMetric.get(m.id))) continue;
      const src = newestFirst.find((s) => hasText(s.narrativeByMetric.get(m.id)));
      if (src) plan.answers.push({ metricId: m.id, fromLabel: src.label, narrative: src.narrativeByMetric.get(m.id) });
    } else if (m.type === "checklist" || m.type === "choice") {
      if (ssr.rowsByMetric.get(m.id)?.length) continue;
      const src = newestFirst.find((s) => s.rowsByMetric.get(m.id)?.length);
      if (src) plan.answers.push({ metricId: m.id, fromLabel: src.label, rows: src.rowsByMetric.get(m.id) });
    }
  }
  return plan;
}
