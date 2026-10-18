import { useEffect, useState } from "react";
import { useApp } from "../App";
import { api, ApiError, type Member } from "../api";
import { Icon } from "./Icon";
import { Loading, PageHeader, useConfirm } from "./ui";

const ROLE_LABELS: Record<Member["role"], string> = { iqac_admin: "Admin", dept_editor: "Department editor", viewer: "Viewer" };

type Msg = { ok: boolean; text: string } | null;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong");

function StatusLine({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p className={msg.ok ? "inline-msg ok" : "inline-msg error"} role="status" style={{ marginTop: 10 }}>
      <Icon name={msg.ok ? "check" : "alertCircle"} size={14} />
      {msg.text}
    </p>
  );
}

/** Who can open the reports in your workspace; admins can take someone's access away. */
function Members() {
  const { me, collegeId, role } = useApp();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const confirm = useConfirm();
  const base = `/api/v1/colleges/${collegeId}/members`;

  useEffect(() => {
    api.get<Member[]>(base).then(setMembers, () => setMembers([]));
  }, [base]);

  const remove = async (m: Member) => {
    const ok = await confirm({
      title: "Remove from workspace?",
      body: `${m.email} will lose access to every report in this workspace right away. Metrics assigned to them become unassigned.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setMsg(null);
    try {
      await api.del(`${base}/${m.id}`);
      setMembers((list) => (list ?? []).filter((x) => x.id !== m.id));
      setMsg({ ok: true, text: `${m.email} removed` });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  const others = (members ?? []).filter((m) => m.id !== me.user.id);
  return (
    <section className="panel">
      <h2>Workspace members</h2>
      <p className="small secondary" style={{ marginTop: 4 }}>
        People with access to <span className="strong">every report</span> in your workspace. To give someone a single report, use Sharing in that
        report's settings.
      </p>
      <div style={{ marginTop: 20 }}>
        {members === null ? (
          <Loading />
        ) : others.length ? (
          <div className="table-wrap">
            <table className="list mid">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="shrink">Role</th>
                  {role === "iqac_admin" && (
                    <th className="shrink">
                      <span className="sr-only">Remove</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {others.map((m) => (
                  <tr key={m.id}>
                    <td className="truncate" style={{ maxWidth: 260 }}>
                      {m.name ? `${m.name} · ${m.email}` : m.email}
                      {m.department && <span className="muted"> · {m.department}</span>}
                    </td>
                    <td className="shrink">{ROLE_LABELS[m.role] ?? m.role}</td>
                    {role === "iqac_admin" && (
                      <td className="actions">
                        <button className="btn ghost sm" onClick={() => void remove(m)}>
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted inline">
            <Icon name="users" size={14} />
            Only you have access to this workspace.
          </p>
        )}
        <StatusLine msg={msg} />
      </div>
    </section>
  );
}

/** End every session of this account, e.g. after using a shared or lost computer. */
function Sessions() {
  const [msg, setMsg] = useState<Msg>(null);
  const confirm = useConfirm();

  const signOutEverywhere = async () => {
    const ok = await confirm({
      title: "Sign out everywhere?",
      body: "Every browser and device signed in to this account is signed out, including this one. You can sign in again with a new email link.",
      confirmLabel: "Sign out everywhere",
    });
    if (!ok) return;
    try {
      await api.post("/api/v1/auth/logout-all");
      location.href = "/";
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  return (
    <section className="panel">
      <h2>Sessions</h2>
      <p className="small secondary" style={{ marginTop: 4 }}>
        Signed in on a computer you no longer use, or think someone else has your session? Sign out on every device at once.
      </p>
      <button className="btn" style={{ marginTop: 16 }} onClick={() => void signOutEverywhere()}>
        <Icon name="logout" />
        Sign out everywhere
      </button>
      <StatusLine msg={msg} />
    </section>
  );
}

/** Permanently delete the account, its workspace and everything in it. */
function DeleteAccount() {
  const { me } = useApp();
  const [msg, setMsg] = useState<Msg>(null);
  const confirm = useConfirm();

  const deleteAccount = async () => {
    const ok = await confirm({
      title: "Delete your account?",
      body:
        "This permanently deletes your account and your workspace: every report, its data, narratives and evidence files. People you shared " +
        "reports with lose access. This cannot be undone. Type your email address to confirm.",
      confirmLabel: "Delete account",
      danger: true,
      typeToConfirm: me.user.email,
    });
    if (!ok) return;
    try {
      await api.del("/api/v1/me", { confirm_email: me.user.email });
      location.href = "/";
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };

  return (
    <section className="panel danger-zone">
      <div className="row-between">
        <div style={{ flex: "1 1 280px" }}>
          <h2>Delete account</h2>
          <p className="small secondary" style={{ marginTop: 4 }}>
            Removes {me.user.email}, your workspace and every report and evidence file in it. This cannot be undone. Export your reports first if you
            need a copy.
          </p>
        </div>
        <button className="btn danger" onClick={() => void deleteAccount()}>
          <Icon name="trash" />
          Delete my account
        </button>
      </div>
      <StatusLine msg={msg} />
    </section>
  );
}

export function AccountPage() {
  const { me } = useApp();
  return (
    <main className="page narrow">
      <PageHeader title="Account" description={`Signed in as ${me.user.email}`} />
      <div className="stack">
        <Members />
        <Sessions />
        <DeleteAccount />
      </div>
    </main>
  );
}
