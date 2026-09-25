-- Postgres twin of migrations/012_settings_sync.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists settings_snapshots (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  digest text NOT NULL,
  host text,
  version text,
  size bigint NOT NULL,
  body text NOT NULL,
  created_at bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_snapshots_revision
  ON settings_snapshots(user_id, revision);
