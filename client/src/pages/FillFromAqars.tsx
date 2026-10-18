import { useEffect, useState } from "react";
import { api, ApiError, type Cycle } from "../api";
import { Loading, Notice } from "./ui";

interface Plan {
  sources: { cycleId: string; label: string; year: string }[];
  years_without_aqar: string[];
  rows: { metric_id: string; add: number; duplicates: number }[];
  inputs: number;
  answers: { metric_id: string; from: string }[];
}

/** SSR only: copy data from the same college's AQARs without overwriting anything. */
export function FillFromAqars({ cycle, onDone }: { cycle: Cycle; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<Plan>(`/api/v1/cycles/${cycle.id}/fill-from-aqars`).then(setPlan, (e) => setErr(e instanceof ApiError ? e.message : "Could not load"));
  }, [cycle.id, result]);

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.post<Plan>(`/api/v1/cycles/${cycle.id}/fill-from-aqars`));
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not fill the report");
    } finally {
      setBusy(false);
    }
  };

  const rowsToAdd = plan?.rows.reduce((n, r) => n + r.add, 0) ?? 0;
  const nothingToDo = plan && !rowsToAdd && !plan.inputs && !plan.answers.length;

  return (
    <section className="panel" id="fill-from-aqars">
      <h2>Fill from my AQARs</h2>
      <p className="small secondary" style={{ marginTop: 4 }}>
        Copies data from your AQARs for <span className="strong">{cycle.college_name}</span> whose year is inside this SSR ({cycle.years[0]} to{" "}
        {cycle.years[cycle.years.length - 1]}). It never changes or deletes anything already in this SSR, and running it again adds nothing twice.
      </p>
      <div className="stack" style={{ marginTop: 20 }}>
        {err && <Notice kind="error">{err}</Notice>}
        {!plan && !err && <Loading label="Checking your AQARs…" />}
        {plan && plan.sources.length === 0 && (
          <Notice>No AQARs found for this college in these years. AQARs must use the same college name (or AISHE ID).</Notice>
        )}
        {plan && plan.sources.length > 0 && (
          <>
            <p className="small">
              <span className="muted">Using</span> {plan.sources.map((s) => s.label).join(", ")}
              {plan.years_without_aqar.length > 0 && <span className="muted"> · no AQAR for {plan.years_without_aqar.join(", ")}</span>}
            </p>
            {nothingToDo ? (
              <Notice kind="success">Everything from these AQARs is already in this SSR.</Notice>
            ) : (
              <div className="draft">
                <div className="field-label">This will add</div>
                <ul className="small secondary">
                  {rowsToAdd > 0 && (
                    <li>
                      {rowsToAdd} data rows across {plan.rows.filter((r) => r.add).length} metrics (
                      {plan.rows
                        .filter((r) => r.add)
                        .map((r) => `${r.metric_id}: ${r.add}`)
                        .join(", ")}
                      )
                    </li>
                  )}
                  {plan.rows.some((r) => r.duplicates) && (
                    <li className="muted">{plan.rows.reduce((n, r) => n + r.duplicates, 0)} rows skipped because this SSR already has them</li>
                  )}
                  {plan.inputs > 0 && <li>{plan.inputs} extended-profile values for empty cells</li>}
                  {plan.answers.length > 0 && <li>Narratives and answers for: {plan.answers.map((x) => `${x.metric_id} (from ${x.from})`).join(", ")}</li>}
                </ul>
              </div>
            )}
            {result && (
              <Notice kind="success">Done. Review the copied narratives: they describe a single year and may need updating for the five-year SSR.</Notice>
            )}
            <div>
              <button className="btn primary" disabled={busy || !!nothingToDo} onClick={apply}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? "Filling…" : "Fill this SSR"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
