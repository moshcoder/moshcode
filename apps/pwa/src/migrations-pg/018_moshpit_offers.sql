-- Postgres twin of migrations/018_moshpit_offers.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_offers (
  id text PRIMARY KEY,
  tld text NOT NULL,
  label text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('buy','lease')),
  amount_usd double precision NOT NULL,
  lease_months bigint,
  offerer_email text NOT NULL,
  offerer_user_id text REFERENCES users(id) ON DELETE SET NULL,
  message text,
  holder_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('unverified','open','countered','accepted','settling','paid','refund_due','rejected','withdrawn','expired')),
  verify_token text NOT NULL UNIQUE,
  verified_at bigint,
  counter_amount_usd double precision,
  counter_months bigint,
  countered_at bigint,
  payment_id text UNIQUE,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moshpit_offers_holder ON moshpit_offers(holder_user_id, status);

CREATE INDEX IF NOT EXISTS idx_moshpit_offers_name ON moshpit_offers(tld, label, status);

CREATE INDEX IF NOT EXISTS idx_moshpit_offers_offerer ON moshpit_offers(offerer_email, created_at);

CREATE INDEX IF NOT EXISTS idx_moshpit_offers_expiry ON moshpit_offers(expires_at)
  WHERE status IN ('unverified','open','countered');

create table if not exists moshpit_leases (
  tld text NOT NULL,
  label text NOT NULL,
  lessee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  holder_user_id text NOT NULL,
  offer_id text NOT NULL REFERENCES moshpit_offers(id),
  months bigint NOT NULL,
  amount_usd double precision NOT NULL,
  starts_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (tld, label)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_leases_lessee ON moshpit_leases(lessee_user_id);

CREATE INDEX IF NOT EXISTS idx_moshpit_leases_expiry ON moshpit_leases(expires_at);

alter table moshpit_names add column if not exists leased_to text;

alter table moshpit_names add column if not exists leased_until bigint;

alter table moshpit_leases add column if not exists reverted_at bigint;

CREATE INDEX IF NOT EXISTS idx_moshpit_leases_unreverted ON moshpit_leases(expires_at)
  WHERE reverted_at IS NULL;
