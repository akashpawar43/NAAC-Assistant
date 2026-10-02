-- Collection links: people without an account submit rows for one metric of one report.
-- Only a hash of the link token is stored. Submissions wait for review by the report owner.
CREATE TABLE collection_link (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  cycle_id text NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  metric_id text NOT NULL,
  label text NOT NULL,
  created_by text REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  max_submissions integer NOT NULL DEFAULT 20
);
CREATE INDEX collection_link_cycle ON collection_link (cycle_id);

CREATE TABLE collection_submission (
  id text PRIMARY KEY,
  link_id text NOT NULL REFERENCES collection_link(id) ON DELETE CASCADE,
  cycle_id text NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  metric_id text NOT NULL,
  submitter_name text NOT NULL,
  note text,
  rows jsonb NOT NULL,
  row_count integer NOT NULL,
  -- accepting: claimed by a reviewer while rows are being written (prevents double accept)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepting', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text REFERENCES app_user(id) ON DELETE SET NULL,
  reviewed_at timestamptz
);
CREATE INDEX collection_submission_cycle ON collection_submission (cycle_id, status);
