import { useEffect, useState } from "react";
import { api, ApiError, qs, type Cycle } from "../../api";
import { EmptyState, Loading, Notice, formatValue } from "../ui";
import { usePeerFilters } from "./usePeerFilters";

export function BenchmarkTab({ cycle, metricId, unit }: { cycle: Cycle; metricId: string; unit?: string }) {
  const { f, ui } = usePeerFilters(cycle);
  const [b, setB] = useState<{ sample_size: number; p25: number | null; median: number | null; p75: number | null; p90: number | null; yours: number | null; your_percentile: number | null; note: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setB(null);
    setErr(null);
    api
      .get<typeof b>(`/api/v1/metrics/${metricId}/benchmark${qs({ ...f, cycle_id: cycle.id, framework: cycle.framework_id })}`)
      .then(setB, (e) => setErr(e instanceof ApiError ? e.message : "Could not load the benchmark"));
  }, [metricId, cycle.id, f.state, f.type, f.min_grade]);
  return (
    <section>
      <div className="toolbar">{ui}</div>
      {err && <Notice kind="error">{err}</Notice>}
      {!b && !err ? (
        <Loading />
      ) : b && b.sample_size === 0 ? (
        <div className="panel">
          <EmptyState icon="trends" title="No reported values for this filter yet">
            Widen the state, type or grade filter.
          </EmptyState>
        </div>
      ) : (
        b && (
          <div className="panel">
            <dl className="kv">
              <dt>Colleges</dt>
              <dd>{b.sample_size}</dd>
              <dt>25th percentile</dt>
              <dd>{formatValue(b.p25, unit)}</dd>
              <dt>Median</dt>
              <dd>{formatValue(b.median, unit)}</dd>
              <dt>75th percentile</dt>
              <dd>{formatValue(b.p75, unit)}</dd>
              <dt>90th percentile</dt>
              <dd>{formatValue(b.p90, unit)}</dd>
              <dt className="you">Your value</dt>
              <dd className="you">
                {formatValue(b.yours, unit)} {b.your_percentile !== null && <span className="muted">(above {b.your_percentile}% of them)</span>}
              </dd>
            </dl>
            <p className="small muted" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
              {b.note}
            </p>
          </div>
        )
      )}
    </section>
  );
}
