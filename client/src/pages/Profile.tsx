import { useEffect, useState } from "react";
import { api, ApiError, canEdit, type Cycle } from "../api";
import { Icon } from "./Icon";
import { PageError, PageHeader, PageLoading } from "./ui";

interface FwInfo {
  inputs: { key: string; label: string; per_year: boolean }[];
}

export function ProfilePage({ cycle }: { cycle: Cycle }) {
  const [fw, setFw] = useState<FwInfo | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const k = (key: string, year: string) => `${key}|${year}`;

  useEffect(() => {
    const fail = (e: unknown) => setLoadError(e instanceof ApiError ? e.message : "Check your connection and try again.");
    api.get<FwInfo>(`/api/v1/frameworks/${cycle.framework_id}/metrics`).then(setFw, fail);
    api.get<{ inputs: Record<string, Record<string, number>> }>(`/api/v1/cycles/${cycle.id}`).then((d) => {
      const v: Record<string, string> = {};
      for (const [key, years] of Object.entries(d.inputs)) for (const [y, n] of Object.entries(years)) v[k(key, y)] = String(n);
      setVals(v);
      setInitial(v);
    }, fail);
  }, [cycle.id]);

  if (loadError) return <PageError message={loadError} onRetry={() => location.reload()} />;
  if (!fw) return <PageLoading />;
  const editable = canEdit(cycle);
  const changes = Object.keys({ ...vals, ...initial })
    .filter((x) => (vals[x] ?? "") !== (initial[x] ?? ""))
    .map((x) => {
      const [key, year] = x.split("|");
      return { key, year, value: vals[x] === "" || vals[x] === undefined ? null : Number(vals[x]) };
    });

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/v1/cycles/${cycle.id}/inputs`, changes);
      setInitial(vals);
      setMsg({ ok: true, text: `Saved ${changes.length} value${changes.length === 1 ? "" : "s"}` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Could not save" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <PageHeader
        title="Extended profile"
        description="Base numbers that metric formulas divide by, such as students, teachers and expenditure. Enter each academic year of the report."
      />
      <div className="table-wrap">
        <table className="data profile-grid">
          <thead>
            <tr>
              <th className="left">Input</th>
              {cycle.years.map((y) => (
                <th key={y}>{y}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fw.inputs.map((i) => (
              <tr key={i.key}>
                <th className="left" scope="row">
                  {i.label}
                </th>
                {i.per_year ? (
                  cycle.years.map((y) => (
                    <td key={y}>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        disabled={!editable}
                        aria-label={`${i.label} ${y}`}
                        value={vals[k(i.key, y)] ?? ""}
                        onChange={(e) => setVals({ ...vals, [k(i.key, y)]: e.target.value })}
                        className="num"
                      />
                    </td>
                  ))
                ) : (
                  <td colSpan={cycle.years.length}>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      disabled={!editable}
                      aria-label={i.label}
                      value={vals[k(i.key, "")] ?? ""}
                      onChange={(e) => setVals({ ...vals, [k(i.key, "")]: e.target.value })}
                      className="num"
                    />
                    <span className="xsmall muted" style={{ marginLeft: 8 }}>
                      Once for the whole report
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className="actionbar">
          {msg && (!changes.length || !msg.ok) ? (
            <span className={msg.ok ? "inline-msg ok" : "inline-msg error"} role="status">
              <Icon name={msg.ok ? "check" : "alertCircle"} size={14} />
              {msg.text}
            </span>
          ) : (
            <span className="small muted" role="status">
              {changes.length ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}` : "No unsaved changes"}
            </span>
          )}
          <button className="btn primary" onClick={save} disabled={busy || !changes.length}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Save
          </button>
        </div>
      )}
    </main>
  );
}
