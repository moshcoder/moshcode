-- Cloud sync for the pit's settings (`/save` and `/load` in moshcode).
--
-- One row per save, not one row per account, because the interesting failure is
-- a good configuration replaced by a bad one: a person runs `/save` from the
-- machine they were mid-experiment on and the aliases they had built up for a
-- year are now the thing every other machine pulls down. Keeping the last few
-- revisions makes that recoverable from the web without a backup story.
--
-- `revision` is per-user and monotonic, and it is also the concurrency token:
-- `/save` sends the revision it last agreed on and the write is refused if the
-- account has moved past it, so two machines saving cannot silently erase one
-- another.
CREATE TABLE IF NOT EXISTS settings_snapshots (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL,
  digest     TEXT NOT NULL,               -- sha256 over the file names + contents
  host       TEXT,                        -- the machine that saved it
  version    TEXT,                        -- its moshcode version
  size       INTEGER NOT NULL,            -- bytes of `body`
  body       TEXT NOT NULL,               -- the snapshot, as the CLI sent it
  created_at INTEGER NOT NULL
);

-- The unique index is load-bearing, not housekeeping: the insert picks its own
-- revision with MAX(revision) + 1, and against a network database two saves in
-- flight at once can both read the same maximum. This is what turns the second
-- one into an error instead of a duplicate revision that `/load` would resolve
-- arbitrarily.
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_snapshots_revision
  ON settings_snapshots(user_id, revision);
