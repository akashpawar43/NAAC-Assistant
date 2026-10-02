-- Rows saved in one transaction share created_at, so ordering by it (with a random id as the
-- tie-break) shuffled imported rows. `seq` records insertion order exactly.
ALTER TABLE metric_row ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX metric_row_entry_seq ON metric_row (entry_id, seq);
