-- Short links: `/f/<code>` on the pit, following to a URL somewhere else.
--
-- The pit already hands people long URLs — a session mirror, an approval, a
-- name's site, a release asset — and the place they get pasted is a terminal,
-- a chat line or a QR code, where a 140-character URL wraps and breaks. So the
-- registry mints a short one: `/shorten <url>` in the pit, `/f/abc1234` out.
--
-- One table, because a short link genuinely is one row. The code is the primary
-- key rather than an id: it is the URL, it is what a lookup has in hand, and a
-- separate id would be a second unique index bought for nothing.
CREATE TABLE IF NOT EXISTS moshpit_links (
  -- The short code, lowercase, from the unambiguous alphabet in
  -- lib/moshpit-links.mjs. A person reads these off a screen and types them
  -- back in, so `0`/`o` and `1`/`l` are not in it.
  code       TEXT PRIMARY KEY,
  -- Where it follows to. Stored as the normalized absolute URL, http(s) only —
  -- a redirect target is a scheme the browser will act on, and `javascript:`
  -- reaching this column is an XSS with a permalink.
  url        TEXT NOT NULL,
  -- Who minted it. Cascades: deleting an account takes its links with it,
  -- rather than leaving live redirects owned by nobody.
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- A moshpit name this link belongs to, as `<label>.<tld>`, or null for one
  -- minted against the account itself. A plain column rather than a foreign key
  -- to moshpit_names: a name can be released while its links are still printed
  -- on something, and a redirect that dies because a name changed hands is a
  -- worse failure than one whose label no longer resolves.
  name       TEXT,
  -- Counted rather than logged. Who clicked and from where is surveillance this
  -- registry has no use for; how many times it was followed is the one number
  -- the person who minted it actually asks for.
  hits       INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at INTEGER NOT NULL
);

-- The two reads: everything one account minted, newest first, and "have I
-- already shortened this?" — which is what makes /shorten idempotent instead of
-- minting a second code for a URL that already has one.
CREATE INDEX IF NOT EXISTS idx_moshpit_links_user ON moshpit_links(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moshpit_links_url ON moshpit_links(user_id, url);
