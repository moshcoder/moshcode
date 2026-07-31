-- Names under a TLD: `fuck.yeah`, `chovy.oranges`, `profullstack.agent`.
--
-- The TLD registry only ever recorded the TLD itself. Holding `.eggs` gave you
-- the namespace, but there was nowhere to say that `blue.eggs` exists or where
-- it points.
--
-- (tld, label) is the PRIMARY KEY for the same reason the TLD table uses one:
-- allocating a unique name is a race, and letting the constraint arbitrate is
-- the only way two simultaneous claims can't both pass a read-then-write check.
CREATE TABLE IF NOT EXISTS moshpit_names (
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Where the name points. Free-form and optional: a name is worth reserving
  -- before you know what it serves, and the hosting grid does not exist yet.
  target     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tld, label)
);
CREATE INDEX IF NOT EXISTS idx_moshpit_names_user ON moshpit_names(user_id);
CREATE INDEX IF NOT EXISTS idx_moshpit_names_tld ON moshpit_names(tld);
