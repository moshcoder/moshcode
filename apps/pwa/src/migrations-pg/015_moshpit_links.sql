-- Postgres twin of migrations/015_moshpit_links.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_links (
  code text PRIMARY KEY,
  url text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text,
  hits bigint NOT NULL DEFAULT 0,
  last_hit_at bigint,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moshpit_links_user ON moshpit_links(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_moshpit_links_url ON moshpit_links(user_id, url);
