CREATE TABLE github_links (
 account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 github_id text NOT NULL UNIQUE CHECK(github_id ~ '^[1-9][0-9]{0,19}$'),
 login varchar(100) NOT NULL, linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_credentials (
 account_id uuid PRIMARY KEY REFERENCES github_links(account_id) ON DELETE CASCADE,
 token_ciphertext text NOT NULL, granted_scopes text NOT NULL,
 grant_version uuid NOT NULL, expires_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_oauth_attempts (
 state_hash text PRIMARY KEY, session_hash text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('link','login','repositories')),
 account_id uuid REFERENCES accounts(id) ON DELETE CASCADE, auth_version integer,
 verifier_ciphertext text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((purpose='login' AND account_id IS NULL AND auth_version IS NULL) OR
       (purpose<>'login' AND account_id IS NOT NULL AND auth_version IS NOT NULL))
);
CREATE INDEX github_attempt_expiry ON github_oauth_attempts(expires_at);
CREATE INDEX github_attempt_session ON github_oauth_attempts(session_hash,purpose);
