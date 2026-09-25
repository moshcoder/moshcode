-- Postgres twin of migrations/017_session_features.sql (converted with `libsql-pg convert-schema`, reviewed).

alter table cli_sessions add column if not exists features text;
