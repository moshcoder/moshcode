CREATE TABLE IF NOT EXISTS mcp_shares (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES cli_sessions(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT,
  scopes       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_shares_user ON mcp_shares(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_shares_session ON mcp_shares(session_id, status, expires_at);

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT,
  redirect_uris  TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  share_id       TEXT NOT NULL REFERENCES mcp_shares(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  share_id     TEXT NOT NULL REFERENCES mcp_shares(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource     TEXT NOT NULL,
  scope        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_access_share ON mcp_access_tokens(share_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  share_id    TEXT NOT NULL REFERENCES mcp_shares(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  rotated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_refresh_share ON mcp_refresh_tokens(share_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  share_id   TEXT,
  client_id  TEXT,
  event      TEXT NOT NULL,
  decision   TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_user ON mcp_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_share ON mcp_audit_log(share_id, created_at DESC);

ALTER TABLE device_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE device_codes ADD COLUMN client_id TEXT;
ALTER TABLE device_codes ADD COLUMN share_id TEXT;
ALTER TABLE device_codes ADD COLUMN resource TEXT;
ALTER TABLE device_codes ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_device_kind_code ON device_codes(kind, device_code);
