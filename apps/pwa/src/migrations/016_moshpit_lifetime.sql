-- Endings are sold once and held for good. The term is withdrawn.
--
-- Migration 010 gave endings a one-year term with renewals, per PRD 0005 §5.
-- That is reversed here: $5 buys `.eggs` outright and $2 buys a name under one,
-- both paid once. The prices have not changed -- what changed is that they are
-- not charged again.
--
-- The reason is what the namespace is for rather than generosity. A name that
-- lapses is a name somebody else can catch, and the pitch is that you can
-- finally hold the clean name instead of the hyphenated one you settled for. An
-- annual invoice with a drop date on it is the thing people are trying to get
-- away from; selling it back to them undoes the pitch.
--
-- Worth recording that the term never actually shipped: nothing in the app
-- could open an ending checkout, so `quoteTld` and `quoteRenewal` were
-- unreachable and only the webhook settler was wired up. No ending was ever
-- charged a renewal, and no row in the wild has an expiry that this drop takes
-- away from somebody. That is why this is a plain drop rather than a
-- grandfathering policy -- §21.8 asks for one before putting endings INTO a
-- lifecycle, and taking them back out of one nobody was in needs no such thing.
--
-- `moshpit_tld_purchases` keeps its `kind` and `years` columns, deliberately.
-- They are a financial record of what was sold at the time, and a ledger is not
-- something to rewrite once the product changes. New rows are written
-- 'register' and 1 for good; a 'renew' row that settles late is honoured rather
-- than refused, because the buyer is owed what they were promised.
--
-- (Nothing may follow the last statement here but whitespace: migrate.mjs
-- splits on semicolons and hands each piece to libSQL, and a trailing
-- comment-only piece comes back as the opaque `SQLITE_OK: not an error`.)

-- The index goes first: SQLite refuses to drop a column an index reads.
DROP INDEX IF EXISTS idx_moshpit_tlds_expires;

ALTER TABLE moshpit_tlds DROP COLUMN expires_at;

ALTER TABLE moshpit_tlds DROP COLUMN term_started_at;
