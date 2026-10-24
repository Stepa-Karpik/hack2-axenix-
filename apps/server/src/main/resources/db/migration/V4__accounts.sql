CREATE TABLE accounts (
 id uuid PRIMARY KEY, username varchar(32) NOT NULL, email varchar(254) NOT NULL,
 password_hash text NOT NULL, email_verified boolean NOT NULL DEFAULT false,
 display_name varchar(80) NOT NULL, bio varchar(1000) NOT NULL DEFAULT '',
 auth_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_username ON accounts(lower(username));
CREATE UNIQUE INDEX account_email ON accounts(lower(email));
CREATE TABLE account_tokens (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
 kind text NOT NULL CHECK(kind IN ('verify','reset')), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE friend_requests (
 id uuid PRIMARY KEY, sender_id uuid NOT NULL REFERENCES accounts(id),
 recipient_id uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(sender_id<>recipient_id), UNIQUE(sender_id,recipient_id)
);
CREATE UNIQUE INDEX friend_request_pair ON friend_requests(least(sender_id,recipient_id),greatest(sender_id,recipient_id));
CREATE TABLE friendships (
 first_id uuid NOT NULL REFERENCES accounts(id), second_id uuid NOT NULL REFERENCES accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(first_id,second_id), CHECK(first_id<second_id)
);
ALTER TABLE projects ADD COLUMN owner_id uuid REFERENCES accounts(id);
ALTER TABLE projects ADD COLUMN visibility text NOT NULL DEFAULT 'legacy_local'
 CHECK(visibility IN ('legacy_local','private','public'));
ALTER TABLE projects ADD CONSTRAINT project_ownership CHECK
 ((owner_id IS NULL AND visibility='legacy_local') OR (owner_id IS NOT NULL AND visibility IN ('private','public')));
CREATE TABLE project_members (
 project_id uuid NOT NULL REFERENCES projects(id), account_id uuid NOT NULL REFERENCES accounts(id),
 role text NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(project_id,account_id)
);
