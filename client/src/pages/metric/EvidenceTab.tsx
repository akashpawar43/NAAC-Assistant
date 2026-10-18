import { useState } from "react";
import { api, ApiError, apiUrl, type Cycle, type MetricDetail } from "../../api";
import { Icon } from "../Icon";
import { EmptyState, Notice, useConfirm } from "../ui";

export function EvidenceTab({ cycle, d, onChange }: { cycle: Cycle; d: MetricDetail; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const confirm = useConfirm();
  const base = `/api/v1/cycles/${cycle.id}`;
  const upload = async (key: string, f: File) => {
    setErr(null);
    setUploading(key);
    const fd = new FormData();
    fd.append("evidence_key", key); // must come before the file
    fd.append("file", f);
    try {
      await api.post(`${base}/metrics/${d.metric.id}/evidence`, fd);
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  };
  if (!d.metric.evidence.length)
    return (
      <div className="panel">
        <EmptyState icon="file" title="No documents listed for this metric">
          The framework does not ask for evidence files here.
        </EmptyState>
      </div>
    );
  return (
    <div className="stack">
      {err && <Notice kind="error">{err}</Notice>}
      <section className="panel flush">
        {d.metric.evidence.map((ev) => {
          const files = d.evidence.filter((x) => x.evidence_key === ev.key);
          const state = files.length ? "done" : ev.required === false ? "optional" : "todo";
          return (
            <div key={ev.key} className="evidence">
              <span className={`state ${state}`}>
                <Icon
                  name={state === "done" ? "checkCircle" : state === "todo" ? "alertCircle" : "circle"}
                  label={state === "done" ? "Uploaded" : state === "todo" ? "Required, missing" : "Optional"}
                />
              </span>
              <div>
                <div className="row-between">
                  <div className="inline">
                    <span className="strong">{ev.label}</span>
                    {ev.required === false ? <span className="tag">Optional</span> : !files.length && <span className="sev medium">Required</span>}
                  </div>
                  {d.can_edit && (
                    <label className="btn sm" style={{ position: "relative" }}>
                      {uploading === ev.key ? <span className="spinner" aria-hidden="true" /> : <Icon name="upload" size={14} />}
                      {uploading === ev.key ? "Uploading…" : "Upload"}
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf,.jpg,.jpeg,.png,.xlsx,.docx"
                        aria-label={`Upload ${ev.label}`}
                        onChange={(e) => {
                          if (e.target.files?.[0]) void upload(ev.key, e.target.files[0]);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  )}
                </div>
                {files.length > 0 && (
                  <ul className="file-list">
                    {files.map((f) => (
                      <li key={f.id}>
                        <Icon name="file" size={14} />
                        <a href={apiUrl(`${base}/evidence/${f.id}`)} target="_blank" rel="noreferrer" className="truncate">
                          {f.filename}
                        </a>
                        <span className="muted xsmall">{Math.round(f.bytes / 1024)} KB</span>
                        {d.can_edit && (
                          <button
                            className="btn ghost icon sm"
                            aria-label={`Delete ${f.filename}`}
                            title="Delete file"
                            onClick={async () => {
                              if (await confirm({ title: "Delete this file?", body: f.filename, confirmLabel: "Delete", danger: true })) {
                                await api.del(`${base}/metrics/${d.metric.id}/evidence/${f.id}`);
                                onChange();
                              }
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </section>
      <p className="small muted">PDF, JPG, PNG, XLSX or DOCX, up to 10 MB each.</p>
    </div>
  );
}
