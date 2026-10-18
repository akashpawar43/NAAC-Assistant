// Public page for collection links: no account needed. Shows one metric's form and sends the
// rows for review; the person never sees the report's existing data.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError, apiUrl, qs, type Column } from "../api";
import { Icon } from "./Icon";
import { EmptyState, ErrorList, FieldInput, Notice, PageHeader, PageLoading } from "./ui";

interface LinkInfo {
  college_name: string;
  report: string;
  label: string;
  expires_at: string;
  years: string[];
  metric: { id: string; title: string; explain: string };
  columns: Column[];
  submissions_left: number;
}

type RowError = { row?: number; field?: string; message: string };

export function CollectPage() {
  const { token = "" } = useParams();
  const base = `/api/v1/collect/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Record<string, string>[]>([{}]);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<RowError[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<number | null>(null);

  useEffect(() => {
    api.get<LinkInfo>(base).then(setInfo, (e) => setLoadError(e instanceof ApiError ? e.message : "This link could not be opened"));
  }, [base]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      let r: { rows: number };
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        r = await api.post(`${base}/upload${qs({ name, note })}`, fd);
      } else {
        const filled = rows.filter((x) => Object.values(x).some((v) => v.trim()));
        r = await api.post(`${base}/submit`, { name, note, rows: filled });
      }
      setSent(r.rows);
    } catch (err) {
      setErrors(err instanceof ApiError ? ((err.details as RowError[]) ?? [{ message: err.message }]) : [{ message: "Could not send" }]);
    } finally {
      setBusy(false);
    }
  };

  if (loadError)
    return (
      <main className="page narrow">
        <div className="panel">
          <EmptyState icon="link" title="Link not available">
            {loadError}. Ask the person who sent it for a new link.
          </EmptyState>
        </div>
      </main>
    );
  if (!info) return <PageLoading narrow />;
  if (sent !== null)
    return (
      <main className="page narrow">
        <div className="panel">
          <EmptyState
            icon="checkCircle"
            title="Thank you, your rows were sent"
            action={
              <button
                className="btn"
                onClick={() => {
                  setSent(null);
                  setRows([{}]);
                  setFile(null);
                }}
              >
                Send more
              </button>
            }
          >
            {sent} row{sent === 1 ? "" : "s"} sent for {info.metric.id}. The report owner at {info.college_name} will review them.
          </EmptyState>
        </div>
      </main>
    );

  return (
    <main className="page">
      <PageHeader
        crumbs={
          <span>
            {info.college_name} · {info.report} · requested from {info.label}
          </span>
        }
        eyebrow={<span className="metric-id">{info.metric.id}</span>}
        title={info.metric.title}
        description={info.metric.explain}
        actions={<span className="tag">Open until {new Date(info.expires_at).toLocaleDateString()}</span>}
      />
      {info.submissions_left === 0 ? (
        <Notice kind="warn">This link has received the maximum number of submissions. Ask for a new link.</Notice>
      ) : (
        <form className="stack" onSubmit={send}>
          <section className="panel">
            <h3>About you</h3>
            <div className="form-grid" style={{ marginTop: 16 }}>
              <label>
                Your name or department
                <span className="req" aria-hidden="true">
                  *
                </span>
                <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Note for the reviewer <span className="muted">(optional)</span>
                <input maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>Upload the Excel template</h3>
              <a href={apiUrl(`${base}/template.xlsx`)} className="btn sm">
                <Icon name="download" size={14} />
                Template
              </a>
            </div>
            <p className="small secondary" style={{ marginTop: 6 }}>
              Download the template, fill it and choose it here, or type the rows below instead.
            </p>
            <input type="file" accept=".xlsx" aria-label="Filled template" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ marginTop: 16 }} />
          </section>

          {!file && (
            <section className="panel flush">
              <div className="panel-head">
                <h3>Or type the rows</h3>
                <span className="hint">
                  <span aria-hidden="true">*</span> marks a required column
                </span>
              </div>
              <div className="scroll">
                <table className="data">
                  <thead>
                    <tr>
                      {info.columns.map((c) => (
                        <th key={c.key}>
                          {c.label}
                          {c.required && <span className="req">*</span>}
                        </th>
                      ))}
                      <th className="shrink">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        {info.columns.map((c) => (
                          <td key={c.key}>
                            <FieldInput
                              c={c}
                              years={info.years}
                              value={r[c.key] ?? ""}
                              onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, [c.key]: v } : x)))}
                            />
                          </td>
                        ))}
                        <td className="actions">
                          {rows.length > 1 && (
                            <button
                              type="button"
                              className="btn ghost icon sm"
                              aria-label={`Remove row ${i + 1}`}
                              title="Remove row"
                              onClick={() => setRows(rows.filter((_, j) => j !== i))}
                            >
                              <Icon name="x" size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: "12px 20px" }}>
                <button type="button" className="btn sm" onClick={() => setRows([...rows, {}])}>
                  <Icon name="plus" size={14} />
                  Add row
                </button>
              </div>
            </section>
          )}

          <ErrorList errors={errors} />
          <div className="row-between">
            <p className="small muted" style={{ flex: "1 1 280px" }}>
              Your rows go to the report owner for review before they are added. You will not see the report itself.
            </p>
            <button className="btn primary lg" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Sending…" : "Send for review"}
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
