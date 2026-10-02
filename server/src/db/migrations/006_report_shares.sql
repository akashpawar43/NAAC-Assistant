-- Sharing one report with another account. A share never grants access to the owner's
-- workspace or other reports; the access check reads it only for this cycle.
CREATE TABLE report_share (
  cycle_id text NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by text REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, user_id)
);
CREATE INDEX report_share_user ON report_share (user_id);
