import { useState } from "react";
import { api, ApiError, type Cycle, type MetricDetail } from "../../api";
import { Icon } from "../Icon";
import { ErrorList, FieldInput, cellText, useConfirm } from "../ui";

export function RowsTable({ cycle, d, onChange }: { cycle: Cycle; d: MetricDetail; onChange: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<{ row?: number; field?: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const base = `/api/v1/cycles/${cycle.id}/metrics/${d.metric.id}`;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      // The key makes a double-click or a retry after a network error create the row only once.
      await api.post(`${base}/rows`, draft, { "Idempotency-Key": crypto.randomUUID() });
      setDraft({});
      onChange();
    } catch (err) {
      if (err instanceof ApiError) setErrors((err.details as typeof errors) ?? [{ message: err.message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel flush">
      <div className="panel-head">
        <h3>
          Rows <span className="muted">{d.rows.length}</span>
        </h3>
        {d.can_edit && (
          <span className="hint">
            Fill the last line and press Add. <span aria-hidden="true">*</span> marks a required column.
          </span>
        )}
      </div>
      <div className="scroll">
        <table className="data">
          <thead>
            <tr>
              {d.columns.map((c) => (
                <th key={c.key}>
                  {c.label}
                  {c.required && <span className="req">*</span>}
                </th>
              ))}
              {d.can_edit && (
                <th className="shrink">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {d.rows.length === 0 && (
              <tr>
                <td colSpan={d.columns.length + (d.can_edit ? 1 : 0)} className="muted" style={{ padding: "20px 12px" }}>
                  No rows yet.{d.can_edit && " Add the first one below, or import the Excel template."}
                </td>
              </tr>
            )}
            {d.rows.map((r) => (
              <tr key={r.id}>
                {d.columns.map((c) => (
                  <td key={c.key}>{cellText(r.data[c.key])}</td>
                ))}
                {d.can_edit && (
                  <td className="actions">
                    <button
                      className="btn ghost icon sm"
                      aria-label="Delete row"
                      title="Delete row"
                      onClick={async () => {
                        if (await confirm({ title: "Delete this row?", body: "The row is removed from this metric.", confirmLabel: "Delete", danger: true })) {
                          await api.del(`${base}/rows/${r.id}`);
                          onChange();
                        }
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {d.can_edit && (
            <tfoot>
              <tr>
                {d.columns.map((c) => (
                  <td key={c.key}>
                    <FieldInput c={c} years={cycle.years} value={draft[c.key] ?? ""} onChange={(v) => setDraft({ ...draft, [c.key]: v })} />
                  </td>
                ))}
                <td className="actions">
                  <button className="btn primary sm" onClick={add} disabled={busy}>
                    {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={14} />}
                    Add
                  </button>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {errors.length > 0 && (
        <div style={{ padding: "0 20px 16px" }}>
          <ErrorList errors={errors} />
        </div>
      )}
    </section>
  );
}
