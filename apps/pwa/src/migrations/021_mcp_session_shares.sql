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

ALTER TABLE device_codes ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE device_codes ADD COLUMN client_id TEXT;
ALTER TABLE device_codes ADD COLUMN share_id TEXT;
ALTER TABLE device_codes ADD COLUMN resource TEXT;
ALTER TABLE device_codes ADD COLUMN scope TEXT;
CREATE INDEX IF NOT EXISTS idx_device_kind_code ON device_codes(kind, device_code);
