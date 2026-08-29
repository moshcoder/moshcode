-- Offers on a parked name, and the leases some of them turn into.
--
-- Everything the registry could say to someone who wanted a name it could not
-- sell them was a dead end. A name somebody holds answered "claimed but does
-- not point anywhere"; a name under an ending with no price answered ".eggs is
-- not for sale". Both are the exact moment a visitor is most interested, and
-- both ended the conversation -- while the holder, who might well have sold,
-- never heard that anyone asked.
--
-- An offer is that conversation. It is private between the two of them: only
-- the holder sees what was offered, and they accept, reject or counter. A
-- public bid board would tell every later bidder what the last one offered and
-- tell the holder's next buyer exactly where their floor is.
CREATE TABLE IF NOT EXISTS moshpit_offers (
  id    TEXT PRIMARY KEY,
  tld   TEXT NOT NULL,
  -- The name being offered on, or '' for the ending itself -- the same
  -- convention moshpit_contacts uses, and for the same reason: the whole
  -- lifecycle below is identical for a name and an ending.
  label TEXT NOT NULL DEFAULT '',

  -- buy | lease.
  --
  -- Leases are names only, never endings, and that is a deliberate limit
  -- rather than an oversight. Leasing an ending would have to mean the lessee
  -- can mint names under it, and a name minted during a lease outlives the
  -- lease -- so a six-month tenancy would permanently carve up a namespace its
  -- holder never sold. Until there is an answer to that, an ending can be
  -- bought and not rented.
  kind  TEXT NOT NULL CHECK (kind IN ('buy','lease')),

  -- What is being offered, in whole dollars and cents. For a lease this is the
  -- total for the whole term, paid once, not a monthly rate -- see
  -- moshpit_leases on why there is no recurring billing here.
  amount_usd   REAL NOT NULL,
  -- How long the lease runs. NULL for a purchase, and required for a lease.
  lease_months INTEGER,

  -- Who is asking. An offer can come from someone with no account at all,
  -- because requiring one first is asking a stranger to sign up before they
  -- may say what they would pay, on a page whose entire job is to convert that
  -- stranger. The address is the identity until there is a user id, which
  -- appears when they sign in to pay.
  offerer_email   TEXT NOT NULL,
  offerer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  message         TEXT,

  -- Who it was addressed to when it was made. Kept as a fact about the offer
  -- rather than looked up later: names change hands, and an offer must stay
  -- attached to the person it was actually put to. Acceptance re-checks who
  -- holds the name now, so a stale row can never sell something twice.
  holder_user_id TEXT NOT NULL,

  --   unverified -- made, but the address has not proved it wants to be here.
  --                 The holder is not told. This is where spam stops.
  --   open       -- verified and waiting on the holder.
  --   countered  -- the holder named a different number, waiting on the offerer.
  --   accepted   -- agreed by both, waiting on payment.
  --   settling   -- a confirmed payment is being turned into a transfer. Held
  --                 for one write, and it is the atomic claim that stops a
  --                 redelivered webhook moving the name twice.
  --   paid       -- settled, and the name or lease has moved.
  --   refund_due -- the money arrived and the name could not be given. Someone
  --                 else took it between acceptance and confirmation, which is
  --                 real money against something the buyer cannot have, so it
  --                 is recorded rather than swallowed.
  --   rejected / withdrawn / expired -- over, by each of the three people who
  --                 can end it: the holder, the offerer, and the clock.
  status TEXT NOT NULL
    CHECK (status IN ('unverified','open','countered','accepted','settling','paid','refund_due','rejected','withdrawn','expired')),

  -- Proves the address wants the mail before any is sent to the holder.
  -- Without this the form is a way to mail every holder in the registry from
  -- our own domain, one name at a time.
  verify_token TEXT NOT NULL UNIQUE,
  verified_at  INTEGER,

  -- The holder's counter, held beside the original rather than overwriting it.
  -- What was first offered is the fact the offerer will be comparing against,
  -- and a negotiation that silently rewrites its own history is one neither
  -- side can check.
  counter_amount_usd REAL,
  counter_months     INTEGER,
  countered_at       INTEGER,

  -- The CoinPay checkout, once there is something agreed to pay for. UNIQUE so
  -- a redelivered webhook settles the same offer rather than a second one --
  -- the same reasoning moshpit_name_purchases uses for its primary key.
  payment_id TEXT UNIQUE,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- An offer nobody answered stops being one. Checked at read time as well as
  -- swept, so an offer is never live merely because the sweep has not run.
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moshpit_offers_holder ON moshpit_offers(holder_user_id, status);
CREATE INDEX IF NOT EXISTS idx_moshpit_offers_name ON moshpit_offers(tld, label, status);
CREATE INDEX IF NOT EXISTS idx_moshpit_offers_offerer ON moshpit_offers(offerer_email, created_at);
-- The sweep reads "still live, past its date", which is a small slice.
CREATE INDEX IF NOT EXISTS idx_moshpit_offers_expiry ON moshpit_offers(expires_at)
  WHERE status IN ('unverified','open','countered');

-- A name rented rather than sold.
--
-- The holder keeps the name. The lessee gets to point it, publish under it and
-- present keys for it until the term runs out, and then it reverts with no
-- action needed from either of them.
--
-- Paid once, upfront, for the whole term. Not because a monthly rate would be
-- wrong -- it is how leasing actually works -- but because renewing one needs
-- subscription billing, a grace period, and a story for what happens to a live
-- site when a card fails, and none of those exist here yet. A term that is
-- fully paid before it starts cannot lapse halfway through, which makes this
-- the version that can be built correctly today.
CREATE TABLE IF NOT EXISTS moshpit_leases (
  tld    TEXT NOT NULL,
  label  TEXT NOT NULL,
  lessee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who it reverts to. Stored rather than read from moshpit_names, because
  -- that row is what a lease exists to make ambiguous, and the answer to
  -- "whose name is this really" must not depend on the thing being leased.
  holder_user_id TEXT NOT NULL,
  offer_id   TEXT NOT NULL REFERENCES moshpit_offers(id),
  months     INTEGER NOT NULL,
  amount_usd REAL NOT NULL,
  starts_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,

  -- One lease per name. Two people holding overlapping tenancies on one name
  -- is not a state anything downstream could resolve -- whose target does it
  -- serve? -- so the key refuses it rather than the application remembering to.
  -- A finished lease stays as the row until a new one replaces it, which is
  -- what makes "who had this last" answerable.
  PRIMARY KEY (tld, label)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_leases_lessee ON moshpit_leases(lessee_user_id);
CREATE INDEX IF NOT EXISTS idx_moshpit_leases_expiry ON moshpit_leases(expires_at);

-- The lease, denormalised onto the name it is on.
--
-- moshpit_leases above is the record. These two are the cache, and the split is
-- the same one moshpit_tlds and moshpit_tld_log already make in this schema.
--
-- The reason is resolution. Every name lookup in the pit goes through
-- resolveMoshpitName -- the DNS bridge, the browser extension, every /n/ page
-- -- and each one has to know whether the name is currently being served by a
-- tenant or by a tenancy that has quietly run out. Asking a second table on
-- that path would put an extra SELECT on the hottest query in the registry to
-- answer a question that is null for almost every name. Read from the row that
-- was already fetched, it is free.
--
-- NULL means what it has always meant: nobody is renting this.
ALTER TABLE moshpit_names ADD COLUMN leased_to TEXT;
ALTER TABLE moshpit_names ADD COLUMN leased_until INTEGER;

-- Reverted, so the sweep can tell a lease it has already cleaned up from one it
-- has not. Without it the sweep either has to re-clear every expired lease
-- forever, or track its own high-water mark somewhere else.
ALTER TABLE moshpit_leases ADD COLUMN reverted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_moshpit_leases_unreverted ON moshpit_leases(expires_at)
  WHERE reverted_at IS NULL;
