-- Short-lived authorization codes for the `moshcode login` CLI flow (PKCE).
CREATE TABLE IF NOT EXISTS cli_auth_codes (
  code           TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  name           TEXT,
  used           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
