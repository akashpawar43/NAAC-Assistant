import { Link, useNavigate } from "react-router-dom";
import { type Cycle } from "../api";
import { useApp } from "../App";
import { Icon } from "./Icon";
import { EmptyState, PageHeader, PageLoading } from "./ui";

const period = (c: Cycle) => (c.years.length === 1 ? c.years[0] : `${c.years[0]} to ${c.years[c.years.length - 1]}`);

function ReportTable({ cycles, shared }: { cycles: Cycle[]; shared?: boolean }) {
  const nav = useNavigate();
  return (
    <div className="panel flush">
      <div className="scroll">
        <table className="list hover mid">
          <thead>
            <tr>
              <th>College</th>
              <th>Report</th>
              <th className="hide-sm">{shared ? "Shared by" : "Period"}</th>
              <th className="shrink">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((c) => (
              // The whole row opens the report; the name stays a real link for keyboards and screen readers.
              <tr key={c.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest("a") && nav(`/c/${c.id}`)}>
                <td>
                  <Link to={`/c/${c.id}`} className="plain strong">
                    {c.college_name}
                  </Link>
                  <div className="small muted">{[c.state, c.institution_type].filter(Boolean).join(" · ") || "State and type not set"}</div>
                </td>
                <td>
                  <span className="inline">
                    <span className="tag accent">{c.kind}</span>
                    <span className="secondary">{c.label}</span>
                  </span>
                </td>
                <td className="small secondary hide-sm">
                  {shared ? `${c.owner_email ?? "another user"} · ${c.access === "editor" ? "can edit" : "view only"}` : period(c)}
                </td>
                <td className="actions muted">
                  <Icon name="chevronRight" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ReportsPage() {
  const { cycles, cyclesLoaded } = useApp();
  if (!cyclesLoaded) return <PageLoading />;
  const own = cycles.filter((c) => c.access === "owner");
  const shared = cycles.filter((c) => c.access !== "owner");
  return (
    <main className="page">
      <PageHeader
        title="My reports"
        description="Each report is one AQAR or SSR. Your reports are private to your account unless you share one."
        actions={
          own.length > 0 && (
            <Link className="btn primary" to="/reports/new">
              <Icon name="plus" />
              New report
            </Link>
          )
        }
      />
      {own.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="reports"
            title="Create your first report"
            action={
              <Link className="btn primary" to="/reports/new">
                <Icon name="plus" />
                New report
              </Link>
            }
          >
            An AQAR covers one academic year, an SSR five. You fill it metric by metric, compare with accredited colleges, and export it to Excel, Word or
            PDF.
          </EmptyState>
        </div>
      ) : (
        <ReportTable cycles={own} />
      )}
      {shared.length > 0 && (
        <section className="section" style={{ marginTop: 32 }}>
          <div className="section-header">
            <h2>Shared with me</h2>
            <span className="meta">
              {shared.length} report{shared.length === 1 ? "" : "s"}
            </span>
          </div>
          <ReportTable cycles={shared} shared />
        </section>
      )}
    </main>
  );
}
