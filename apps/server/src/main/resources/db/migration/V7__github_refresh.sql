ALTER TABLE github_credentials
 ADD COLUMN refresh_ciphertext text,
 ADD COLUMN refresh_expires_at timestamptz,
 ADD COLUMN token_version uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN refresh_owner uuid,
 ADD COLUMN refresh_lease_until timestamptz,
 ADD COLUMN refresh_reconnect boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT github_refresh_pair CHECK ((refresh_ciphertext IS NULL)=(refresh_expires_at IS NULL)),
 ADD CONSTRAINT github_refresh_claim CHECK ((refresh_owner IS NULL)=(refresh_lease_until IS NULL));
