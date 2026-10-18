import { useEffect, useMemo, useState } from "react";
import { api, apiUrl, qs, type Cycle, type Dashboard } from "../api";
import { Icon } from "./Icon";
import { Notice, PageError, PageHeader, PageLoading, Segmented, StatusChip, useApi } from "./ui";

type Format = "xlsx" | "docx" | "pdf" | "zip" | "naac";
type Scope = "all" | "criteria" | "metrics";
type Status = "empty" | "partial" | "complete";

const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: "docx", label: "Word (.docx)", hint: "Editable report in NAAC order: values, data tables, narratives, evidence list." },
  { id: "pdf", label: "PDF", hint: "Same layout as Word, ready to print or share for review." },
  { id: "xlsx", label: "Excel (.xlsx)", hint: "Summary, extended profile and one sheet per data metric with every row." },
  { id: "zip", label: "Evidence files (.zip)", hint: "All uploaded proofs in Criterion / Metric folders, with an index listing missing documents." },
];
// Offered when the report's framework records data in NAAC's data-template columns.
const NAAC_FORMAT = {
  id: "naac" as const,
  label: "NAAC data templates (.xlsx)",
  hint: "NAAC's own data-template workbook: same sheets, headers and yearly blocks, filled from your records. Always the whole report.",
};

