-- app.moshcode.sh schema (libSQL / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  password_hash TEXT,                 -- null when the user only uses passkey / coinpay
  coinpay_sub   TEXT UNIQUE,          -- subject from "sign in with CoinPay"
  display_name  TEXT,
  created_at    INTEGER NOT NULL
);

-- WebAuthn / passkey credentials
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            TEXT PRIMARY KEY,     -- credential id (base64url)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,        -- base64url COSE public key
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                 -- json array
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- server-side sessions (revocable cookie tokens)
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
-- in-flight auth ceremonies (webauthn challenge, oauth pkce) live in signed cookies, not here.

-- API keys for the CLI / CI to ingest + poll approvals
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT,
  token_hash  TEXT NOT NULL,          -- sha256 of the key; prefix stored on the row for display
  prefix      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

-- prepaid usage-credit ledger. balance = SUM(delta).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,       -- +credit / -debit
  reason      TEXT NOT NULL,
  meta        TEXT,                    -- json
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id);

-- CoinPay top-up payments awaiting confirmation
CREATE TABLE IF NOT EXISTS credit_purchases (
  id           TEXT PRIMARY KEY,      -- coinpay payment id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits      INTEGER NOT NULL,
  amount_usd   REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL
);

-- per-user notification channels
CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- push | email | slack | telegram | sms | webhook
  target      TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);

-- the human-in-the-loop approvals the CLI ingests and polls
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script       TEXT,
  message      TEXT NOT NULL,
  context      TEXT,                  -- json
  kind         TEXT NOT NULL DEFAULT 'ask', -- ask | notify
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | submitted | killed
  response     TEXT,
  cap_token    TEXT NOT NULL,         -- capability token embedded in the link
  channels     TEXT,                  -- json array of kinds it was delivered to
  cost         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals(user_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
