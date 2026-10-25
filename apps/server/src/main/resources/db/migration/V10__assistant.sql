CREATE TABLE assistant_conversations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 title varchar(100) NOT NULL DEFAULT 'Новый диалог', created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_account_history ON assistant_conversations(account_id,updated_at DESC);
CREATE TABLE assistant_messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL CHECK(length(content)<=16000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_message_history ON assistant_messages(conversation_id,created_at,id);
CREATE TABLE assistant_actions (
 id uuid PRIMARY KEY, message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
 type text NOT NULL, args jsonb NOT NULL, risk text NOT NULL CHECK(risk IN ('none','confirm','typed')),
 label text NOT NULL, description text NOT NULL, status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','completed','cancelled')), claimed_at timestamptz,
 binding jsonb NOT NULL DEFAULT '{}', result text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assistant_usage (
 account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 busy_token uuid, busy_until timestamptz, minute_start timestamptz NOT NULL DEFAULT now(),
 minute_count integer NOT NULL DEFAULT 0, day_start date NOT NULL DEFAULT current_date,
 day_count integer NOT NULL DEFAULT 0
);
