// The same college's AQARs over time: one sparkline per metric, drops called out first.
import { useState } from "react";
import { Link } from "react-router-dom";
import { type Cycle } from "../api";
import { EmptyState, Notice, PageError, PageHeader, PageLoading, formatValue, useApi } from "./ui";

interface MetricTrend {
  metric_id: string;
  title: string;
  unit: string | null;
  lower_is_better: boolean;
  points: (number | null)[];
  change_pct: number | null;
  dropped: boolean;
}
interface TrendData {
  reports: { cycle_id: string; label: string; year: string }[];
  metrics: MetricTrend[];
}

/** Single-series sparkline: 2px line, gaps where a report has no value, last point emphasised. */
function Sparkline({ t, labels }: { t: MetricTrend; labels: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 140;
  const H = 32;
  const pad = 5;
  const vals = t.points.filter((p): p is number => p !== null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i: number) => (t.points.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (t.points.length - 1));
  const y = (v: number) => (hi === lo ? H / 2 : H - pad - ((v - lo) * (H - 2 * pad)) / (hi - lo));
  // Break the line at missing values instead of drawing through them.
  const segments: string[] = [];
  let current = "";
  t.points.forEach((p, i) => {
    if (p === null) {
      if (current) segments.push(current);
      current = "";
    } else current += `${current ? "L" : "M"}${x(i)},${y(p)}`;
  });
  if (current) segments.push(current);
  const last = t.points.length - 1;
  return (
    <span className="range-bar">
      <svg width={W} height={H} role="img" aria-label={`${t.metric_id} over ${labels.length} reports`} onMouseLeave={() => setHover(null)}>
        {segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {t.points.map((p, i) =>
          p === null ? null : (
            <g key={i}>
              <circle cx={x(i)} cy={y(p)} r={i === last ? 4 : 2.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={i === last ? 2 : 0} />
              {/* Hit target larger than the mark. */}
              <rect x={x(i) - 10} y={0} width={20} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          ),
        )}
      </svg>
      {hover !== null && t.points[hover] !== null && (
        <span className="tooltip" role="tooltip">
          {labels[hover]}: {formatValue(t.points[hover], t.unit)}
        </span>
      )}
    </span>
  );
}

function Change({ t }: { t: MetricTrend }) {
  if (t.change_pct === null) return <span className="muted">–</span>;
  const sign = t.change_pct > 0 ? "+" : "";
  if (t.dropped)
    return (
      <span className="drop" title={t.lower_is_better ? "Higher is worse for this metric" : undefined}>
        ▼ {sign}
        {t.change_pct}% {t.lower_is_better ? "(worse)" : ""}
      </span>
    );
  return (
    <span className="muted">
      {sign}
      {t.change_pct}%
    </span>
  );
}

export function TrendsPage({ cycle }: { cycle: Cycle }) {
  const { data: d, error, reload } = useApi<TrendData>(`/api/v1/cycles/${cycle.id}/trends`);
  if (error) return <PageError message={error} onRetry={reload} />;
  if (!d) return <PageLoading />;

  const labels = d.reports.map((r) => r.label);
  const drops = d.metrics.filter((m) => m.dropped);
  const latest = (t: MetricTrend) => [...t.points].reverse().find((p) => p !== null) ?? null;
  const table = (rows: MetricTrend[]) => (
    <div className="scroll">
      <table className="list mid">
        <thead>
          <tr>
            <th className="shrink">Metric</th>
            <th>Title</th>
            <th className="hide-sm">Trend</th>
            <th className="num">Latest</th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.metric_id}>
              <td className="mid shrink">
                <Link to={`/c/${cycle.id}/m/${t.metric_id}`}>{t.metric_id}</Link>
              </td>
              <td className="small secondary">{t.title}</td>
              <td className="hide-sm shrink">
                <Sparkline t={t} labels={labels} />
              </td>
              <td className="num">{formatValue(latest(t), t.unit)}</td>
              <td className="num">
                <Change t={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <main className="page">
      <PageHeader
        title="Trends"
        description={
          d.reports.length > 1
            ? `Across ${d.reports.length} AQARs for ${cycle.college_name}: ${labels.join(" → ")}. Change compares the latest value with the one before it.`
            : `How ${cycle.college_name}'s values change from one AQAR to the next.`
        }
      />
      {d.reports.length <= 1 && (
        <Notice>Trends need AQARs for at least two years with the same college name (or AISHE ID).</Notice>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        SSRs are not included: their values average five years, so they would not compare like for like.
      </p>
      {drops.length > 0 && (
        <section className="section" style={{ marginTop: 24 }}>
          <div className="section-header">
            <h2>Dropped by 10% or more</h2>
            <span className="meta">
              {drops.length} metric{drops.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="panel flush">{table(drops)}</div>
        </section>
      )}
      <section className="section" style={{ marginTop: 24 }}>
        <div className="section-header">
          <h2>All metrics with a value</h2>
          {d.metrics.length > 0 && <span className="meta">{d.metrics.length} metrics</span>}
        </div>
        <div className="panel flush">
          {d.metrics.length === 0 ? (
            <EmptyState icon="trends" title="No calculated values yet">
              Values appear here once metrics in these AQARs have data.
            </EmptyState>
          ) : (
            table(d.metrics)
          )}
        </div>
      </section>
    </main>
  );
}
