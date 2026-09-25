-- Postgres twin of migrations/025_session_output_seq_unique.sql (written by hand; identical).
-- seq is allocated as MAX(seq) + 1 per session (routes/sessions.mjs). A repeat
-- makes a browser resuming from `?since=<seq>` skip a chunk for good, so the
-- index that already serves the (session_id, seq) reads becomes unique and a
-- repeat is an error rather than a silent gap.
DROP INDEX IF EXISTS idx_session_output;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_output ON session_output(session_id, seq);
