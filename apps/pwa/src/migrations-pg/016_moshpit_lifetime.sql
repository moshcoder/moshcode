-- Postgres twin of migrations/016_moshpit_lifetime.sql (converted with `libsql-pg convert-schema`, reviewed).

DROP INDEX IF EXISTS idx_moshpit_tlds_expires;

ALTER TABLE moshpit_tlds DROP COLUMN expires_at;

ALTER TABLE moshpit_tlds DROP COLUMN term_started_at;
