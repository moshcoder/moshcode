-- Certificates the pit has signed.
--
-- The registry is the one party that knows who holds a name, so it is the
-- natural authority to sign that name's certificate: a client that trusts the
-- pit's root once trusts every name, instead of learning each one against its
-- pin. This is the record of what was signed, for whom, and until when.
--
-- Nothing here is consulted on the TLS path. Leaves are short-lived (30 days)
-- and renewed by the origin, so there is no revocation list to serve; the
-- table exists so an owner can see what is out under their name, so a renewal
-- loop can be spotted, and so an issuance can be answered for after the fact.
--
-- The PEM is kept so a lost certificate can be fetched again without a new
-- issuance, which matters for a name whose key is on a box that only has curl.
CREATE TABLE IF NOT EXISTS moshpit_name_certs (
  serial     TEXT PRIMARY KEY,
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  pin        TEXT NOT NULL,
  cert       TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  not_before INTEGER NOT NULL,
  not_after  INTEGER NOT NULL,
  issued_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moshpit_name_certs_name ON moshpit_name_certs(tld, label, issued_at);
CREATE INDEX IF NOT EXISTS idx_moshpit_name_certs_user ON moshpit_name_certs(user_id);
