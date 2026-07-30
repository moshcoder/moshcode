-- Live CLI session mirror (`/sessions`): a running mosh instance registers
-- itself, streams what it prints, and drains commands typed on the web.
CREATE TABLE IF NOT EXISTS cli_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT,                          -- "mosh @ dev"
  host         TEXT,
  version      TEXT,
  cwd          TEXT,
  engine       TEXT,                          -- engine currently handed the terminal, if any
  status       TEXT NOT NULL DEFAULT 'live',  -- live | ended
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_user ON cli_sessions(user_id, last_seen_at DESC);

-- Append-only output log. Doubles as the scrollback a browser replays on
-- connect, so a page opened mid-session isn't staring at an empty terminal.
CREATE TABLE IF NOT EXISTS session_output (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES cli_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  chunk      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_output ON session_output(session_id, seq);

-- Commands sent from the web, claimed exactly once by the CLI that owns the
-- session. Same single-claim discipline as cli_auth_codes: the UPDATE is the
-- lock, so two concurrent polls can't run one command twice.
CREATE TABLE IF NOT EXISTS session_commands (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cli_sessions(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued', -- queued | claimed | done
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_commands ON session_commands(session_id, status, created_at);
