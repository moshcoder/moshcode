-- The Moshpit TLD namespace: `.moshpit`, `.eggs`, `.whatever`.
--
-- Ported from the moshcoding app so that a TLD is owned by a moshcode account
-- (`users`) -- the same identity `moshcode login` establishes -- rather than by
-- a second, unrelated account table.

-- The directory. This is a cache; moshpit_tld_log below is the record.
CREATE TABLE IF NOT EXISTS moshpit_tlds (
  tld         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_email TEXT,
  owner_key   TEXT,
  -- The TLD this one points at, or null when it stands on its own.
  alias_of    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moshpit_tlds_user ON moshpit_tlds(user_id);
CREATE INDEX IF NOT EXISTS idx_moshpit_tlds_alias ON moshpit_tlds(alias_of);

-- Append-only allocation log: the answer to "who claimed it first". Allocating
-- a unique name is an ordering problem, and an ordered log is checkable rather
-- than trusted, so the directory can be mirrored without a mirror being able to
-- forge or seize a name.
CREATE TABLE IF NOT EXISTS moshpit_tld_log (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  tld     TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moshpit_log_tld ON moshpit_tld_log(tld);

-- Names held back from their TLD's alias, so `tonyrobbins.financewizards`
-- survives `.financewizards` being pointed at `.financialadvice`.
CREATE TABLE IF NOT EXISTS moshpit_alias_exempt (
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tld, label)
);
