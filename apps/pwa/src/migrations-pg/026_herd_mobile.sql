-- Postgres twin of migrations/026_herd_mobile.sql (hand-converted, reviewed).

create table if not exists herd_machines (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text,
  version text,
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_herd_machines_user ON herd_machines(user_id, last_seen_at DESC);

create table if not exists herd_sessions (
  machine_id text NOT NULL REFERENCES herd_machines(id) ON DELETE CASCADE,
  name text NOT NULL,
  engine text,
  state text NOT NULL,
  blocked_on text,
  confidence text,
  cwd text,
  kind text,
  last_lines text,
  since bigint,
  blocked_at bigint,
  approval text,
  action_token text,
  updated_at bigint NOT NULL,
  PRIMARY KEY (machine_id, name)
);

create table if not exists herd_commands (
  id text PRIMARY KEY,
  machine_id text NOT NULL REFERENCES herd_machines(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session text NOT NULL,
  kind text NOT NULL,
  args text,
  status text NOT NULL DEFAULT 'queued',
  result text,
  via text,
  user_agent text,
  created_at bigint NOT NULL,
  claimed_at bigint,
  done_at bigint
);

CREATE INDEX IF NOT EXISTS idx_herd_commands_machine ON herd_commands(machine_id, status, created_at);
