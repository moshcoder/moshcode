-- Remote MCP OAuth clients and credentials.
--
-- Access/refresh tokens and authorization codes are stored only as SHA-256
-- hashes. A database read is therefore not enough to impersonate a connected
-- MCP client.

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id        TEXT PRIMARY KEY,
  client_name      TEXT NOT NULL,
  redirect_uris    TEXT NOT NULL,
  application_type TEXT NOT NULL DEFAULT 'web',
  client_uri       TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  session_id     TEXT REFERENCES cli_sessions(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  token_type  TEXT NOT NULL, -- access | refresh
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  scope       TEXT NOT NULL,
  resource    TEXT NOT NULL,
  session_id  TEXT REFERENCES cli_sessions(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user ON mcp_oauth_tokens(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expiry ON mcp_oauth_tokens(expires_at);
