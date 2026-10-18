import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type Column, type Cycle } from "../api";
import { EmptyState, ErrorList, PageHeader, PageLoading, cellText, useConfirm } from "./ui";

interface Submission {
  id: string;
  link_label: string;
  metric_id: string;
  submitter_name: string;
  note: string | null;
  rows: Record<string, unknown>[];
  row_count: number;
  created_at: string;
}

/** Owner/editor: accept or reject rows sent through collection links. */
export function ReviewPage({ cycle }: { cycle: Cycle }) {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [columns, setColumns] = useState<Record<string, Column[]>>({});
  const [errors, setErrors] = useState<Record<string, { row?: number; message: string }[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const base = `/api/v1/cycles/${cycle.id}`;

  const load = () =>
    api.get<Submission[]>(`${base}/submissions?status=pending`).then((list) => {
      setSubs(list);
      // Keeps the waiting count in the sidebar in step with this list.
      window.dispatchEvent(new Event("submissions-changed"));
    });
  useEffect(() => {
    void load();
    api
      .get<{ metrics: { id: string; columns: Column[] }[] }>(`/api/v1/frameworks/${cycle.framework_id}/metrics`)
      .then((fw) => setColumns(Object.fromEntries(fw.metrics.map((m) => [m.id, m.columns]))));
  }, [base]);

  const act = async (s: Submission, action: "accept" | "reject") => {
    if (
      action === "reject" &&
      !(await confirm({
        title: `Reject ${s.row_count} row${s.row_count === 1 ? "" : "s"}?`,
        body: `The rows from ${s.submitter_name} are discarded and not added to the report.`,
        confirmLabel: "Reject",
        danger: true,
      }))
    )
      return;
    setBusy(s.id);
    try {
      await api.post(`${base}/submissions/${s.id}/${action}`);
      setErrors({ ...errors, [s.id]: [] });
      void load();
    } catch (e) {
      const details = e instanceof ApiError ? ((e.details as { row?: number; message: string }[]) ?? [{ message: e.message }]) : [{ message: "Failed" }];
      setErrors({ ...errors, [s.id]: details });
    } finally {
      setBusy(null);
    }
  };

  if (!subs) return <PageLoading />;
  return (
    <main className="page">
      <PageHeader title="Review submissions" description="Rows sent through collection links. Nothing is added to the report until you accept it." />
      {subs.length === 0 && (
        <div className="panel">
          <EmptyState icon="inbox" title="Nothing waiting for review">
            Create a collection link on a data metric's page to let a department send rows without an account.
          </EmptyState>
        </div>
      )}
      <div className="stack">
        {subs.map((s) => {
          const cols = columns[s.metric_id] ?? Object.keys(s.rows[0] ?? {}).map((k) => ({ key: k, label: k }) as Column);
          return (
            <section key={s.id} className="panel flush">
              <div className="panel-head">
                <div style={{ minWidth: 0 }}>
                  <h3>
                    <Link to={`/c/${cycle.id}/m/${s.metric_id}`} className="metric-id">
                      {s.metric_id}
                    </Link>{" "}
                    · {s.row_count} row{s.row_count === 1 ? "" : "s"} from {s.submitter_name}
                  </h3>
                  <div className="small muted">
                    Link: {s.link_label} · {new Date(s.created_at).toLocaleString()}
                  </div>
                  {s.note && <p className="small secondary" style={{ marginTop: 6 }}>“{s.note}”</p>}
                </div>
                <div className="inline">
                  <button className="btn danger" disabled={busy === s.id} onClick={() => act(s, "reject")}>
                    Reject
                  </button>
                  <button className="btn primary" disabled={busy === s.id} onClick={() => act(s, "accept")}>
                    {busy === s.id && <span className="spinner" aria-hidden="true" />}
                    Accept
                  </button>
                </div>
              </div>
              <div className="scroll">
                <table className="data">
                  <thead>
                    <tr>
                      {cols.map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.slice(0, 50).map((r, i) => (
                      <tr key={i}>
                        {cols.map((c) => (
                          <td key={c.key}>{cellText(r[c.key])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {s.rows.length > 50 && <p className="small muted" style={{ padding: "10px 20px" }}>…and {s.rows.length - 50} more rows</p>}
              {(errors[s.id] ?? []).length > 0 && (
                <div style={{ padding: "0 20px 16px" }}>
                  <ErrorList errors={errors[s.id] ?? []} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}
