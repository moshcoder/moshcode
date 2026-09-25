-- Postgres twin of migrations/003_cli_auth.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists cli_auth_codes (
  code text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge text NOT NULL,
  redirect_uri text NOT NULL,
  name text,
  used bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
