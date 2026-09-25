-- Postgres twin of migrations/014_moshpit_content.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_content (
  tld text NOT NULL,
  label text NOT NULL,
  slug text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('section','page','text','link','image','gallery','video','embed')),
  title text NOT NULL,
  body text,
  url text,
  media text,
  section text,
  nav bigint NOT NULL DEFAULT 0,
  position bigint NOT NULL DEFAULT 0,
  published_at bigint,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tld, label, slug)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_content_name ON moshpit_content(tld, label, published_at);

CREATE INDEX IF NOT EXISTS idx_moshpit_content_section ON moshpit_content(tld, label, section);
