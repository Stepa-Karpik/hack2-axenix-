CREATE TABLE account_avatars (
    account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    version varchar(64) NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
    image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 2097152)
);
