-- Endings get a term, and a way to be paid for.
--
-- Claiming an ending has been free and permanent: a row in moshpit_tlds with a
-- created_at and nothing that ever expires. PRD 0005 §5 puts a $5/year price on
-- a direct ending and a one-year term under it, which needs two things this
-- schema has never had — when the term started, and when it runs out.
--
-- Both are NULLable, and every existing row keeps NULL. A NULL expires_at means
-- "no term recorded", which is what every ending claimed before today has, and
-- it is deliberately not the same as an expired one. Backfilling those rows
-- with an invented expiry would silently put a few hundred endings into a
-- lifecycle their owners never agreed to; §21.8 calls for a published
-- grandfathering policy first, and that is a decision rather than a migration.
ALTER TABLE moshpit_tlds ADD COLUMN term_started_at INTEGER;
ALTER TABLE moshpit_tlds ADD COLUMN expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_moshpit_tlds_expires ON moshpit_tlds(expires_at);

-- One row per CoinPay checkout for an ending. Keyed on the payment id so a
-- webhook redelivery settles the same row rather than creating a second one —
-- the same shape as moshpit_name_purchases, because it is the same problem.
CREATE TABLE IF NOT EXISTS moshpit_tld_purchases (
  id          TEXT PRIMARY KEY,
  tld         TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd  REAL NOT NULL,
  -- register | renew. A renewal extends a term the buyer already holds; a
  -- registration creates one. They settle differently and the row has to say
  -- which it is, or a redelivered webhook cannot know what it is finishing.
  kind        TEXT NOT NULL DEFAULT 'register' CHECK (kind IN ('register','renew')),
  -- pending -> cleared, or -> refund_due when the ending was claimed between
  -- checkout and confirmation. That last state is real money against something
  -- the buyer cannot have, so it is recorded rather than swallowed.
  status      TEXT NOT NULL,
  years       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  -- How long this checkout holds the ending against other buyers. The UNIQUE
  -- constraint on moshpit_tlds.tld is still the real arbiter; this only stops
  -- the ordinary case of two people paying for the same ending at once.
  reserved_until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moshpit_tld_purchases_user ON moshpit_tld_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_moshpit_tld_purchases_tld ON moshpit_tld_purchases(tld, status);
