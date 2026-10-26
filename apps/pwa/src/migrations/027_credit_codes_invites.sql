-- Credit codes + scarce invites (@profullstack/redeem-credits, @profullstack/affiliates).
-- The modules keep their own tables (redeem_*, aff_*) and create them on first use.
-- What lives here is this app's side of it:
--   credit_ledger.source  the grant's origin (code:<id>, invite:<id>:invitee|inviter),
--                         unique per user, so a grant can never land twice.
--   invite_bonuses        one row per invited account: whether its bonus was paid,
--                         is waiting on the email confirmation, or was refused and why.
ALTER TABLE credit_ledger ADD COLUMN source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_user_source ON credit_ledger(user_id, source);

CREATE TABLE IF NOT EXISTS invite_bonuses (
  invitee_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inviter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_id   TEXT NOT NULL,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending (awaiting email confirmation) | paid | refused
  reason      TEXT,
  credits     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invite_bonuses_inviter ON invite_bonuses(inviter_id, status, decided_at);
