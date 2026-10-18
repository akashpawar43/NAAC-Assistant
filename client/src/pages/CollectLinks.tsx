import { useEffect, useState } from "react";
import { api, ApiError, type Cycle } from "../api";
import { Icon } from "./Icon";
import { Notice, useConfirm } from "./ui";

interface Link {
  id: string;
  metric_id: string;
  label: string;
  expires_at: string;
  revoked_at: string | null;
  submissions: number;
  pending: number;
  /** Present only in the response that created the link. */
  url?: string;
}

/** Owner panel on a data metric: create, copy and revoke links for people without an account. */
export function CollectLinks({ cycle, metricId }: { cycle: Cycle; metricId: string }) {
  const [links, setLinks] = useState<Link[]>([]);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(14);
  const [created, setCreated] = useState<Link | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const base = `/api/v1/cycles/${cycle.id}`;

  const load = () => api.get<Link[]>(`${base}/collection-links`).then((all) => setLinks(all.filter((l) => l.metric_id === metricId)));
  useEffect(() => {
    void load();
  }, [base, metricId]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setCopied(false);
    try {
      setCreated(await api.post<Link>(`${base}/metrics/${metricId}/collection-links`, { label, days }));
      setLabel("");
      void load();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Could not create the link");
    }
  };

  const active = (l: Link) => !l.revoked_at && new Date(l.expires_at) > new Date();

  return (
    <section className="panel">
      <h3>Collect from a department</h3>
      <p className="small secondary" style={{ marginTop: 6 }}>
        Create a link for someone without an account. They can only fill this metric's rows; they never see your report. Everything they send waits
        for you under <span className="strong">Review submissions</span>.
      </p>
      <form className="inline" onSubmit={create} style={{ marginTop: 16 }}>
        <input
          aria-label="Who is it for?"
          placeholder="Who is it for? e.g. Commerce department"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="grow"
          maxLength={120}
        />
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Open for">
          {[3, 7, 14, 30, 60].map((d) => (
            <option key={d} value={d}>
              Open {d} days
            </option>
          ))}
        </select>
        <button className="btn primary">
          <Icon name="link" />
          Create link
        </button>
      </form>
      {created?.url && (
        <div style={{ marginTop: 16 }}>
          <Notice kind="warn" icon="link">
            <div className="strong">Copy this link now. For security it is not shown again.</div>
            <div className="inline" style={{ marginTop: 8 }}>
              <input readOnly value={created.url} className="grow mono" aria-label="Collection link" onFocus={(e) => e.target.select()} />
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.url!);
                  setCopied(true);
                }}
              >
                <Icon name={copied ? "check" : "copy"} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </Notice>
        </div>
      )}
      {err && (
        <div style={{ marginTop: 16 }}>
          <Notice kind="error">{err}</Notice>
        </div>
      )}
      {links.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="list mid">
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="inline">
                      <span className="strong">{l.label}</span>
                      {active(l) ? (
                        <span className="status complete">Open</span>
                      ) : (
                        <span className="status empty">{l.revoked_at ? "Closed" : "Expired"}</span>
                      )}
                    </div>
                    <div className="small muted">
                      {active(l) && `Until ${new Date(l.expires_at).toLocaleDateString()} · `}
                      {l.submissions} sent · {l.pending} waiting for review
                    </div>
                  </td>
                  <td className="actions">
                    {active(l) && (
                      <button
                        className="btn ghost sm"
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Close this link?",
                              body: `The link for "${l.label}" stops working immediately. Submissions already sent stay in Review submissions.`,
                              confirmLabel: "Close link",
                              danger: true,
                            })
                          ) {
                            await api.del(`${base}/collection-links/${l.id}`);
                            void load();
                          }
                        }}
                      >
                        Close link
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
