import { Link } from "react-router-dom";
import { api, type Cycle, type MetricDetail } from "../../api";
import { CollectLinks } from "../CollectLinks";
import { NarrativeEditor } from "../Narrative";
import { EmptyState } from "../ui";
import { ExcelImport } from "./ExcelImport";
import { RowsTable } from "./RowsTable";

/** What the "Data" tab shows depends on the metric type: a narrative, one answer, rows, or a pointer elsewhere. */
export function DataTab({ cycle, d, onChange }: { cycle: Cycle; d: MetricDetail; onChange: () => void }) {
  const m = d.metric;
  if (m.type === "external")
    return (
      <div className="panel">
        <EmptyState icon="info" title="Scored by NAAC directly">
          {m.explain}
        </EmptyState>
      </div>
    );
  if (m.type === "qualitative") return <NarrativeEditor cycle={cycle} d={d} onChange={onChange} />;
  if (m.type === "checklist" || m.type === "choice") return <SingleAnswer cycle={cycle} d={d} onChange={onChange} />;
  if (m.data_from)
    return (
      <div className="panel">
        <EmptyState icon="workbook" title={`Entered under ${m.data_from}`} action={<Link className="btn" to={`/c/${cycle.id}/m/${m.data_from}`}>Open {m.data_from}</Link>}>
          NAAC's data template has one sheet for {m.data_from} and {m.id}. This value is calculated from the records entered under {m.data_from}.
        </EmptyState>
      </div>
    );
  if (!d.columns.length)
    return (
      <div className="panel">
        <EmptyState icon="profile" title="Nothing to enter here" action={<Link className="btn" to={`/c/${cycle.id}/profile`}>Open extended profile</Link>}>
          This value is calculated from the extended profile.
        </EmptyState>
      </div>
    );
  return (
    <div className="stack">
      <RowsTable cycle={cycle} d={d} onChange={onChange} />
      {d.can_edit && <ExcelImport cycle={cycle} d={d} onChange={onChange} />}
      {cycle.access === "owner" && <CollectLinks cycle={cycle} metricId={d.metric.id} />}
    </div>
  );
}

function SingleAnswer({ cycle, d, onChange }: { cycle: Cycle; d: MetricDetail; onChange: () => void }) {
  const m = d.metric;
  const current = d.rows[0]?.data ?? {};
  const save = async (data: Record<string, unknown>) => {
    await api.post(`/api/v1/cycles/${cycle.id}/metrics/${m.id}/rows`, data);
    onChange();
  };
  if (m.type === "checklist")
    return (
      <section className="panel">
        <fieldset>
          <legend>Tick everything that applies</legend>
          <div className="options one">
            {(m.items ?? []).map((it) => (
              <label key={it.key} className="option">
                <input
                  type="checkbox"
                  disabled={!d.can_edit}
                  checked={current[it.key] === true}
                  onChange={(e) =>
                    save({ ...Object.fromEntries((m.items ?? []).map((i) => [i.key, current[i.key] === true ? "Yes" : "No"])), [it.key]: e.target.checked ? "Yes" : "No" })
                  }
                />
                <span className="title" style={{ fontWeight: 400 }}>
                  {it.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>
    );
  return (
    <section className="panel">
      <fieldset>
        <legend>Choose one</legend>
        <div className="options one">
          {(m.options ?? []).map((o) => (
            <label key={o.key} className="option">
              <input type="radio" name="opt" disabled={!d.can_edit} checked={current.option === o.key} onChange={() => save({ option: o.key })} />
              <span className="title" style={{ fontWeight: 400 }}>
                <span className="strong">{o.key}.</span> {o.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
