-- Postgres twin of migrations/001_init.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists users (
  id text PRIMARY KEY,
  email text UNIQUE,
  password_hash text,
  coinpay_sub text UNIQUE,
  display_name text,
  created_at bigint NOT NULL
);

create table if not exists webauthn_credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

create table if not exists sessions (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

create table if not exists api_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text,
  token_hash text NOT NULL,
  prefix text NOT NULL,
  created_at bigint NOT NULL,
  last_used_at bigint
);

CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

create table if not exists credit_ledger (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta bigint NOT NULL,
  reason text NOT NULL,
  meta text,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);

create table if not exists credit_purchases (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits bigint NOT NULL,
  amount_usd double precision NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at bigint NOT NULL
);

create table if not exists channels (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  target text,
  enabled bigint NOT NULL DEFAULT 1,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

create table if not exists approvals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script text,
  message text NOT NULL,
  context text,
  kind text NOT NULL DEFAULT 'ask',
  status text NOT NULL DEFAULT 'pending',
  response text,
  cap_token text NOT NULL,
  channels text,
  cost bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  submitted_at bigint
);

CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals(user_id);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

create table if not exists _migrations (
  name text PRIMARY KEY,
  applied_at bigint NOT NULL
);
