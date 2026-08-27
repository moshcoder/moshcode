-- A pin belongs to a pin-signature proof, and to nothing else.
--
-- The DNS TXT path proves a name by publishing a record, so there is no key and
-- no pin. Left as it was, `pin_kind` would default to 'tls' on every DNS
-- binding and quietly assert a key kind that was never checked -- the kind of
-- field that reads as evidence later precisely because nobody meant it to.
--
-- Safe to tighten now: user_names is empty (0 rows, checked before applying).
-- Doing this after the first binding lands would need a backfill and a decision
-- about what the existing rows meant.

ALTER TABLE user_names ALTER COLUMN pin_kind DROP DEFAULT;
ALTER TABLE user_names ALTER COLUMN pin_kind DROP NOT NULL;

-- Ties the two pin columns to the proof that produces them, in both directions:
-- a pin-signature binding must carry a pin, and a dns-txt binding must not.
ALTER TABLE user_names DROP CONSTRAINT IF EXISTS user_names_proof_shape;
ALTER TABLE user_names ADD CONSTRAINT user_names_proof_shape CHECK (
    (proof = 'pin-signature' AND bound_pin IS NOT NULL AND pin_kind IS NOT NULL)
    OR
    (proof = 'dns-txt' AND bound_pin IS NULL AND pin_kind IS NULL)
);
