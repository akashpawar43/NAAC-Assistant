-- Metrics in different frameworks that ask the same question (frameworks/metric_equivalence.json,
-- built by `python -m naac_corpus equivalence`). Peer examples match on these, not on bare IDs,
-- because IDs mean different things across frameworks.
CREATE TABLE metric_equivalence (
  a_framework text NOT NULL,
  a_metric text NOT NULL,
  b_framework text NOT NULL,
  b_metric text NOT NULL,
  score real NOT NULL,
  PRIMARY KEY (a_framework, a_metric, b_framework, b_metric)
);
CREATE INDEX metric_equivalence_b ON metric_equivalence (b_framework, b_metric);
CREATE INDEX ssr_chunk_framework_metric ON ssr_chunk (framework, metric_id, confidence);
