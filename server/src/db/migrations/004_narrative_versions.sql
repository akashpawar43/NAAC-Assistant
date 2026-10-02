-- Narrative history: a snapshot of all of a metric's narrative fields per editing session.
CREATE TABLE narrative_version (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id text NOT NULL REFERENCES metric_entry(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  fields jsonb NOT NULL,
  saved_by text REFERENCES app_user(id) ON DELETE SET NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX narrative_version_entry ON narrative_version (entry_id, saved_at DESC);
