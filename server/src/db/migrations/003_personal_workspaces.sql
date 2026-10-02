-- Personal workspaces: anyone can sign up; each user gets a private workspace on first sign-in.
-- The `college` table now holds workspaces (the tenant boundary). `membership` stays so a
-- workspace can later be shared with other users; today each workspace has only its owner.
ALTER TABLE college ADD COLUMN owner_id text REFERENCES app_user(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX college_one_personal_workspace ON college (owner_id) WHERE owner_id IS NOT NULL;

ALTER TABLE app_user ADD COLUMN verified_at timestamptz;

-- The institution a report is about is a property of the report, not of the account.
ALTER TABLE cycle ADD COLUMN college_name text;
ALTER TABLE cycle ADD COLUMN state text;
ALTER TABLE cycle ADD COLUMN institution_type text;
ALTER TABLE cycle ADD COLUMN aishe_id text;
UPDATE cycle c SET college_name = w.name, state = w.state, institution_type = w.institution_type, aishe_id = w.aishe_id
FROM college w WHERE w.id = c.college_id;
UPDATE cycle SET college_name = 'Untitled college' WHERE college_name IS NULL;
ALTER TABLE cycle ALTER COLUMN college_name SET NOT NULL;
