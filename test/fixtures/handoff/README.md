# Handoff fixtures

One transcript per readable engine, in that engine's own on-disk shape.

These exist because PRD 0018's Risks section is explicit about the failure that
matters: transcript formats drift, and a handoff that misreads one corrupts a
conversation instead of a cost number. A fixture per engine is what turns that
drift into a failing test rather than a bad handoff.

Each file is trimmed from a real session and then scrubbed. The records that
matter to the reader are kept verbatim, including the ones it must skip: the
system-injected first turn, the thinking blocks, the tool calls, the subagent
sidechain. A fixture that held only the happy path would not test the reader.

| file | engine | on disk at |
|---|---|---|
| `claude-session.jsonl` | claude | `~/.claude/projects/<slug>/<session>.jsonl` |
| `codex-rollout.jsonl` | codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| `claude-unreadable.jsonl` | claude | a transcript whose records no longer parse to messages |

opencode and privacycode have no file fixture because their transcript is a
SQLite database rather than a file. `test/handoff.test.mjs` builds one in a temp
directory from the real schema instead, which is the same idea in the only form
that store has.
