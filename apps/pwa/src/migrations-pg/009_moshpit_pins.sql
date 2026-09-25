-- Postgres twin of migrations/009_moshpit_pins.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists moshpit_name_pins (
  tld text NOT NULL,
  label text NOT NULL,
  pin text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tls','mtp')),
  note text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (tld, label, pin)
);

CREATE INDEX IF NOT EXISTS idx_moshpit_name_pins ON moshpit_name_pins(tld, label, kind);

CREATE INDEX IF NOT EXISTS idx_moshpit_name_pins_user ON moshpit_name_pins(user_id);
