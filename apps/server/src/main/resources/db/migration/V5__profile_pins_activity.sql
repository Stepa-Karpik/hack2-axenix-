ALTER TABLE audit_events ADD COLUMN actor_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX audit_actor_activity ON audit_events(actor_id,created_at DESC,project_id) WHERE actor_id IS NOT NULL AND event='head_changed';
CREATE TABLE profile_pins (
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 position smallint NOT NULL CHECK(position BETWEEN 0 AND 5),
 PRIMARY KEY(account_id,project_id), UNIQUE(account_id,position)
);
