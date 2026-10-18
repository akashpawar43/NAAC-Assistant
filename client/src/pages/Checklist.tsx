import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type Cycle, type Flag } from "../api";
import { EmptyState, PageError, PageHeader, PageLoading, Segmented, Severity, useApi } from "./ui";

type Sev = "all" | Flag["severity"];

export function ChecklistPage({ cycle }: { cycle: Cycle }) {
  const { data, error, reload } = useApi<{ flags: Flag[]; summary: Record<string, number> }>(`/api/v1/cycles/${cycle.id}/review-checklist`);
  const [sev, setSev] = useState<Sev>("high");
  const nav = useNavigate();
  if (error) return <PageError message={error} onRetry={reload} />;
  if (!data) return <PageLoading />;
  const shown = data.flags.filter((f) => sev === "all" || f.severity === sev);
  return (
    <main className="page">
      <PageHeader title="Review checklist" description="Rule-based checks a peer team would likely raise. Fix the high-severity items first." />
      <div className="toolbar">
        <Segmented<Sev>
          label="Severity"
          value={sev}
          onChange={setSev}
          options={[
            { id: "high", label: "High", count: data.summary.high ?? 0 },
            { id: "medium", label: "Medium", count: data.summary.medium ?? 0 },
            { id: "low", label: "Low", count: data.summary.low ?? 0 },
            { id: "all", label: "All", count: data.flags.length },
          ]}
        />
      </div>
      <div className="panel flush">
        {shown.length ? (
          <div className="scroll">
            <table className="list hover">
              <thead>
                <tr>
                  <th className="shrink">Severity</th>
                  <th className="shrink">Metric</th>
                  <th>Issue</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f, i) => (
                  <tr key={i} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest("a") && nav(`/c/${cycle.id}/m/${f.metric_id}`)}>
                    <td className="shrink">
                      <Severity s={f.severity} />
                    </td>
                    <td className="mid shrink">
                      <Link to={`/c/${cycle.id}/m/${f.metric_id}`}>{f.metric_id}</Link>
                    </td>
                    <td>
                      {f.message}
                      {f.detail && <div className="small muted">{f.detail}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="checkCircle" title={sev === "all" ? "No issues found" : `No ${sev}-severity issues`}>
            {sev === "all" ? "Every rule in the framework passes for this report." : "Choose another severity to see the remaining checks."}
          </EmptyState>
        )}
      </div>
    </main>
  );
}
