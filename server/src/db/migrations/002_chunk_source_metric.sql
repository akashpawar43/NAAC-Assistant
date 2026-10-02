-- Original metric ID printed in the SSR when the segmenter remapped it by title
-- (older framework versions reuse IDs for different questions).
ALTER TABLE ssr_chunk ADD COLUMN source_metric_id text;
