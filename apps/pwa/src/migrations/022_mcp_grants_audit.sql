ALTER TABLE mcp_oauth_tokens ADD COLUMN family_id TEXT;
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- Previous rotations did not retain lineage. Conservatively group existing
-- tokens for the same owner/client/resource/session so replay of an older
-- consumed refresh also revokes the currently active replacement.
UPDATE mcp_oauth_tokens SET family_id = user_id || ':' || client_id || ':' || resource || ':' || COALESCE(session_id,'');
INSERT OR IGNORE INTO mcp_oauth_grants (id,created_at) SELECT family_id,MIN(created_at) FROM mcp_oauth_tokens GROUP BY family_id;
CREATE INDEX IF NOT EXISTS idx_mcp_token_family ON mcp_oauth_tokens(family_id);

ALTER TABLE device_codes ADD COLUMN last_polled_at INTEGER;
ALTER TABLE session_commands ADD COLUMN mcp_share_id TEXT REFERENCES mcp_shares(id);
ALTER TABLE session_commands ADD COLUMN mcp_grant_id TEXT REFERENCES mcp_oauth_grants(id);
CREATE INDEX IF NOT EXISTS idx_session_commands_mcp_share ON session_commands(mcp_share_id,status);
CREATE INDEX IF NOT EXISTS idx_session_commands_mcp_grant ON session_commands(mcp_grant_id,status);

-- Preserve existing broad consent; new shares require explicit granular scopes.
UPDATE mcp_shares SET scopes=REPLACE(scopes,'sessions:control','sessions:write sessions:approve sessions:cancel');
UPDATE mcp_oauth_tokens SET scope=REPLACE(scope,'sessions:control','sessions:write sessions:approve sessions:cancel') WHERE resource LIKE '%/api/v1/mcp/%';
UPDATE mcp_oauth_codes SET scope=REPLACE(scope,'sessions:control','sessions:write sessions:approve sessions:cancel') WHERE resource LIKE '%/api/v1/mcp/%';
UPDATE device_codes SET scope=REPLACE(scope,'sessions:control','sessions:write sessions:approve sessions:cancel') WHERE kind='mcp';

-- Deliberately no arguments, command text, answer bodies, output or token data.
CREATE TABLE IF NOT EXISTS mcp_audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT,
  share_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_share ON mcp_audit_events(share_id,created_at);
