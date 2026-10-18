import { useState } from "react";
import { api, ApiError } from "../api";
import { Icon } from "./Icon";
import { Notice } from "./ui";

/**
 * Messages for the `?login_error=` codes the server redirects with. Only known codes are shown, in
 * our own words: the query string is attacker-controllable, so its text is never displayed.
 */
const LOGIN_ERRORS: Record<string, string> = {
  invalid_link: "This sign-in link is invalid or has expired. Ask for a new one.",
};

function loginErrorFromUrl(): string | null {
  const code = new URLSearchParams(location.search).get("login_error");
  if (code === null) return null;
  return Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code] : "Sign-in did not work. Ask for a new link.";
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(loginErrorFromUrl);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ message: string }>("/api/v1/auth/magic-link", { email });
      setMsg(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not send the link");
    } finally {
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
        <h1>{msg ? "Check your inbox" : "Sign in"}</h1>
        <p className="lede">
          {msg
            ? "Open the link on this device to continue."
            : "Prepare your AQAR and SSR metric by metric, compare with accredited colleges, and export to Excel, Word or PDF."}
        </p>
        {msg ? (
          <div className="stack">
            <Notice kind="success" icon="mail">
              {msg}
            </Notice>
            <button className="btn ghost" onClick={() => setMsg(null)}>
              <Icon name="arrowLeft" />
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            <label>
              Work email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                autoComplete="email"
                placeholder="you@college.edu.in"
              />
              <span className="hint">New here? Your account is created when you open the link we send. No password needed.</span>
            </label>
            <button className="btn primary" disabled={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Sending link…" : "Continue with email"}
            </button>
          </form>
        )}
        {err && (
          <div style={{ marginTop: 16 }}>
            <Notice kind="error">{err}</Notice>
          </div>
        )}
      </div>
    </main>
  );
}
