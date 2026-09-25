-- Postgres twin of migrations/020_mcp_oauth.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists mcp_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris text NOT NULL,
  application_type text NOT NULL DEFAULT 'web',
  client_uri text,
  created_at bigint NOT NULL
);

create table if not exists mcp_oauth_codes (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  session_id text REFERENCES cli_sessions(id) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);

create table if not exists mcp_oauth_tokens (
  token_hash text PRIMARY KEY,
  token_type text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  scope text NOT NULL,
  resource text NOT NULL,
  session_id text REFERENCES cli_sessions(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user ON mcp_oauth_tokens(user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expiry ON mcp_oauth_tokens(expires_at);
