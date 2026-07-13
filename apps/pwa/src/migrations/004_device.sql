-- Device-code login (RFC 8628 style) for headless / CI `moshcode login --device`.
CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,          -- secret the CLI polls with
  user_code   TEXT NOT NULL UNIQUE,      -- short human code (XXXX-XXXX)
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE, -- set on approval
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | claimed
  name        TEXT,
  interval_s  INTEGER NOT NULL DEFAULT 5,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_user_code ON device_codes(user_code);
