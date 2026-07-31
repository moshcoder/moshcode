-- Selling names under a TLD you do not own.
--
-- A TLD is only open for business once its operator sets a price: minting
-- under someone's namespace without their say-so is the thing the registry
-- exists to prevent, so "for sale" has to be an explicit act, and NULL --
-- the state every existing row starts in -- means not for sale.
ALTER TABLE moshpit_tlds ADD COLUMN price_usd REAL;

-- One row per CoinPay checkout for a name. Keyed on the payment id, so a
-- webhook redelivery settles the same row rather than creating a second one.
CREATE TABLE IF NOT EXISTS moshpit_name_purchases (
  id          TEXT PRIMARY KEY,
  tld         TEXT NOT NULL,
  label       TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd  REAL NOT NULL,
  -- pending -> cleared, or -> refund_due when the name was taken between
  -- checkout and confirmation. That last state is real money against a name
  -- the buyer cannot have, so it is recorded rather than swallowed.
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  -- How long this checkout holds the name against other buyers. The (tld,label)
  -- primary key on moshpit_names is still the real arbiter; this only stops the
  -- ordinary case of two people paying for the same name at the same time.
  reserved_until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_name_purchases_name ON moshpit_name_purchases(tld, label);
CREATE INDEX IF NOT EXISTS idx_name_purchases_user ON moshpit_name_purchases(user_id);
