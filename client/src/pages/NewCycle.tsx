import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, cycleName, type Cycle } from "../api";
import { useApp } from "../App";
import { CollegeFields, emptyCollege, type CollegeValues } from "./CollegeFields";
import { Notice, PageHeader } from "./ui";

export function NewCyclePage() {
  const { collegeId, cycles, reloadCycles } = useApp();
  const nav = useNavigate();
  const [fws, setFws] = useState<{ id: string; name: string; applies_to: string[]; institution_types: string[] }[]>([]);
  // Default to the last completed academic year (June-May): reports are written after a year ends.
  const thisYear = (new Date().getMonth() >= 5 ? new Date().getFullYear() : new Date().getFullYear() - 1) - 1;
  const [form, setForm] = useState({
    kind: "AQAR" as "AQAR" | "SSR",
    label: "",
    last_year: `${thisYear}-${String((thisYear + 1) % 100).padStart(2, "0")}`,
    framework_id: "",
    previous_cycle_id: "",
  });
  const [college, setCollege] = useState<CollegeValues>(emptyCollege);
  const [err, setErr] = useState<string | null>(null);
  // Carry-forward copies from your own reports only.
  const ownCycles = cycles.filter((c) => c.access === "owner");
  // Enter + click (or a double-click) must not create the report twice.
  const [busy, setBusy] = useState(false);

  // Carrying forward from an earlier report: the new one is about the same college.
  const pickPrevious = (id: string) => {
    setForm({ ...form, previous_cycle_id: id });
    const p = ownCycles.find((c) => c.id === id);
    if (p)
      setCollege({ college_name: p.college_name, state: p.state ?? "", institution_type: p.institution_type ?? "", aishe_id: p.aishe_id ?? "" });
  };

  useEffect(() => {
    api.get<typeof fws>("/api/v1/frameworks").then(setFws);
  }, []);

  // The framework follows the institution type (University, Autonomous or Affiliated College);
  // it can still be changed below.
  useEffect(() => {
    if (!fws.length) return;
    const type = college.institution_type.toLowerCase();
    const match = fws.find((f) => f.applies_to.includes(form.kind) && f.institution_types.some((t) => t.toLowerCase() === type));
    const fallback = fws.find((f) => f.applies_to.includes(form.kind));
    setForm((x) => ({ ...x, framework_id: (match ?? (fws.some((f) => f.id === x.framework_id) ? undefined : fallback))?.id ?? x.framework_id }));
  }, [fws, college.institution_type, form.kind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const c = await api.post<Cycle>(`/api/v1/colleges/${collegeId}/cycles`, {
        ...form,
        ...college,
        label: form.label || `${form.kind} ${form.last_year}`,
        previous_cycle_id: form.previous_cycle_id || null,
      });
      if (form.previous_cycle_id) await api.post(`/api/v1/cycles/${c.id}/carry-forward`);
      await reloadCycles();
      nav(`/c/${c.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not create the report");
      setBusy(false);
    }
  };

  return (
    <main className="page narrow">
      <PageHeader
        crumbs={
          <>
            <Link to="/">My reports</Link>
            <span className="sep">/</span>
            <span>New report</span>
          </>
        }
        title="New report"
        description="You can rename the report and change the college details later. The type and years are fixed once it is created."
      />
      <form className="panel" onSubmit={submit}>
        <section className="form-section" aria-labelledby="sec-report">
          <h2 className="form-section-title" id="sec-report">
            Report
          </h2>
          <div className="stack">
            <div role="radiogroup" aria-label="Type" className="options">
              <label className="option">
                <input type="radio" name="kind" checked={form.kind === "AQAR"} onChange={() => setForm({ ...form, kind: "AQAR" })} />
                <span>
                  <span className="title">AQAR</span>
                  <span className="desc">Annual Quality Assurance Report for one academic year.</span>
                </span>
              </label>
              <label className="option">
                <input type="radio" name="kind" checked={form.kind === "SSR"} onChange={() => setForm({ ...form, kind: "SSR" })} />
                <span>
                  <span className="title">SSR</span>
                  <span className="desc">Self Study Report covering the last five academic years.</span>
                </span>
              </label>
            </div>
            <div className="form-grid">
              <label>
                {form.kind === "AQAR" ? "Academic year" : "Last academic year of the period"}
                <span className="req" aria-hidden="true">
                  *
                </span>
                <input required value={form.last_year} onChange={(e) => setForm({ ...form, last_year: e.target.value })} placeholder="2024-25" />
              </label>
              <label>
                Name <span className="muted">(optional)</span>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={`${form.kind} ${form.last_year}`} />
              </label>
              <label className="full">
                Framework
                <select value={form.framework_id} onChange={(e) => setForm({ ...form, framework_id: e.target.value })}>
                  {fws
                    .filter((f) => f.applies_to.includes(form.kind))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
                <span className="hint">Chosen from the institution type; change it only if your manual differs.</span>
              </label>
              {ownCycles.length > 0 && (
                <label className="full">
                  Carry forward from
                  <select value={form.previous_cycle_id} onChange={(e) => pickPrevious(e.target.value)}>
                    <option value="">Start empty</option>
                    {ownCycles.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.college_name} · {cycleName(c)}
                      </option>
                    ))}
                  </select>
                  <span className="hint">Copies narratives, checklist and choice answers, and non-yearly inputs from an earlier report.</span>
                </label>
              )}
            </div>
          </div>
        </section>
        <section className="form-section" aria-labelledby="sec-college">
          <h2 className="form-section-title" id="sec-college">
            College
          </h2>
          <div className="form-grid">
            <CollegeFields value={college} onChange={setCollege} />
          </div>
        </section>
        {err && (
          <div style={{ marginTop: 20 }}>
            <Notice kind="error">{err}</Notice>
          </div>
        )}
        <div className="panel-foot">
          <Link className="btn ghost" to="/">
            Cancel
          </Link>
          <button className="btn primary" disabled={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Creating…" : "Create report"}
          </button>
        </div>
      </form>
    </main>
  );
}
