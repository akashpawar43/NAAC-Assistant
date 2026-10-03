// Indicative CGPA estimate. Pure: takes the framework and each metric's computed state.
//
// Key indicators are weighted by the framework's weights. Inside a key indicator, metrics are
// weighted by the manual's metric weightage when every metric has one, else counted equally.
// Parts of the score
// (narratives, the student survey, counts without a published benchmark) cannot be estimated.
// So the result is a range: the CGPA if every unknown part scores 0, and if it scores 4.
import type { Framework, MetricDef } from "./framework.js";

export const MAX_POINTS = 4;

/** NAAC's seven-point grade scale (lower CGPA bound of each grade). */
export const GRADE_SCALE: { grade: string; min: number }[] = [
  { grade: "A++", min: 3.51 },
  { grade: "A+", min: 3.26 },
  { grade: "A", min: 3.01 },
  { grade: "B++", min: 2.76 },
  { grade: "B+", min: 2.51 },
  { grade: "B", min: 2.01 },
  { grade: "C", min: 1.51 },
  { grade: "D", min: 0 },
];

export function gradeFor(cgpa: number): string {
  return GRADE_SCALE.find((g) => cgpa >= g.min)!.grade;
}

export type MetricBasis =
  | "calculated" // indicative points from the metric's own value
  | "no_data" // nothing entered: scores 0 if submitted like this
  | "no_benchmark" // a count with no published band: 0 to 4
  | "not_calculable" // data entered but a required input is missing: 0 to 4
  | "peer_review" // narrative written; the peer team scores it: 0 to 4
  | "external"; // scored by NAAC directly (student survey): 0 to 4

export interface MetricInput {
  m: MetricDef;
  value: number | null;
  points: number | null;
  /** Rows, ticks, an answer or narrative text exist. */
  hasData: boolean;
}

export interface MetricEstimate {
  metric_id: string;
  min: number;
  max: number;
  basis: MetricBasis;
  weight?: number;
}

export interface KeyIndicatorEstimate {
  id: string;
  title: string;
  weight: number;
  min: number;
  max: number;
  metrics: MetricEstimate[];
}

export interface CgpaEstimate {
  available: boolean;
  min: number;
  max: number;
  grade_min: string;
  grade_max: string;
  criteria: { id: string; title: string; weight: number; min: number; max: number; key_indicators: KeyIndicatorEstimate[] }[];
  /** Share of the total weight that comes from values calculated from the college's own data. */
  calculated_share: number;
}

export function estimateMetric(x: MetricInput): MetricEstimate {
  const at = (min: number, max: number, basis: MetricBasis): MetricEstimate => ({ metric_id: x.m.id, min, max, basis, ...(x.m.weight ? { weight: x.m.weight } : {}) });
  switch (x.m.type) {
    case "external":
      return at(0, MAX_POINTS, "external");
    case "qualitative":
      return x.hasData ? at(0, MAX_POINTS, "peer_review") : at(0, 0, "no_data");
    case "checklist":
    case "choice":
      return x.points === null ? at(0, 0, "no_data") : at(x.points, x.points, "calculated");
    case "quantitative":
      if (x.value === null) return x.hasData ? at(0, MAX_POINTS, "not_calculable") : at(0, 0, "no_data");
      if (x.points === null) return at(0, MAX_POINTS, "no_benchmark");
      return at(x.points, x.points, "calculated");
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Weighted by metric weightage when every metric has one, else a plain average. */
function kiAverage(ms: MetricEstimate[], pick: (m: MetricEstimate) => number): number {
  if (!ms.length) return 0;
  if (ms.every((m) => m.weight)) {
    const total = ms.reduce((a, m) => a + m.weight!, 0);
    return ms.reduce((a, m) => a + m.weight! * pick(m), 0) / total;
  }
  return ms.reduce((a, m) => a + pick(m), 0) / ms.length;
}

export function estimateCgpa(fw: Framework, inputs: MetricInput[]): CgpaEstimate {
  const byKi = new Map<string, MetricEstimate[]>();
  for (const x of inputs) {
    const list = byKi.get(x.m.key_indicator) ?? [];
    list.push(estimateMetric(x));
    byKi.set(x.m.key_indicator, list);
  }

  let total = 0;
  let fixedWeight = 0;
  const criteria = fw.criteria.map((c) => {
    const kis: KeyIndicatorEstimate[] = c.key_indicators
      .filter((k) => k.weight && byKi.has(k.id))
      .map((k) => {
        const ms = byKi.get(k.id)!;
        const min = kiAverage(ms, (m) => m.min);
        const max = kiAverage(ms, (m) => m.max);
        // Only real calculated values count; "no data, scores 0" is not evidence of anything.
        fixedWeight += k.weight! * kiAverage(ms, (m) => (m.basis === "calculated" ? 1 : 0));
        return { id: k.id, title: k.title, weight: k.weight!, min: round2(min), max: round2(max), metrics: ms };
      });
    const weight = kis.reduce((a, k) => a + k.weight, 0);
    total += weight;
    const wavg = (pick: (k: KeyIndicatorEstimate) => number) => (weight ? kis.reduce((a, k) => a + k.weight * pick(k), 0) / weight : 0);
    return { id: c.id, title: c.title, weight, min: round2(wavg((k) => k.min)), max: round2(wavg((k) => k.max)), key_indicators: kis };
  });

  if (!total) return { available: false, min: 0, max: 0, grade_min: "", grade_max: "", criteria: [], calculated_share: 0 };
  const cg = (pick: (c: (typeof criteria)[number]) => number) => round2(criteria.reduce((a, c) => a + c.weight * pick(c), 0) / total);
  const min = cg((c) => c.min);
  const max = cg((c) => c.max);
  return {
    available: true,
    min,
    max,
    grade_min: gradeFor(min),
    grade_max: gradeFor(max),
    criteria: criteria.filter((c) => c.weight),
    calculated_share: round2(fixedWeight / total),
  };
}
