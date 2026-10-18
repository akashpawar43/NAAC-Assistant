import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Cycle, type MetricDetail } from "../api";
import { Icon } from "./Icon";
import { Loading, useConfirm } from "./ui";

/** Wait this long after the last keystroke before saving. */
const AUTOSAVE_MS = 2000;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; message: string };

interface Version {
  id: number;
  saved_at: string;
  saved_by: string | null;
  words: number;
  preview: string;
}

const countWords = (fields: Record<string, string>) => Object.values(fields).join(" ").trim().split(/\s+/).filter(Boolean).length;

export function NarrativeEditor({ cycle, d, onChange }: { cycle: Cycle; d: MetricDetail; onChange: () => void }) {
  const n = d.metric.narrative!;
  const base = `/api/v1/cycles/${cycle.id}/metrics/${d.metric.id}`;
  const [fields, setFields] = useState<Record<string, string>>(d.narrative);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [showHistory, setShowHistory] = useState(false);
  const [facts, setFacts] = useState("");
  const [preview, setPreview] = useState<{ text: string; words: number; over_limit: boolean } | null>(null);
  // What the server has; compared with `fields` to know whether there is anything to save.
  const savedRef = useRef(JSON.stringify(d.narrative));
  const dirty = JSON.stringify(fields) !== savedRef.current;

  const save = useCallback(
    async (toSave: Record<string, string>) => {
      const body = JSON.stringify(toSave);
      if (body === savedRef.current) return;
      setState({ kind: "saving" });
      try {
        await api.put(base + "/narrative", toSave);
        savedRef.current = body;
        setState({ kind: "saved", at: new Date() });
        onChange();
      } catch (e) {
        setState({ kind: "error", message: e instanceof ApiError ? e.message : "Could not save. Your text is still here; it will retry." });
      }
    },
    [base, onChange],
  );

  // Autosave: each change restarts the timer, so saving happens once typing pauses.
  useEffect(() => {
    if (!d.can_edit || !dirty) return;
    const t = setTimeout(() => void save(fields), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [fields, dirty, d.can_edit, save]);

  // Closing the tab with unsaved text asks for confirmation.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const words = countWords(fields);
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields({ ...fields, [key]: e.target.value });

  return (
    <div className="stack">
      <section className="panel">
        <div className="row-between" style={{ marginBottom: 20 }}>
          <span className="tag">Draft</span>
          {d.can_edit && <SaveStatus state={state} dirty={dirty} onRetry={() => void save(fields)} />}
        </div>
        <div className="stack">
          {n.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.required && (
                <span className="req" aria-hidden="true">
                  *
                </span>
              )}
              {f.type === "longtext" ? (
                <textarea rows={5} disabled={!d.can_edit} value={fields[f.key] ?? ""} onChange={set(f.key)} />
              ) : (
                <input disabled={!d.can_edit} value={fields[f.key] ?? ""} onChange={set(f.key)} />
              )}
            </label>
          ))}
        </div>
        <div className="panel-foot" style={{ justifyContent: "space-between" }}>
          <span className={words > n.word_limit ? "inline-msg warn" : "inline-msg muted"} aria-live="polite">
            {words > n.word_limit && <Icon name="alert" size={14} />}
            {words} words · recommended {n.min_words}–{n.word_limit}
            {words > n.word_limit && " · over the limit"}
          </span>
          <button className="btn ghost" onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>
            <Icon name="history" />
            {showHistory ? "Hide history" : "History"}
          </button>
        </div>
      </section>

      {showHistory && (
        <section className="panel">
          <h3>History</h3>
          <History
            base={base}
            canRestore={d.can_edit}
            // Saving first means the restore never discards text typed in the last two seconds.
            beforeRestore={() => save(fields)}
            onRestored={(restored) => {
              savedRef.current = JSON.stringify(restored);
              setFields(restored);
              setState({ kind: "saved", at: new Date() });
              onChange();
            }}
            refreshKey={savedRef.current}
          />
        </section>
      )}

      <section className="panel">
        <h3>Preview the draft</h3>
        <p className="small secondary" style={{ marginTop: 4 }}>
          Fills NAAC's format from the fields above. Optionally pull in facts from other metrics' computed values.
        </p>
        <div className="inline" style={{ marginTop: 16 }}>
          <input
            className="grow"
            aria-label="Metrics to take facts from"
            placeholder="Metric IDs for facts, e.g. 5.2.1, 3.4.2"
            value={facts}
            onChange={(e) => setFacts(e.target.value)}
          />
          <button
            className="btn"
            onClick={async () =>
              setPreview(await api.post(base + "/narrative/preview", { fields, fact_metrics: facts.split(/[\s,]+/).filter((x) => /^\d\.\d+\.\d+$/.test(x)) }))
            }
          >
            <Icon name="eye" />
            Preview draft
          </button>
        </div>
        {preview && (
          <div className="draft" style={{ marginTop: 16 }}>
            <div className="row-between">
              <span className="small muted">
                DRAFT · {preview.words} words{preview.over_limit ? " · over the word limit" : ""} · review and edit before submission
              </span>
              <button className="btn sm" onClick={() => navigator.clipboard.writeText(preview.text)}>
                <Icon name="copy" size={14} />
                Copy text
              </button>
            </div>
            <pre>{preview.text}</pre>
          </div>
        )}
      </section>
    </div>
  );
}

