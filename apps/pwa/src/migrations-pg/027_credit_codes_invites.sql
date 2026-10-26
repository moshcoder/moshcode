-- Postgres twin of migrations/027_credit_codes_invites.sql (hand-converted, reviewed).
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_user_source ON credit_ledger(user_id, source);

create table if not exists invite_bonuses (
  invitee_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_id text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  credits bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  decided_at bigint
);
CREATE INDEX IF NOT EXISTS idx_invite_bonuses_inviter ON invite_bonuses(inviter_id, status, decided_at);
