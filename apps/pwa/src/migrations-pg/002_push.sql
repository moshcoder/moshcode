-- Postgres twin of migrations/002_push.sql (converted with `libsql-pg convert-schema`, reviewed).

create table if not exists push_subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
