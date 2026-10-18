import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cycleName, type Cycle, type Dashboard } from "../api";
import { CgpaStat } from "./Cgpa";
import { Icon } from "./Icon";
import { EmptyState, Notice, PageError, PageHeader, PageLoading, Segmented, StatusChip, formatValue, useApi } from "./ui";

type Filter = "all" | "empty" | "partial" | "complete";

export function DashboardPage({ cycle }: { cycle: Cycle }) {
  const { data: d, error, reload } = useApi<Dashboard>(`/api/v1/cycles/${cycle.id}`);
  const [filter, setFilter] = useState<Filter>("all");
  const nav = useNavigate();

  if (error) return <PageError message={error} onRetry={reload} />;
  if (!d) return <PageLoading />;
  const total = d.counts.empty + d.counts.partial + d.counts.complete;
  const visible = d.criteria.map((c) => ({ ...c, shown: c.metrics.filter((m) => filter === "all" || m.status === filter) }));

  return (
    <main className="page">
      <PageHeader
        eyebrow={`${d.framework.name} v${d.framework.version}`}
        title={
          <>
            {cycle.college_name} <span className="muted">· {cycleName(cycle)}</span>
          </>
        }
        description={cycle.years.length === 1 ? `Academic year ${cycle.years[0]}` : `Academic years ${cycle.years.join(", ")}`}
        actions={
          <Link className="btn" to={`/c/${cycle.id}/export`}>
            <Icon name="download" />
            Export
          </Link>
        }
      />

      <section className="stats" aria-label="Summary">
        <div className="stat">
          <div className="stat-label">Readiness</div>
          <div className="stat-value">
            {d.readiness_pct}
            <span className="unit">%</span>
          </div>
          <div className="meter" role="progressbar" aria-valuenow={d.readiness_pct} aria-valuemin={0} aria-valuemax={100} aria-label="Readiness">
            <span style={{ width: `${d.readiness_pct}%` }} />
          </div>
          <div className="meter-legend">
            <span>{d.counts.complete} complete</span>
            <span>{d.counts.partial} partial</span>
            <span>{d.counts.empty} not started</span>
          </div>
        </div>
        <CgpaStat cycle={cycle} est={d.cgpa} />
      </section>

      {!d.framework.verified && (
        <Notice kind="warn">Formulas and score bands are indicative. Check them against the current NAAC manual before submission.</Notice>
      )}
      {Object.keys(d.inputs).length === 0 && (
        <Notice>
          <strong>Start with the extended profile.</strong> Most percentages divide by those numbers.{" "}
          <Link to={`/c/${cycle.id}/profile`}>Fill the extended profile</Link>
          {cycle.kind === "SSR" && (
            <>
              {" "}
              · Have AQARs for these years? <Link to={`/c/${cycle.id}/settings#fill-from-aqars`}>Fill this SSR from them</Link>
            </>
          )}
        </Notice>
      )}

      <div className="row-between" style={{ margin: "32px 0 16px" }}>
        <h2>Metrics</h2>
        <Segmented<Filter>
          label="Show metrics"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All", count: total },
            { id: "empty", label: "Not started", count: d.counts.empty },
            { id: "partial", label: "Partial", count: d.counts.partial },
            { id: "complete", label: "Complete", count: d.counts.complete },
          ]}
        />
      </div>

      {visible.every((c) => !c.shown.length) && (
        <div className="panel">
          <EmptyState icon="check" title="No metrics with this status">
            Choose another filter to see the rest of the report.
          </EmptyState>
        </div>
      )}

      <div className="stack">
        {visible.map((c) => {
          if (!c.shown.length) return null;
          const done = c.metrics.filter((m) => m.status === "complete").length;
          return (
            <section key={c.id} className="panel flush" aria-labelledby={`crit-${c.id}`}>
              <div className="panel-head">
                <h3 id={`crit-${c.id}`}>
                  <span className="muted">Criterion {c.id}</span> · {c.title}
                </h3>
                <span className="hint">
                  {done} of {c.metrics.length} complete
                </span>
              </div>
              <div className="scroll">
                <table className="list hover mid">
                  <tbody>
                    {c.shown.map((m) => (
                      <tr key={m.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest("a") && nav(`/c/${cycle.id}/m/${m.id}`)}>
                        <td className="mid shrink">
                          <Link to={`/c/${cycle.id}/m/${m.id}`}>{m.id}</Link>
                        </td>
                        <td>
                          <Link to={`/c/${cycle.id}/m/${m.id}`} className="plain" tabIndex={-1}>
                            {m.title}
                          </Link>
                        </td>
                        <td className="num secondary">{formatValue(m.value, m.unit)}</td>
                        <td className="shrink">
                          <StatusChip status={m.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