function SaveStatus({ state, dirty, onRetry }: { state: SaveState; dirty: boolean; onRetry: () => void }) {
  if (state.kind === "saving") return <Loading label="Saving…" />;
  if (state.kind === "error")
    return (
      <span className="inline-msg error" role="alert">
        <Icon name="alertCircle" size={14} />
        {state.message}{" "}
        <button className="link" onClick={onRetry}>
          Retry now
        </button>
      </span>
    );
  if (dirty) return <span className="inline-msg muted">Unsaved changes</span>;
  if (state.kind === "saved")
    return (
      <span className="inline-msg ok">
        <Icon name="check" size={14} />
        Saved {state.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    );
  return <span className="inline-msg muted">All changes saved automatically</span>;
}

function History(props: {
  base: string;
  canRestore: boolean;
  beforeRestore: () => Promise<void>;
  onRestored: (fields: Record<string, string>) => void;
  refreshKey: string;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<{ id: number; fields: Record<string, string> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    api.get<Version[]>(`${props.base}/narrative/versions`).then(setVersions, () => setErr("Could not load history"));
  }, [props.base, props.refreshKey]);

  const view = async (id: number) => setOpen({ id, fields: await api.get(`${props.base}/narrative/versions/${id}`) });

  const restore = async (id: number) => {
    if (
      !(await confirm({
        title: "Restore this version?",
        body: "It replaces the current text. The current text stays in the history.",
        confirmLabel: "Restore",
      }))
    )
      return;
    await props.beforeRestore();
    await api.post(`${props.base}/narrative/versions/${id}/restore`);
    props.onRestored((await api.get(`${props.base}/narrative/versions/${id}`)) as Record<string, string>);
    setOpen(null);
  };

  if (err) return <p className="small error">{err}</p>;
  if (!versions) return <Loading label="Loading history…" />;
  if (!versions.length) return <p className="muted small">No saved versions yet.</p>;
  return (
    <div className="history">
      <p className="small muted" style={{ margin: "4px 0 12px" }}>
        Each version is one editing session (the last {versions.length} kept, up to 50).
      </p>
      <ul>
        {versions.map((v, i) => (
          <li key={v.id}>
            <button className="link" onClick={() => view(v.id)}>
              {new Date(v.saved_at).toLocaleString()}
            </button>{" "}
            <span className="small muted">
              {v.saved_by ?? "unknown"} · {v.words} words
            </span>
            {i === 0 && (
              <span className="tag accent" style={{ marginLeft: 8 }}>
                Current
              </span>
            )}
            {open?.id === v.id && (
              <div className="draft">
                <pre>{Object.values(open.fields).filter(Boolean).join("\n\n")}</pre>
                {props.canRestore && i > 0 && (
                  <button className="btn sm" onClick={() => restore(v.id)}>
                    Restore this version
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
