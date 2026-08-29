-- How to reach the holder of a name, without publishing who they are.
--
-- The registry has never had a contact field, and has been publishing contact
-- details anyway: /api/moshpit/tlds returned `owner_email` in cleartext for
-- every ending, unauthenticated and pageable. That is the worst of both --
-- real personal addresses exposed with no consent and no way to opt out, and
-- still no dependable way to reach whoever holds a name. This table is the
-- consented half; the redaction of `owner_email` is the other half, and the
-- two land together on purpose.
--
-- Its own table rather than columns on moshpit_names, for the reason
-- moshpit_twins gives: a contact has a lifecycle the name does not. It is
-- offered, provisioned at a mail host we do not run, disabled, re-enabled and
-- eventually revoked, and each of those is a field. Most names will never have
-- one, and they should not carry six nullable columns to say so.
--
-- Absence of a row is the default and means "no contact" -- which is what every
-- name registered before today has, and it stays that way without a backfill.
CREATE TABLE IF NOT EXISTS moshpit_contacts (
  tld        TEXT NOT NULL,
  -- The name this contact belongs to, or '' for the ending itself.
  --
  -- One table for both rather than two, because everything below the key --
  -- token minting, alias provisioning, revocation -- is identical for an ending
  -- and a name, and a second table would be the same lifecycle maintained
  -- twice. The empty string rather than NULL: SQLite permits NULL in a non
  -- INTEGER primary key and treats NULLs as distinct, so a NULL label would let
  -- one ending hold unlimited contact rows and silently defeat the key.
  label      TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Where mail actually goes. Never published, never returned by any route --
  -- the guard address below is what the registry shows instead. Held here
  -- rather than read from users(email) at send time because they are different
  -- facts: the account address signs in, the contact address is one the holder
  -- chose to hand out, and someone selling names under an ending should be able
  -- to publish a role address without changing how they log in.
  email      TEXT NOT NULL,

  -- none | guard | public.
  --
  --   guard  -- publish <token>@moshcode.sh, which forwards. The default, and
  --            the reason this feature exists.
  --   public -- publish `email` as typed. For a holder who wants a role address
  --            reachable directly and has decided the exposure is fine.
  --   none   -- opted in once, currently showing nothing.
  --
  -- `none` is not the same as having no row, and the difference is the token.
  -- A holder who takes their contact down during a spam wave and puts it back
  -- up a week later must get the same address back: the old one is printed in
  -- other people's address books and linked from pages we do not control.
  -- Deleting the row would mint a new token and silently break all of that.
  visibility TEXT NOT NULL DEFAULT 'guard' CHECK (visibility IN ('none','guard','public')),

  -- The local part of the guard address, and the stable public identity of this
  -- contact. Unique across the whole registry because it is an address at one
  -- shared domain -- two names holding the same token would forward one
  -- person's mail to the other.
  --
  -- Never recycled. A token dies with the row (see releaseName, which drops
  -- contacts alongside pins, records and twins) and the next holder of the name
  -- mints a fresh one, so mail addressed to the previous holder can never be
  -- delivered to whoever comes after them.
  guard_token TEXT NOT NULL UNIQUE,

  -- The alias at the mail host, which is a separate system that can be down,
  -- rate limited, or simply not configured in development.
  --
  --   pending -- recorded here, not yet created there. Nothing is published.
  --   live    -- created and forwarding. The only state that publishes.
  --   failed  -- the host refused; `alias_error` says what it said.
  --   revoked -- deliberately torn down, kept so a retry does not resurrect it.
  --
  -- The guard address is published only from `live`. Printing an address before
  -- the host knows about it means publishing one that bounces, which is worse
  -- than publishing none.
  alias_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (alias_status IN ('pending','live','failed','revoked')),
  -- The mail host's own id for the alias, needed to update or delete it later.
  -- The local part alone is not enough for their API.
  alias_id     TEXT,
  -- What the host said when it refused, for the holder to read. Cleared on the
  -- next success rather than left behind describing a problem already fixed.
  alias_error  TEXT,
  alias_synced_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (tld, label)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_contacts_user ON moshpit_contacts(user_id);
-- The reconcile sweep reads "not live yet", which is a small slice of a table
-- that is mostly live -- so it is worth an index and worth being partial.
CREATE INDEX IF NOT EXISTS idx_moshpit_contacts_unsynced ON moshpit_contacts(alias_status)
  WHERE alias_status IN ('pending','failed');
