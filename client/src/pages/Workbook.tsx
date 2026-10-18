import { useEffect, useState } from "react";
import { api, ApiError, apiUrl, canEdit, qs, type Cycle } from "../api";
import { Icon } from "./Icon";
import { EmptyState, ErrorList, Notice, PageHeader } from "./ui";

interface SheetReport {
  metric_id: string;
  title: string;
  in_file: number;
  existing: number;
  valid: number;
  action: "replace" | "add" | "unchanged" | "error";
  errors: { row?: number; field?: string; message: string }[];
}
interface Report {
  committed: boolean;
  mode: "append" | "replace";
  error_count: number;
  sheets: SheetReport[];
  profile: { values: number; errors: { row: number; message: string }[] };
  ignored_sheets: string[];
}

const ACTION_TEXT: Record<SheetReport["action"], (s: SheetReport) => string> = {
  replace: (s) => `replace ${s.existing} row${s.existing === 1 ? "" : "s"} with ${s.valid}`,
  add: (s) => `add ${s.valid} to ${s.existing}`,
  unchanged: () => "no rows in file, left as is",
  error: () => "sheet cannot be read",
};

type Format = "app" | "naac";

export function WorkbookPage({ cycle }: { cycle: Cycle }) {
  const [file, setFile] = useState<File | null>(null);
  // Frameworks whose metrics are entered as records can also use NAAC's own data-template workbook.
  const [naac, setNaac] = useState(false);
  const [format, setFormat] = useState<Format>("app");
  useEffect(() => {
    api
      .get<{ id: string; naac_template?: boolean }[]>("/api/v1/frameworks")
      .then((fws) => setNaac(!!fws.find((f) => f.id === cycle.framework_id)?.naac_template))
      .catch(() => undefined);
  }, [cycle.framework_id]);
  const [mode, setMode] = useState<"replace" | "append">("replace");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async (commit: boolean) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      setReport(await api.post<Report>(`/api/v1/cycles/${cycle.id}/${format === "naac" ? "naac-workbook" : "workbook"}/import${qs({ commit: String(commit), mode })}`, fd));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const changed = report?.sheets.filter((s) => s.action !== "unchanged") ?? [];

  return (
    <main className="page narrow">
      <PageHeader
        title="Data workbook"
        description="One Excel file with every data metric on its own sheet, plus the extended profile. Share it with departments or fill it yourself, then upload it back."
      />
      <section className="panel">
        <div className="row-between">
          <div className="step-head">
            <span className="step-num">1</span>
            <div>
              <h3>Download</h3>
              <p className="small muted">Already filled with the data you have entered.</p>
            </div>
          </div>
          <a className="btn" href={apiUrl(`/api/v1/cycles/${cycle.id}/workbook.xlsx`)}>
            <Icon name="download" />
            Download workbook
          </a>
        </div>
        {naac && (
          <div className="row-between" style={{ marginTop: 16 }}>
            <p className="small muted">
              Or in NAAC's own data-template layout (same sheet names, headers and yearly blocks as NAAC's workbook), filled from your records.
            </p>
            <a className="btn" href={apiUrl(`/api/v1/cycles/${cycle.id}/naac-workbook.xlsx`)}>
              <Icon name="download" />
              NAAC format
            </a>
          </div>
        )}
      </section>

      {canEdit(cycle) && (
        <section className="panel">
          <div className="step-head">
            <span className="step-num">2</span>
            <div>
              <h3>Upload</h3>
              <p className="small muted">Every sheet is checked first. Nothing is saved unless every sheet is valid.</p>
            </div>
          </div>
          <div className="stack" style={{ marginTop: 20 }}>
            <label>
              Workbook file
              <input
                type="file"
                accept=".xlsx"
                style={{ display: "block", marginTop: 6 }}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setReport(null);
                }}
              />
            </label>
            {naac && (
              <fieldset>
                <legend className="field-label">File format</legend>
                <div className="options one">
                  {(
                    [
                      ["app", "Workbook from this app", "The data workbook downloaded above (one sheet per metric)."],
                      ["naac", "NAAC data-template workbook", "NAAC's own workbook filled in, or the NAAC-format download. Rows are read under NAAC's header rows."],
                    ] as const
                  ).map(([id, title, desc]) => (
                    <label className="option" key={id}>
                      <input
                        type="radio"
                        name="format"
                        checked={format === id}
                        onChange={() => {
                          setFormat(id);
                          setReport(null);
                        }}
                      />
                      <span>
                        <span className="title">{title}</span>
                        <span className="desc">{desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <fieldset>
              <legend className="field-label">
                How to use each sheet
              </legend>
              <div className="options one">
                <label className="option">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "replace"}
                    onChange={() => {
                      setMode("replace");
                      setReport(null);
                    }}
                  />
                  <span>
                    <span className="title">Replace</span>
                    <span className="desc">The sheet becomes that metric's data. Use for the downloaded, edited workbook.</span>
                  </span>
                </label>
                <label className="option">
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === "append"}
                    onChange={() => {
                      setMode("append");
                      setReport(null);
                    }}
                  />
                  <span>
                    <span className="title">Add</span>
                    <span className="desc">Append the sheet's rows. Use for files returned by departments.</span>
                  </span>
                </label>
              </div>
              <span className="hint">Sheets with no data rows never clear a metric.</span>
            </fieldset>
            {err && <Notice kind="error">{err}</Notice>}
          </div>
          <div className="panel-foot">
            <button className="btn" disabled={!file || busy} onClick={() => send(false)}>
              {busy && !report && <span className="spinner" aria-hidden="true" />}
              {busy && !report ? "Checking…" : "Check file"}
            </button>
            <button className="btn primary" disabled={!file || busy || !report || report.error_count > 0 || report.committed} onClick={() => send(true)}>
              {busy && report && <span className="spinner" aria-hidden="true" />}
              Save all
            </button>
          </div>
        </section>
      )}

      {report && (
        <section className="panel flush" aria-live="polite">
          <div className="panel-head">
            <h3 className="inline">
              <Icon name={report.committed ? "checkCircle" : report.error_count ? "alertCircle" : "check"} />
              {report.committed ? "Saved" : report.error_count ? `${report.error_count} problem${report.error_count === 1 ? "" : "s"} to fix` : "Ready to save"}
            </h3>
            {report.profile.values > 0 && <span className="hint">Extended profile: {report.profile.values} values</span>}
          </div>
          <div style={{ padding: report.profile.errors.length ? "0 20px" : 0 }}>
            <ErrorList errors={report.profile.errors.map((e) => ({ ...e, message: `Extended profile: ${e.message}` }))} />
          </div>
          {changed.length === 0 ? (
            <EmptyState icon="workbook" title="No sheet has data rows">
              Fill at least one metric sheet and upload the file again.
            </EmptyState>
          ) : (
            <table className="list">
              <tbody>
                {changed.map((s) => (
                  <tr key={s.metric_id}>
                    <td className="mid shrink">{s.metric_id}</td>
                    <td>
                      {s.title}
                      <div className={s.errors.length ? "small error" : "small muted"}>
                        {s.errors.length ? `${s.errors.length} error${s.errors.length === 1 ? "" : "s"}` : ACTION_TEXT[s.action](s)}
                      </div>
                      <ErrorList errors={s.errors.map((e) => ({ ...e, message: `Sheet ${s.metric_id}: ${e.message}` }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.ignored_sheets.length > 0 && (
            <p className="small muted" style={{ padding: "12px 20px", borderTop: "1px solid var(--border-subtle)" }}>
              {format === "naac" ? "Sheets NAAC Assistant does not record as rows (fill them in NAAC's workbook)" : "Ignored sheets (not a metric)"}:{" "}
              {report.ignored_sheets.join(", ")}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
