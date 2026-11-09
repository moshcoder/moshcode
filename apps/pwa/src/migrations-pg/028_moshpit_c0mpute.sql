-- Postgres twin of migrations/028_moshpit_c0mpute.sql.

alter table moshpit_names add column if not exists c0mpute_site text;
