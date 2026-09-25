-- Postgres twin of migrations/015_moshpit_twins.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_twins (
  tld text NOT NULL,
  label text NOT NULL,
  domain text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','verified')),
  token text NOT NULL,
  expires_at bigint,
  verified_at bigint,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (tld, label)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_moshpit_twins_domain
  ON moshpit_twins(domain) WHERE status = 'verified';

CREATE INDEX IF NOT EXISTS idx_moshpit_twins_user ON moshpit_twins(user_id);

CREATE INDEX IF NOT EXISTS idx_moshpit_twins_expiry ON moshpit_twins(expires_at)
  WHERE status = 'verified';
