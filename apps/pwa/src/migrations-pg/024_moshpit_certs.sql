-- Postgres twin of migrations/024_moshpit_certs.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_name_certs (
  serial text PRIMARY KEY,
  tld text NOT NULL,
  label text NOT NULL,
  pin text NOT NULL,
  cert text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  not_before bigint NOT NULL,
  not_after bigint NOT NULL,
  issued_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moshpit_name_certs_name ON moshpit_name_certs(tld, label, issued_at);

CREATE INDEX IF NOT EXISTS idx_moshpit_name_certs_user ON moshpit_name_certs(user_id);
