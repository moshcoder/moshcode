-- Postgres twin of migrations/013_moshpit_feeds.sql (converted with `libsql-pg convert-schema`, reviewed).

alter table moshpit_names add column if not exists feed_url text;

alter table moshpit_names add column if not exists feed_kind text;
