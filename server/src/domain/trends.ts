// Metric values across a college's AQARs, oldest first, with drops flagged. Pure.
// Only AQARs are compared: an SSR value averages five years and would not be like-for-like.
import type { MetricDef } from "./framework.js";

/** A change at least this large in the bad direction is flagged. */
export const DROP_PCT = 10;

export interface ReportValues {
  cycleId: string;
  label: string;
  /** The academic year the AQAR covers; reports are ordered by it. */
  year: string;
  values: Map<string, number | null>;
}

export interface MetricTrend {
  metric_id: string;
  title: string;
  unit: string | null;
  lower_is_better: boolean;
  points: (number | null)[];
  /** Latest value vs the one before it (both must exist and the earlier must not be 0). */
  change_pct: number | null;
  dropped: boolean;
}

export interface Trends {
  reports: { cycle_id: string; label: string; year: string }[];
  metrics: MetricTrend[];
}

export function buildTrends(metrics: MetricDef[], reports: ReportValues[]): Trends {
  const ordered = [...reports].sort((a, b) => a.year.localeCompare(b.year));
  const out: MetricTrend[] = [];
  for (const m of metrics) {
    if (!m.formula || m.type === "choice") continue; // choices are categories, not a measure over time
    const points = ordered.map((r) => r.values.get(m.id) ?? null);
    if (points.every((p) => p === null)) continue;
    const known = points.filter((p): p is number => p !== null);
    const [prev, last] = known.slice(-2);
    let change: number | null = null;
    if (known.length >= 2 && prev !== 0) change = Math.round(((last - prev) / Math.abs(prev)) * 1000) / 10;
    const worse = change !== null && (m.lower_is_better ? change >= DROP_PCT : change <= -DROP_PCT);
    out.push({
      metric_id: m.id,
      title: m.title,
      unit: m.unit ?? null,
      lower_is_better: !!m.lower_is_better,
      points,
      change_pct: change,
      dropped: worse,
    });
  }
  return {
    reports: ordered.map((r) => ({ cycle_id: r.cycleId, label: r.label, year: r.year })),
    metrics: out,
  };
}
