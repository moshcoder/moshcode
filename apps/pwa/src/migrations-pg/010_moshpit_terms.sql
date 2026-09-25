-- Postgres twin of migrations/010_moshpit_terms.sql (converted with `libsql-pg convert-schema`, reviewed).

alter table moshpit_tlds add column if not exists term_started_at bigint;

alter table moshpit_tlds add column if not exists expires_at bigint;

CREATE INDEX IF NOT EXISTS idx_moshpit_tlds_expires ON moshpit_tlds(expires_at);

create table if not exists moshpit_tld_purchases (
  id text PRIMARY KEY,
  tld text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd double precision NOT NULL,
  kind text NOT NULL DEFAULT 'register' CHECK (kind IN ('register','renew')),
  status text NOT NULL,
  years bigint NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  reserved_until bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moshpit_tld_purchases_user ON moshpit_tld_purchases(user_id);

CREATE INDEX IF NOT EXISTS idx_moshpit_tld_purchases_tld ON moshpit_tld_purchases(tld, status);
