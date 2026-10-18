import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "../api";
import { Icon } from "./Icon";
import { Notice } from "./ui";

/**
 * A sign-in link opened in a browser other than the one that asked for it lands here instead of
 * signing in straight away. Someone could have sent their own link to trick you into working in
 * their account, so the page says whose account it is and waits for a click.
 */
export function ConfirmLoginPage() {
  // The server puts the token in the fragment, which is never sent to a server; take it out of
  // the address bar (and history) at once.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
  const [email, setEmail] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(token ? null : "This sign-in link is incomplete. Ask for a new one.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    history.replaceState(null, "", location.pathname);
    if (!token) return;
    api
      .post<{ email: string }>("/api/v1/auth/link-info", { token })
      .then((r) => setEmail(r.email))
      .catch(() => setErr("This sign-in link is invalid or has expired. Ask for a new one."));
    api
      .get<Me>("/api/v1/me")
      .then((m) => setCurrent(m.user.email))
      .catch(() => setCurrent(null));
  }, [token]);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/auth/verify", { token });
      location.replace("/");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not sign in");
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <span className="brand">
          <img src="/icon.svg" alt="" />
          NAAC Assistant
        </span>
        <h1>Confirm sign-in</h1>
        {err ? (
          <Notice kind="error">{err}</Notice>
        ) : (
          <div className="stack">
            <p className="lede">
              This link was opened in a different browser from the one it was requested in. Continue only if you asked for it.
            </p>
            {email && (
              <Notice kind="info" icon="mail">
                You will be signed in as <strong>{email}</strong>.
                {current && current !== email && <> You are now signed in as {current}, who will be signed out here.</>}
              </Notice>
            )}
            <button className="btn primary" disabled={!email || busy} onClick={confirm}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Sign in as {email ?? "…"}
            </button>
            <button className="btn ghost" onClick={() => location.replace("/")}>
              <Icon name="arrowLeft" />
              Cancel
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
