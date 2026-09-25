-- Postgres twin of migrations/007_moshpit_names.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_names (
  tld text NOT NULL,
  label text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target text,
  created_at bigint NOT NULL,
  PRIMARY KEY (tld, label)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_names_user ON moshpit_names(user_id);

CREATE INDEX IF NOT EXISTS idx_moshpit_names_tld ON moshpit_names(tld);
