-- Postgres twin of migrations/021_mcp_session_shares.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists mcp_shares (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES cli_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text,
  scopes text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  last_used_at bigint
);

CREATE INDEX IF NOT EXISTS idx_mcp_shares_user ON mcp_shares(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_shares_session ON mcp_shares(session_id, status, expires_at);

alter table device_codes add column if not exists kind text NOT NULL DEFAULT 'cli';

alter table device_codes add column if not exists client_id text;

alter table device_codes add column if not exists share_id text;

alter table device_codes add column if not exists resource text;

alter table device_codes add column if not exists scope text;

CREATE INDEX IF NOT EXISTS idx_device_kind_code ON device_codes(kind, device_code);
