-- Postgres twin of migrations/022_mcp_grants_audit.sql (converted with `libsql-pg convert-schema`, reviewed).

alter table mcp_oauth_tokens add column if not exists family_id text;

create table if not exists mcp_oauth_grants (
  id text PRIMARY KEY,
  created_at bigint NOT NULL,
  revoked_at bigint
);

UPDATE mcp_oauth_tokens SET family_id = user_id || ':' || client_id || ':' || resource || ':' || COALESCE(session_id,'');

INSERT INTO mcp_oauth_grants (id,created_at) SELECT family_id,MIN(created_at) FROM mcp_oauth_tokens GROUP BY family_id ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_mcp_token_family ON mcp_oauth_tokens(family_id);

alter table device_codes add column if not exists last_polled_at bigint;

alter table session_commands add column if not exists mcp_share_id text REFERENCES mcp_shares(id);

alter table session_commands add column if not exists mcp_grant_id text REFERENCES mcp_oauth_grants(id);

CREATE INDEX IF NOT EXISTS idx_session_commands_mcp_share ON session_commands(mcp_share_id,status);

CREATE INDEX IF NOT EXISTS idx_session_commands_mcp_grant ON session_commands(mcp_grant_id,status);

UPDATE mcp_shares SET scopes=REPLACE(scopes,'sessions:control','sessions:write sessions:approve sessions:cancel');

UPDATE mcp_oauth_tokens SET scope=REPLACE(scope,'sessions:control','sessions:write sessions:approve sessions:cancel') WHERE resource LIKE '%/api/v1/mcp/%';

UPDATE mcp_oauth_codes SET scope=REPLACE(scope,'sessions:control','sessions:write sessions:approve sessions:cancel') WHERE resource LIKE '%/api/v1/mcp/%';

UPDATE device_codes SET scope=REPLACE(scope,'sessions:control','sessions:write sessions:approve sessions:cancel') WHERE kind='mcp';

create table if not exists mcp_audit_events (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  client_id text,
  share_id text,
  session_id text,
  action text NOT NULL,
  outcome text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_share ON mcp_audit_events(share_id,created_at);
