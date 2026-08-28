-- The clearnet twin of a name: `blue.eggs` backfilled by `blue-eggs.net`.
--
-- A Moshpit name cannot be reached from outside the pit and cannot hold a
-- certificate, because no CA will issue for an ending ICANN does not delegate.
-- That is the ceiling on the whole namespace: people take the clean name and
-- then hand out an ugly domain anyway, because the ugly one is the one that
-- works. A twin is a real registered domain that the name publishes as its way
-- in, so the pit name stays the identity and the domain is only transport.
--
-- Its own table rather than a column on moshpit_names for the ordinary reason:
-- a twin has a lifecycle the name does not. It is claimed, then proven, then
-- eventually lapses at a registrar on a date the pit does not control, and each
-- of those is a field. Four nullable columns on `moshpit_names` would leave
-- every name that never buys one carrying them.
CREATE TABLE IF NOT EXISTS moshpit_twins (
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  -- Normalised: lowercased, no scheme, no trailing dot. See normalizeDomain.
  domain     TEXT NOT NULL,
  -- pending -> verified. There is no third state: a twin that fails
  -- verification stays pending and can be retried, because the usual cause is
  -- a TXT record that has not propagated yet rather than a wrong answer, and
  -- recording that as a failure would mean re-issuing a challenge to fix a
  -- delay that fixes itself.
  status     TEXT NOT NULL CHECK (status IN ('pending','verified')),
  -- The challenge this claim is good against, and half of the TXT record the
  -- domain publishes. Kept after verification rather than cleared: the record
  -- stays in DNS as the reverse pointer, so the value that must still be found
  -- there is not scratch state to discard.
  token      TEXT NOT NULL,
  -- When the registration lapses at the registrar, or null when it was never
  -- recorded. Null means "serve it indefinitely", which is the right default
  -- for a domain the holder brought themselves and manages elsewhere -- the pit
  -- has no way to learn that date and inventing one would drop a live twin.
  expires_at INTEGER,
  verified_at INTEGER,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  -- One twin per name. Not several, and this is the load-bearing constraint:
  -- the twin's entire job is to be the single answer to "where do I send
  -- someone who is not on the pit". A name with two of them has no canonical
  -- outside form, which is the problem it was bought to solve.
  PRIMARY KEY (tld, label)
);

-- ...and one name per domain, among the ones actually being served.
--
-- Without this, `blue-eggs.net` could back both `blue.eggs` and `red.eggs`, and
-- the reverse pointer -- the TXT record naming which pit name the domain stands
-- for -- would be a claim the registry contradicts. Partial, so an abandoned
-- pending claim on a domain never blocks the person who actually holds it from
-- proving it. Two people may both be trying; only one can finish.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moshpit_twins_domain
  ON moshpit_twins(domain) WHERE status = 'verified';

CREATE INDEX IF NOT EXISTS idx_moshpit_twins_user ON moshpit_twins(user_id);
-- Lapse sweeps and the renewal nag both read "verified, expiring before X".
CREATE INDEX IF NOT EXISTS idx_moshpit_twins_expiry ON moshpit_twins(expires_at)
  WHERE status = 'verified';
