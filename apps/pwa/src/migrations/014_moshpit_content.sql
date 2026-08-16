-- What a name publishes, when it publishes it here rather than somewhere else.
--
-- A feed made a name into a site by pointing at writing that already existed
-- elsewhere. This is the other half: somewhere to put writing that does not
-- exist anywhere yet, reachable over HTTP so a script, a bot or a form can add
-- to it without a person opening a dashboard.
--
-- One table for pages, sections and every kind of post, distinguished by
-- `kind`. They genuinely are one row: a slug, a title, a body, sometimes a URL,
-- and a position in the navigation. Splitting them would mean three tables with
-- the same six columns and a union every time the site is drawn — and the nav,
-- which is the thing that has to stay simple, is one query over one table.
--
-- The kinds:
--
--   section   a heading in the nav that posts can belong to
--   page      a standalone page in the nav — about, contact, colophon
--   text      a post that is its own body
--   link      a post that is a link somewhere else
--   image     a post that is one picture
--   gallery   a post that is several
--   video     a post that is something to watch
--   embed     a post that is a card for a URL we will not inline
--
-- Which is the set a link aggregator has, because that is the set people
-- actually post: say something, point at something, show something, play
-- something.
CREATE TABLE IF NOT EXISTS moshpit_content (
  tld        TEXT NOT NULL,
  label      TEXT NOT NULL,
  -- Unique per name and stable, because it is the URL: /n/blue.eggs/hello. The
  -- primary key rather than an id, so a webhook that fires twice updates one
  -- post instead of creating two — publishing is retried far more often than
  -- it is undone.
  slug       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('section','page','text','link','image','gallery','video','embed')),
  title      TEXT NOT NULL,
  -- The prose. Plain text: it is escaped on the way out, and a name's owner is
  -- not necessarily the person whose script is posting to it.
  body       TEXT,
  -- Where a link, image, video or embed points. Null for the kinds that are
  -- their own content.
  url        TEXT,
  -- A gallery's pictures, as a JSON array of {url, alt}. A column rather than a
  -- child table because a gallery is read and written whole, never queried
  -- into.
  media      TEXT,
  -- The section a post belongs under, or null for the front page. Not a foreign
  -- key: a post may be filed under a section that has not been created yet
  -- (a webhook does not get to control the order its calls arrive in), and the
  -- nav simply does not show a section that does not exist.
  section    TEXT,
  -- Whether this appears in the navigation. Sections and pages default to yes,
  -- posts to no -- a nav with every post in it is not a nav.
  nav        INTEGER NOT NULL DEFAULT 0,
  -- Where it sits in the nav. Ties break on title, so an unset position is a
  -- workable default rather than an arbitrary order.
  position   INTEGER NOT NULL DEFAULT 0,
  -- When it goes live. Null means a draft: written, addressable by its author,
  -- absent from the site. Kept separate from created_at so a post can be
  -- backdated to when it was actually written.
  published_at INTEGER,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tld, label, slug)
);

-- The two reads the site makes: everything for a name, newest first, and
-- everything in one section.
CREATE INDEX IF NOT EXISTS idx_moshpit_content_name ON moshpit_content(tld, label, published_at);
CREATE INDEX IF NOT EXISTS idx_moshpit_content_section ON moshpit_content(tld, label, section);
