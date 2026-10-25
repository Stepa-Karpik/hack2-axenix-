ALTER TABLE accounts ALTER COLUMN username TYPE varchar(39);
ALTER TABLE accounts ADD COLUMN auth_method text NOT NULL DEFAULT 'password';
ALTER TABLE accounts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT account_auth_method CHECK (
 (auth_method='password' AND email IS NOT NULL AND password_hash IS NOT NULL) OR
 (auth_method='github' AND email IS NULL AND password_hash IS NULL AND email_verified=false)
);
CREATE TABLE github_signup_claims (
 session_hash text PRIMARY KEY,
 github_id text NOT NULL CHECK(github_id ~ '^[1-9][0-9]{0,19}$'),
 login varchar(100) NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_signup_expiry ON github_signup_claims(expires_at);
