-- Postgres twin of migrations/004_device.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists device_codes (
  device_code text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  name text,
  interval_s bigint NOT NULL DEFAULT 5,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_user_code ON device_codes(user_code);
