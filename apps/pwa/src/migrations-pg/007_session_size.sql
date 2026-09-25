-- Postgres twin of migrations/007_session_size.sql (converted with `libsql-pg convert-schema`, reviewed).

alter table cli_sessions add column if not exists cols bigint;

alter table cli_sessions add column if not exists rows bigint;
