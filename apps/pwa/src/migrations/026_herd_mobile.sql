-- The herd in your pocket (PRD 0020). A box running `moshcode herd relay`
-- publishes its herd here; the phone at /m reads it and queues commands back.
-- Screens are never stored: they pass through memory to whoever is watching.
CREATE TABLE IF NOT EXISTS herd_machines (
  id           TEXT PRIMARY KEY,              -- the box's own machine id (herd/machine-id)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                 -- user@host
  platform     TEXT,
  version      TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_herd_machines_user ON herd_machines(user_id, last_seen_at DESC);

-- One row per session on a machine, replaced wholesale on every publish.
CREATE TABLE IF NOT EXISTS herd_sessions (
  machine_id   TEXT NOT NULL REFERENCES herd_machines(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  engine       TEXT,
  state        TEXT NOT NULL,
  blocked_on   TEXT,
  confidence   TEXT,
  cwd          TEXT,
  kind         TEXT,
  last_lines   TEXT,                          -- JSON array
  since        INTEGER,                       -- when the current state began, box clock
  blocked_at   INTEGER,                       -- = since while blocked; what an approve must carry
  approval     TEXT,                          -- JSON {allowAll} while a permission dialog is up
  action_token TEXT,                          -- one-time capability for the push buttons
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (machine_id, name)
);

-- Commands from the phone, claimed exactly once by the relay that owns the
-- machine. Same single-claim discipline as session_commands.
CREATE TABLE IF NOT EXISTS herd_commands (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES herd_machines(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session     TEXT NOT NULL,
  kind        TEXT NOT NULL,                  -- approve | prompt | keys | open-stream
  args        TEXT,                           -- JSON
  status      TEXT NOT NULL DEFAULT 'queued', -- queued | claimed | done | failed | stale
  result      TEXT,                           -- JSON from the relay
  via         TEXT,                           -- app | push — for the "answered from a phone" metric
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_herd_commands_machine ON herd_commands(machine_id, status, created_at);
