-- Postgres twin of migrations/011_moshpit_records.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_records (
  tld text NOT NULL,
  label text NOT NULL,
  type text NOT NULL CHECK (type IN ('AAAA','CNAME','TXT','MX')),
  value text NOT NULL,
  ttl bigint NOT NULL,
  priority bigint,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (tld, label, type, value)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_records_name ON moshpit_records(tld, label);

CREATE INDEX IF NOT EXISTS idx_moshpit_records_user ON moshpit_records(user_id);
