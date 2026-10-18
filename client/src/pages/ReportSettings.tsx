import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, cycleName, type Cycle } from "../api";
import { useApp } from "../App";
import { CollegeFields, type CollegeValues } from "./CollegeFields";
import { FillFromAqars } from "./FillFromAqars";
import { Icon } from "./Icon";
import { Sharing } from "./Sharing";
import { PageHeader, useConfirm } from "./ui";

export function ReportSettingsPage({ cycle }: { cycle: Cycle }) {
  const { reloadCycles } = useApp();
  const nav = useNavigate();
  const confirm = useConfirm();
  const { hash } = useLocation();
  // The dashboard links to #fill-from-aqars; client-side navigation does not scroll there by itself.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
  }, [hash]);
  const [label, setLabel] = useState(cycle.label);
  const [college, setCollege] = useState<CollegeValues>({
    college_name: cycle.college_name,
    state: cycle.state ?? "",
    institution_type: cycle.institution_type ?? "",
    aishe_id: cycle.aishe_id ?? "",
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.patch(`/api/v1/cycles/${cycle.id}`, { label, ...college });
      await reloadCycles();
      setMsg({ ok: true, text: "Saved" });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Could not save" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete this report?",
      body: `This permanently deletes "${cycleName(cycle)}" for ${cycle.college_name}, with all its data and uploaded files. It cannot be undone.`,
      confirmLabel: "Delete report",
      danger: true,
      typeToConfirm: "DELETE",
    });
    if (!ok) return;
    await api.del(`/api/v1/cycles/${cycle.id}`);
    await reloadCycles();
    nav("/");
  };

  return (
    <main className="page narrow">
      <PageHeader title="Report settings" description={`${cycle.kind} · ${cycle.years.join(", ")}`} />
      <div className="stack">
        <form className="panel" onSubmit={save}>
          <h2>General</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            The type and years cannot change; create a new report instead.
          </p>
          <div className="form-grid" style={{ marginTop: 20 }}>
            <label className="full">
              Report name
              <input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <CollegeFields value={college} onChange={setCollege} />
          </div>
          <div className="panel-foot">
            {msg && (
              <span className={msg.ok ? "inline-msg ok" : "inline-msg error"} role="status">
                <Icon name={msg.ok ? "check" : "alertCircle"} size={14} />
                {msg.text}
              </span>
            )}
            <button className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Save changes
            </button>
          </div>
        </form>
        <Sharing cycle={cycle} />
        {cycle.kind === "SSR" && <FillFromAqars cycle={cycle} onDone={() => void reloadCycles()} />}
        <section className="panel danger-zone">
          <div className="row-between">
            <div style={{ flex: "1 1 280px" }}>
              <h2>Delete report</h2>
              <p className="small secondary" style={{ marginTop: 4 }}>
                Removes this report, its data, narratives and evidence files. This cannot be undone. Export it first if you need a copy.
              </p>
            </div>
            <button className="btn danger" onClick={remove}>
              <Icon name="trash" />
              Delete this report
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
