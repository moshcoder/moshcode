-- Postgres twin of migrations/017_moshpit_contact.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_contacts (
  tld text NOT NULL,
  label text NOT NULL DEFAULT '',
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  visibility text NOT NULL DEFAULT 'guard' CHECK (visibility IN ('none','guard','public')),
  guard_token text NOT NULL UNIQUE,
  alias_status text NOT NULL DEFAULT 'pending' CHECK (alias_status IN ('pending','live','failed','revoked')),
  alias_id text,
  alias_error text,
  alias_synced_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tld, label)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_contacts_user ON moshpit_contacts(user_id);

CREATE INDEX IF NOT EXISTS idx_moshpit_contacts_unsynced ON moshpit_contacts(alias_status)
  WHERE alias_status IN ('pending','failed');
