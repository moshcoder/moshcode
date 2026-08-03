-- DNS records for a name: `blue.eggs AAAA 2606:4700::1111`, `blue.eggs MX 10 mx.example.com`.
--
-- Until now a name carried exactly one thing: `moshpit_names.target`, a single
-- free-form pointer. That is enough to serve a website and nothing else. A name
-- that cannot publish a second address, a mail exchanger or a TXT record is not
-- a name on a network, it is a bookmark -- and every one of those needs a row of
-- its own, not another column on the name.
--
-- No `host` column, and that is the namespace's shape rather than an omission:
-- Moshpit is one level deep (parseMoshpitName refuses `a.b.c`), so there is no
-- `www.blue.eggs` for a record to hang off. Records attach to the name itself.
-- If the namespace ever grows a second level, that is when this grows a column.
--
-- Several rows per (tld, label, type) on purpose -- two AAAA records are how a
-- name gets a second address, and two MX records are how mail survives one of
-- them being down. The primary key is the record's whole content, so re-adding
-- the same record twice is a no-op rather than a duplicate answer in a reply.
CREATE TABLE IF NOT EXISTS moshpit_records (
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('AAAA','CNAME','TXT','MX')),
  -- The right-hand side, already normalised: an address lowercased and
  -- compressed, a hostname lowercased and stripped of its trailing dot, TXT
  -- content exactly as typed.
  value      TEXT NOT NULL,
  -- Seconds. Stored per record because the useful TTL is a property of what the
  -- record points at -- an address that moves wants 60, a TXT proof wants a day.
  ttl        INTEGER NOT NULL,
  -- MX only; null everywhere else. A priority on a record type that has no
  -- concept of one is a value a resolver would have to guess what to do with.
  priority   INTEGER,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tld, label, type, value)
);
CREATE INDEX IF NOT EXISTS idx_moshpit_records_name ON moshpit_records(tld, label);
CREATE INDEX IF NOT EXISTS idx_moshpit_records_user ON moshpit_records(user_id);
