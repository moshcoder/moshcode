-- Domain-as-identity: prove you hold a name, sign in as it.
--
-- Additive only. Does NOT touch the phone/SMS, CoinPay or anon-invite paths --
-- this is a fourth provider alongside them, exactly as 20260615000000 added the
-- third.
--
-- Identity domain: user_id here is the AUTH id (auth.users.id), matching
-- user_public_keys and NOT users.id. Those are different domains in this schema
-- and 0 of 86 rows have them equal, so a policy that compares auth.uid() to
-- users.id is silently dead. Everything below compares against auth.uid().

-- 'name' joins the existing discriminator. Dropped and recreated because a bare
-- ADD CONSTRAINT of an existing name aborts with 42710 against prod.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE users ADD CONSTRAINT users_account_type_check
    CHECK (account_type IN ('verified', 'anonymous', 'name'));

-- The name a user proved, and what proved it.
CREATE TABLE IF NOT EXISTS user_names (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- Moshpit names and DNS names are DIFFERENT IDENTITIES that can spell the
    -- same string. Real endings (.io .dev .app .ai .sh .co) are claimed inside
    -- the pit, so without this column whoever mints `stripe.dev` there becomes
    -- indistinguishable from the company holding it in DNS.
    namespace   TEXT NOT NULL CHECK (namespace IN ('moshpit', 'dns')),
    proof       TEXT NOT NULL CHECK (proof IN ('pin-signature', 'dns-txt')),
    -- The pin accepted at binding time. A later mismatch means the name's key
    -- changed under us, which is a re-proof, never an automatic rebind.
    bound_pin   TEXT,
    pin_kind    TEXT NOT NULL DEFAULT 'tls' CHECK (pin_kind IN ('tls', 'mtp')),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    recheck_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

-- One account per name WITHIN a namespace, so both spellings can coexist
-- without collapsing into one another.
CREATE UNIQUE INDEX IF NOT EXISTS user_names_unique
    ON user_names (namespace, lower(name));
CREATE INDEX IF NOT EXISTS user_names_recheck ON user_names (recheck_at);

-- Burns a challenge. Same double-spend guard as registration_invites.jti: the
-- primary key is the burn, so a replayed proof loses the insert race.
CREATE TABLE IF NOT EXISTS name_challenges (
    jti         TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    namespace   TEXT NOT NULL CHECK (namespace IN ('moshpit', 'dns')),
    nonce       TEXT NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS name_challenges_expiry ON name_challenges (expires_at);

-- RLS on, zero policies: service_role only, same shape as user_backup_pins.
--
-- Deliberately NOT readable by `authenticated`. Name-addressed discovery needs
-- lookup by name, and a readable table would hand every logged-in account the
-- complete name -> user map -- reopening exactly the global read that
-- 20260816120000 closed. Discovery goes through a service-role route instead,
-- which is how /api/users/search already does it.
ALTER TABLE user_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE name_challenges ENABLE ROW LEVEL SECURITY;

-- Reading your OWN binding is safe and the settings UI needs it.
DROP POLICY IF EXISTS user_names_select_own ON user_names;
CREATE POLICY user_names_select_own ON user_names
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
