import { useState } from "react";
import { api, ApiError, apiUrl, qs, type Cycle, type MetricDetail } from "../../api";
import { Icon } from "../Icon";
import { ErrorList, Notice } from "../ui";

export function ExcelImport({ cycle, d, onChange }: { cycle: Cycle; d: MetricDetail; onChange: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [report, setReport] = useState<{ total: number; valid: number; errors: { row: number; message: string }[]; committed: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/cycles/${cycle.id}/metrics/${d.metric.id}`;

  const send = async (commit: boolean) => {
    if (!file) return;
    setErr(null);
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api.post<typeof report>(`${base}/import${qs({ commit: String(commit), mode })}`, fd);
      setReport(r);
      if (r?.committed) {
        setFile(null);
        onChange();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Excel import</h3>
        <a href={apiUrl(`${base}/template.xlsx`)} className="btn sm">
          <Icon name="download" size={14} />
          Template
        </a>
      </div>
      <p className="small secondary" style={{ marginTop: 6 }}>
        Download the template, fill it (or send it to departments), then upload it here. Nothing is saved until every row is valid.
      </p>
      <div className="inline gap-3" style={{ marginTop: 16 }}>
        <input
          type="file"
          accept=".xlsx"
          aria-label="Excel file"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setReport(null);
          }}
        />
        <select value={mode} onChange={(e) => setMode(e.target.value as "append" | "replace")} aria-label="Import mode">
          <option value="append">Add to existing rows</option>
          <option value="replace">Replace all rows</option>
        </select>
        <span className="spacer" />
        <button className="btn" disabled={!file || busy} onClick={() => send(false)}>
          Check file
        </button>
        <button className="btn primary" disabled={!file || busy || !report || report.errors.length > 0} onClick={() => send(true)}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Save {report ? report.valid : ""} rows
        </button>
      </div>
      {report && (
        <div style={{ marginTop: 16 }} aria-live="polite">
          <Notice kind={report.errors.length ? "warn" : "success"}>
            {report.committed ? "Saved. " : ""}
            {report.valid} of {report.total} rows valid.
          </Notice>
        </div>
      )}
      {report && <ErrorList errors={report.errors} />}
      {err && (
        <div style={{ marginTop: 16 }}>
          <Notice kind="error">{err}</Notice>
        </div>
      )}
    </section>
  );
}
