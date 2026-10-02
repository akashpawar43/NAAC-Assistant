-- Frameworks are imported (npm run import-frameworks), no longer seeded at start-up. The imported
-- file is kept so every start-up validates it again with the running release's rules.
-- Rows from before this migration have neither: they were validated when they were seeded.
ALTER TABLE framework ADD COLUMN file jsonb;
ALTER TABLE framework ADD COLUMN format_version integer;
