-- Security hardening (security-audit/REMEDIATION_LOG.md).
-- Sign-in links remember a hash of a cookie set in the browser that asked for them, so opening a
-- link elsewhere needs an explicit confirmation (login CSRF, link scanners).
ALTER TABLE login_token ADD COLUMN nonce_hash text;
ALTER TABLE login_token ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX login_token_user ON login_token (user_id);
-- Idle timeout for sessions.
ALTER TABLE user_session ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX user_session_user ON user_session (user_id);
-- Per-account counters (share notices) read the audit log by user.
CREATE INDEX audit_log_user_action ON audit_log (user_id, action, at DESC);