export function ExportPage({ cycle }: { cycle: Cycle }) {
  const { data: d, error, reload } = useApi<Dashboard>(`/api/v1/cycles/${cycle.id}`);
  const [format, setFormat] = useState<Format>("docx");
  const [scope, setScope] = useState<Scope>("all");
  const [criteria, setCriteria] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [naac, setNaac] = useState(false);
  useEffect(() => {
    api
      .get<{ id: string; naac_template?: boolean }[]>("/api/v1/frameworks")
      .then((fws) => setNaac(!!fws.find((f) => f.id === cycle.framework_id)?.naac_template))
      .catch(() => undefined);
  }, [cycle.framework_id]);
  const formats = naac ? [...FORMATS, NAAC_FORMAT] : FORMATS;
  // NAAC's workbook is always the whole report (one sheet per metric entered as records).
  const whole = format === "naac";

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  // What the server will include, previewed here so the user sees the count before downloading.
  const included = useMemo(() => {
    if (!d) return [];
    return d.criteria
      .flatMap((c) => c.metrics.map((m) => ({ ...m, criterion: c.id })))
      .filter((m) => scope !== "criteria" || criteria.includes(m.criterion))
      .filter((m) => scope !== "metrics" || metrics.includes(m.id))
      .filter((m) => !statuses.length || statuses.includes(m.status as Status));
  }, [d, scope, criteria, metrics, statuses]);

  const url = useMemo(() => {
    if (format === "naac") return `/api/v1/cycles/${cycle.id}/naac-workbook.xlsx`;
    const path = format === "zip" ? "evidence.zip" : `export.${format}`;
    return `/api/v1/cycles/${cycle.id}/${path}${qs({
      criteria: scope === "criteria" ? criteria.join(",") : undefined,
      metrics: scope === "metrics" ? metrics.join(",") : undefined,
      status: statuses.join(","),
    })}`;
  }, [cycle.id, format, scope, criteria, metrics, statuses]);

  const nothingChosen = !whole && ((scope === "criteria" && !criteria.length) || (scope === "metrics" && !metrics.length));

  // Fetch first so a server message ("No evidence files uploaded ...") can be shown instead of
  // the browser saving an error page as the download.
  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl(url), { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `Export failed (${res.status})`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `export.${format}`;
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <PageError message={error} onRetry={reload} />;
  if (!d) return <PageLoading />;
  const chosen = formats.find((f) => f.id === format) ?? FORMATS[0];

  return (
    <main className="page">
      <PageHeader
        title="Export"
        description="Word, PDF and Excel come from one shared model, so they always agree. Limit any format to chosen criteria, metrics or statuses."
      />
      <div className="split">
        <div className="stack">
          <section className="panel">
            <fieldset>
              <legend>Format</legend>
              <div className="options">
                {formats.map((f) => (
                  <label key={f.id} className="option">
                    <input type="radio" name="format" checked={format === f.id} onChange={() => setFormat(f.id)} />
                    <span>
                      <span className="title">{f.label}</span>
                      <span className="desc">{f.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </section>

          {!whole && (
          <section className="panel">
            <fieldset>
              <legend>What to include</legend>
              <div className="stack-sm">
                <label className="check">
                  <input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
                  Whole report
                </label>
                <label className="check">
                  <input type="radio" name="scope" checked={scope === "criteria"} onChange={() => setScope("criteria")} />
                  Selected criteria
                </label>
                {scope === "criteria" && (
                  <div className="indent stack-sm" style={{ paddingBottom: 4 }}>
                    {d.criteria.map((c) => (
                      <label key={c.id} className="check small">
                        <input type="checkbox" checked={criteria.includes(c.id)} onChange={() => setCriteria(toggle(criteria, c.id))} />
                        <span>
                          <span className="muted">Criterion {c.id}</span> · {c.title}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <label className="check">
                  <input type="radio" name="scope" checked={scope === "metrics"} onChange={() => setScope("metrics")} />
                  Selected metrics
                </label>
                {scope === "metrics" && (
                  <div className="indent metric-pick">
                    {d.criteria.map((c) => {
                      const n = c.metrics.filter((m) => metrics.includes(m.id)).length;
                      return (
                        <details key={c.id}>
                          <summary>
                            <Icon name="chevronRight" size={14} className="muted chev" />
                            <span>
                              <span className="muted">Criterion {c.id}</span> · {c.title}
                            </span>
                            {n > 0 && <span className="tag accent" style={{ marginLeft: "auto" }}>{n} chosen</span>}
                          </summary>
                          {c.metrics.map((m) => (
                            <label key={m.id} className="check small">
                              <input type="checkbox" checked={metrics.includes(m.id)} onChange={() => setMetrics(toggle(metrics, m.id))} />
                              <span>
                                <span className="metric-id">{m.id}</span> {m.title}
                              </span>
                              <StatusChip status={m.status} />
                            </label>
                          ))}
                        </details>
                      );
                    })}
                  </div>
                )}
              </div>
            </fieldset>
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border-subtle)" }}>
              <div className="field-label" style={{ marginBottom: 8 }}>
                Only metrics that are <span className="muted">(optional)</span>
              </div>
              <Segmented<Status>
                label="Only metrics with status"
                value={statuses}
                onChange={(s) => setStatuses(toggle(statuses, s))}
                options={[
                  { id: "complete", label: "Complete" },
                  { id: "partial", label: "Partial" },
                  { id: "empty", label: "Not started" },
                ]}
              />
              <span className="hint">Tip: choose Partial and Not started to send a to-do list to the people collecting data.</span>
            </div>
          </section>
          )}
        </div>

        <aside className="panel sticky" aria-live="polite">
          <div className="stat-label">Ready to download</div>
          {whole ? (
            <p className="small muted" style={{ marginTop: 8 }}>
              The whole report, in NAAC's data-template layout.
            </p>
          ) : nothingChosen ? (
            <p style={{ marginTop: 8 }} className="warn">
              Choose at least one {scope === "criteria" ? "criterion" : "metric"}.
            </p>
          ) : (
            <>
              <div className="stat-value">
                {included.length}
                <span className="unit">metric{included.length === 1 ? "" : "s"}</span>
              </div>
              <p className="small muted" style={{ marginTop: 4 }}>
                as {chosen.label}
              </p>
            </>
          )}
          <button className="btn primary block lg" style={{ marginTop: 20 }} disabled={busy || nothingChosen || (!whole && !included.length)} onClick={download}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
            {busy ? "Preparing…" : `Download ${chosen.label}`}
          </button>
          {err && (
            <div style={{ marginTop: 12 }}>
              <Notice kind="error">{err}</Notice>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
