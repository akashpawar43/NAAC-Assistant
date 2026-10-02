-- Tenancy and auth -----------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE college (
  id text PRIMARY KEY,
  name text NOT NULL,
  aishe_id text,
  state text,
  institution_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('iqac_admin', 'dept_editor', 'viewer')),
  department text,
  PRIMARY KEY (user_id, college_id)
);

CREATE TABLE login_token (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE user_session (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Framework (seeded from frameworks/*.yaml) --------------------------------------
CREATE TABLE framework (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  definition jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);

-- Cycles and metric data --------------------------------------------------------
CREATE TABLE cycle (
  id text PRIMARY KEY,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  framework_id text NOT NULL REFERENCES framework(id),
  kind text NOT NULL CHECK (kind IN ('AQAR', 'SSR')),
  label text NOT NULL,
  years jsonb NOT NULL,
  previous_cycle_id text REFERENCES cycle(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cycle_college ON cycle (college_id);

CREATE TABLE cycle_input (
  cycle_id text NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  key text NOT NULL,
  year text NOT NULL DEFAULT '',
  value double precision NOT NULL,
  PRIMARY KEY (cycle_id, key, year)
);

CREATE TABLE metric_entry (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES cycle(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  metric_id text NOT NULL,
  status text NOT NULL DEFAULT 'empty',
  assigned_to text REFERENCES app_user(id) ON DELETE SET NULL,
  computed_value double precision,
  computed_points double precision,
  computed_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, metric_id)
);
CREATE INDEX metric_entry_college ON metric_entry (college_id);

CREATE TABLE metric_row (
  id text PRIMARY KEY,
  entry_id text NOT NULL REFERENCES metric_entry(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  idempotency_key text,
  created_by text REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, idempotency_key)
);
CREATE INDEX metric_row_entry ON metric_row (entry_id);

CREATE TABLE narrative_field (
  entry_id text NOT NULL REFERENCES metric_entry(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  text text NOT NULL DEFAULT '',
  updated_by text REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, field_key)
);

CREATE TABLE evidence (
  id text PRIMARY KEY,
  entry_id text NOT NULL REFERENCES metric_entry(id) ON DELETE CASCADE,
  college_id text NOT NULL REFERENCES college(id) ON DELETE CASCADE,
  evidence_key text NOT NULL,
  file_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  bytes integer NOT NULL,
  sha256 text NOT NULL,
  uploaded_by text REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_entry ON evidence (entry_id);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  college_id text,
  user_id text,
  action text NOT NULL,
  target text,
  detail jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_college ON audit_log (college_id, at DESC);

-- Help content (metric explainers, FAQ, manual sections) ------------------------
CREATE TABLE help_article (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('explainer', 'faq', 'manual')),
  framework_id text,
  metric_id text,
  title text NOT NULL,
  body text NOT NULL,
  source text,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(metric_id, '') || ' ' || title), 'A') ||
    setweight(to_tsvector('english', body), 'B')
  ) STORED
);
CREATE INDEX help_article_tsv ON help_article USING gin (tsv);
CREATE INDEX help_article_metric ON help_article (metric_id);

-- Shared, read-only NAAC corpus (loaded from corpus/out) ---------------------------
CREATE TABLE naac_college (
  key text PRIMARY KEY,               -- AISHE ID, or a name-based key when missing
  aishe_id text,
  name text NOT NULL,
  state text,
  address text,
  institution_type text               -- University | Affiliated College | Autonomous College | Standalone
);
CREATE INDEX naac_college_name_trgm ON naac_college USING gin (name gin_trgm_ops);
CREATE INDEX naac_college_state_type ON naac_college (state, institution_type);

CREATE TABLE ssr_doc (
  sha256 text PRIMARY KEY,
  kind text NOT NULL,
  college_key text NOT NULL REFERENCES naac_college(key),
  assessment_id integer NOT NULL,
  other_assessment_ids jsonb NOT NULL DEFAULT '[]',
  grade text,
  grade_rank integer NOT NULL DEFAULT 0,
  iiqa_date date,
  declaration_date date,
  source_url text,
  bytes integer,
  page_count integer,
  is_raf boolean NOT NULL DEFAULT false,
  is_latest boolean NOT NULL DEFAULT false,
  raf_markers integer NOT NULL DEFAULT 0,
  extract_status text NOT NULL,
  converter_version text,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ssr_doc_college ON ssr_doc (college_key);
CREATE INDEX ssr_doc_assessment ON ssr_doc (assessment_id);

CREATE TABLE grade_sheet (
  assessment_id integer PRIMARY KEY,
  aishe_id text,
  institution_type text,
  cycle integer,
  grade text,
  cgpa double precision
);

CREATE TABLE ki_score (
  assessment_id integer NOT NULL,
  ki_id text NOT NULL,
  criterion text NOT NULL,
  title text,
  weight double precision NOT NULL,
  points double precision NOT NULL,
  gpa double precision,
  PRIMARY KEY (assessment_id, ki_id)
);

CREATE TABLE criterion_score (
  assessment_id integer NOT NULL,
  criterion text NOT NULL,
  weight double precision NOT NULL,
  points double precision NOT NULL,
  gpa double precision,
  PRIMARY KEY (assessment_id, criterion)
);

CREATE TABLE ssr_page (
  doc_sha text NOT NULL REFERENCES ssr_doc(sha256) ON DELETE CASCADE,
  page_no integer NOT NULL,
  text text NOT NULL,
  md text,
  has_table boolean NOT NULL DEFAULT false,
  is_scanned boolean NOT NULL DEFAULT false,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 100000))) STORED,
  PRIMARY KEY (doc_sha, page_no)
);
CREATE INDEX ssr_page_tsv ON ssr_page USING gin (tsv);

CREATE TABLE ssr_chunk (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_sha text NOT NULL REFERENCES ssr_doc(sha256) ON DELETE CASCADE,
  metric_id text NOT NULL,
  title text,
  page_from integer NOT NULL,
  page_to integer NOT NULL,
  text text NOT NULL,
  response_value double precision,
  response_text text,
  sub_values jsonb NOT NULL DEFAULT '{}',
  confidence real NOT NULL,
  framework text,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', left(text, 100000)), 'B')
  ) STORED
);
CREATE INDEX ssr_chunk_metric ON ssr_chunk (metric_id, confidence);
CREATE INDEX ssr_chunk_doc ON ssr_chunk (doc_sha);
CREATE INDEX ssr_chunk_tsv ON ssr_chunk USING gin (tsv);

CREATE TABLE ssr_table (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_sha text NOT NULL REFERENCES ssr_doc(sha256) ON DELETE CASCADE,
  page_no integer NOT NULL,
  metric_id text,
  columns jsonb NOT NULL,
  rows jsonb NOT NULL
);
CREATE INDEX ssr_table_doc_metric ON ssr_table (doc_sha, metric_id);
