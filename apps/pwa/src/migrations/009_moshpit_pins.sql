-- The keys a name is allowed to present.
--
-- Per name rather than per TLD, and that is forced by 008: names under a TLD
-- are sold, so `blue.eggs` can belong to someone who does not own `.eggs`.
-- Hanging keys off the TLD would let its operator publish a key for a name they
-- already sold — impersonating a buyer inside the namespace they bought into.
-- The pin therefore lives beside the name and is authorised by the name's owner.
--
-- `kind` keeps the transports apart. A `tls` pin covers a certificate's
-- SubjectPublicKeyInfo; an `mtp` pin covers an ML-DSA-65 identity. Both are
-- SHA-256 over an SPKI, so as strings they are indistinguishable, and nothing
-- but this column stops a client being handed the wrong one and failing with no
-- diagnosable reason.
--
-- Several rows per (tld, label, kind) on purpose: a key cannot rotate without a
-- window in which the old and the new one are both published.
CREATE TABLE IF NOT EXISTS moshpit_name_pins (
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  pin        TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('tls','mtp')),
  note       TEXT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tld, label, pin)
);
CREATE INDEX IF NOT EXISTS idx_moshpit_name_pins ON moshpit_name_pins(tld, label, kind);
CREATE INDEX IF NOT EXISTS idx_moshpit_name_pins_user ON moshpit_name_pins(user_id);
