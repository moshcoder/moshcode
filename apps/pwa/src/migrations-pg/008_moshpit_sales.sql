-- Postgres twin of migrations/008_moshpit_sales.sql (converted with `libsql-pg convert-schema`, reviewed).

alter table moshpit_tlds add column if not exists price_usd double precision;

create table if not exists moshpit_name_purchases (
  id text PRIMARY KEY,
  tld text NOT NULL,
  label text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd double precision NOT NULL,
  status text NOT NULL,
  created_at bigint NOT NULL,
  reserved_until bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_name_purchases_name ON moshpit_name_purchases(tld, label);

CREATE INDEX IF NOT EXISTS idx_name_purchases_user ON moshpit_name_purchases(user_id);
