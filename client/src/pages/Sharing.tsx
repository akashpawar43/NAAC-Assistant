import { useEffect, useState } from "react";
import { api, ApiError, type Cycle } from "../api";
import { Icon } from "./Icon";
import { Loading, useConfirm } from "./ui";

interface Share {
  user_id: string;
  email: string;
  role: "editor" | "viewer";
}

/** Owner only: give one person access to this report (never to the rest of the workspace). */
export function Sharing({ cycle }: { cycle: Cycle }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Share["role"]>("editor");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const confirm = useConfirm();
  const base = `/api/v1/cycles/${cycle.id}/shares`;

  useEffect(() => {
    api.get<Share[]>(base).then(setShares, () => setShares([]));
  }, [base]);

  const run = async (fn: () => Promise<Share[]>, ok: string) => {
    setMsg(null);
    try {
      setShares(await fn());
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Something went wrong" });
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<Share[]>(base, { email, role });
      setEmail("");
      return r;
    }, `Shared with ${email}. They get an email and can sign in with that address.`);
  };

  return (
    <section className="panel">
      <h2>Sharing</h2>
      <p className="small secondary" style={{ marginTop: 4 }}>
        Give someone access to <span className="strong">this report only</span>. Editors can change its data, narratives and evidence; viewers can read
        and export. Neither can rename, delete or re-share it, or see your other reports.
      </p>
      <form className="inline" onSubmit={add} style={{ marginTop: 20 }}>
        <input
          type="email"
          required
          aria-label="Email address"
          placeholder="colleague@college.edu.in"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="grow"
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Share["role"])} aria-label="Access">
          <option value="editor">Can edit</option>
          <option value="viewer">View only</option>
        </select>
        <button className="btn primary">Share</button>
      </form>
      {msg && (
        <p className={msg.ok ? "inline-msg ok" : "inline-msg error"} role="status" style={{ marginTop: 10 }}>
          <Icon name={msg.ok ? "check" : "alertCircle"} size={14} />
          {msg.text}
        </p>
      )}
      <div style={{ marginTop: 20 }}>
        {shares === null ? (
          <Loading />
        ) : shares.length ? (
          <div className="table-wrap">
            <table className="list mid">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="shrink">Access</th>
                  <th className="shrink">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shares.map((s) => (
                  <tr key={s.user_id}>
                    <td className="truncate" style={{ maxWidth: 260 }}>
                      {s.email}
                    </td>
                    <td className="shrink">
                      <select
                        aria-label={`Access for ${s.email}`}
                        value={s.role}
                        onChange={(e) => void run(() => api.post<Share[]>(base, { email: s.email, role: e.target.value }), `Access for ${s.email} changed`)}
                        style={{ height: 28 }}
                      >
                        <option value="editor">Can edit</option>
                        <option value="viewer">View only</option>
                      </select>
                    </td>
                    <td className="actions">
                      <button
                        className="btn ghost sm"
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Remove access?",
                              body: `${s.email} will no longer be able to open this report.`,
                              confirmLabel: "Remove",
                              danger: true,
                            })
                          )
                            void run(() => api.del<Share[]>(`${base}/${s.user_id}`), `${s.email} removed`);
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted inline">
            <Icon name="users" size={14} />
            Not shared with anyone.
          </p>
        )}
      </div>
    </section>
  );
}
