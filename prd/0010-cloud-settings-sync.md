---
openprd: "0.2"
id: "0010"
title: "Sync the pit's settings to your moshcode.sh account"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-08-11
updated: 2026-08-11
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/settings-sync.mjs · apps/pwa/src/routes/settings-sync.mjs
tags: account, settings, sync
supersedes:
superseded-by:
---

## Problem

A pit becomes yours by accretion. You add `/alias set gs "git status"`, then a
dozen more; you tune the herd's rules until it stops calling a working agent
blocked. None of it is in a repo, none of it is in a dotfile anyone syncs, and
all of it lives in `~/.moshcode` on exactly one machine.

So the second machine is a stranger. A new laptop, a fresh container, a droplet
you SSH into to babysit an agent, a reinstall after a disk swap — each one starts
from nothing, and the muscle memory built at the first prompt does not work at
the second. People already log in to `app.moshcode.sh` (`/login`) for approvals,
notifications and the session mirror, so the account that could hold this
configuration is already there and already paired with every machine.

## Goals

- Moving to a new machine costs `/login` and `/load`, not an afternoon of
  remembering what you had.
- A person can see what is stored on their account, and delete it, from the web.
- Nobody is ever surprised by a settings overwrite — not from another machine,
  and not over their own uncommitted edits.
- No credential, key or token is ever part of what syncs, and that fact is
  enforced by a test rather than by care.

## Non-Goals

- Background sync that can *overwrite*. This line used to rule out background
  sync altogether — "a daemon that pushes silently is a daemon that overwrites
  silently" — and the reasoning was right about the daemon it imagined. R10
  narrows it rather than dropping it: the pit does sync on its own, and is
  allowed to because it is never permitted to force. Every refusal in R3 and R4
  is what makes an unattended tick safe, and a background sync that could pass
  `--force` would be exactly the thing this line was written to prevent.
- Syncing engine configuration (`~/.claude.json`, `~/.codex`, MCP registrations).
  Those files carry provider API keys and are owned by other tools' schemas.
- Syncing machine state: live herd sessions, the package cache, shell history.
  None of it means anything on a different box.
- Merging. Two divergent settings files are resolved by a person choosing one,
  not by a three-way merge of someone's aliases.

## Users

- **The multi-machine moshcoder** — laptop, desktop, a dev box, and a container
  per project. Wants the same prompt everywhere.
- **The reinstaller** — new OS, same person. Wants their aliases back.
- **The team lead** — one account, several machines, and a strong preference for
  never explaining to a colleague why their aliases disappeared.

## Requirements

- R1 [P0] `/save` (and `moshcode save`) uploads this machine's pit settings to the
  logged-in account. `/load` (`moshcode load`) brings them back down.
- R2 [P0] What syncs is an allowlist, not a directory walk: the pit's settings
  (`aliases.json`), herd's (`herd/rules.json`, `herd/config.json`), the feed and
  news subscriptions, `pricing.json`, the DNS filter's policy, and
  `business.json`. `~/.moshcode` is also where moshcode installs itself and
  where the account token lives, so the allowlist is load-bearing rather than
  tidy. `credentials.json`, `herd/sessions.json`, `sync.json` and `pkg/` are
  named as never-synced and asserted in tests, alongside the state that is
  meaningless or private off its own machine: task ledgers and transcripts,
  `timers.json`, `dns-filter/stats.json` (a list of blocked domains is browsing
  history), listing caches, and one box's pidfiles and logs. Directory and
  extension rules are enforced, not only documented.
- R3 [P0] Each save is a numbered revision. `/save` sends the revision it last
  agreed on and the app refuses the write if the account has moved past it, so
  two machines cannot silently erase one another.
- R4 [P0] `/load` refuses to overwrite a settings file that changed locally since
  the last sync, and names the file. `--force` overrides; `--dry-run` shows the
  per-file plan and writes nothing.
- R5 [P0] Every path in a downloaded snapshot is re-checked against the allowlist
  before anything is written. A snapshot is data from the network, and an
  unchecked path in it makes `/load` a remote write primitive.
- R6 [P1] The app keeps the last ten revisions, shows them at
  `/settings/sync` with the machine and time each came from, and can promote an
  older one to current.
- R7 [P1] `--json` on both verbs, so a provisioning script can act on the result.
- R8 [P1] A snapshot records which engines and tools the source machine had
  installed. `/load` names the missing ones as a suggestion; it never installs.
- R9 [P2] Not logged in, session expired, nothing saved yet, conflict: each is a
  sentence naming the command that resolves it (`/login`, `/save`, `/load`,
  `--force`).
- R10 [P1] The pit syncs on its own every five minutes: `/load` then `/save`, in
  that order, never with `--force`. Loading first means the ordinary
  two-machine case settles itself; when `/load` declines because of unsaved
  local edits, the `/save` behind it carries exactly those edits up, which is
  the resolution R4 already recommends. It is silent when logged out, silent
  when nothing changed, and silent about network failure; it speaks only for
  settings that arrived from another machine, a revision it pushed, and the two
  states that need a person — a conflict and a rejected credential. On by
  default. `MOSHCODE_NO_AUTOSYNC` turns it off, `MOSHCODE_AUTOSYNC_MS` retimes
  it.

## UX Notes

```
mosh ▸ /save
  ✓ saved 2 files to you@example.com (revision 3)
     aliases.json  pit aliases
     herd/rules.json  herd state rules
     on another machine: `/login` then `/load`

mosh ▸ /load                       # on the new box
  loaded revision 3 from dev — 2 files written
     added    aliases.json
     added    herd/rules.json
     that machine also had codex, gh — `/install <name>` to match it

mosh ▸ /load                       # after editing aliases locally
  1 local file changed since this machine last synced:
     aliases.json
     `/save` to keep them, `/load --force` to replace them, `/load --dry-run` to see the difference
```

The pit never blocks on this: both verbs are one request and some printing, so
readline keeps the prompt. `~/.moshcode/sync.json` remembers the revision and a
per-file digest — that digest is what separates "someone else saved" from "you
edited this five minutes ago", which want opposite answers.

## Success Metrics

- A fresh machine reaches a familiar prompt in two commands (`/login`, `/load`).
- Zero settings-loss reports: every destructive path is either refused or
  recoverable from `/settings/sync`.
- No credential ever appears in a stored snapshot (asserted, not audited).

## Risks & Open Questions

- **Scope creep into secrets.** The most-requested next file will be an engine
  config that holds an API key. Holding the line — settings, never credentials —
  is what keeps `/load` safe to run on a machine you share.
- **Ten revisions is a guess.** Cheap to raise; it exists so a bad `/save` from
  the wrong machine is recoverable at all.
- **A snapshot version bump.** Handled by refusing to read a newer snapshot and
  naming `moshcode upgrade`, rather than by guessing at a shape this build has
  never seen.
- **Should `/load` be able to pick a revision?** The app stores ten and the web
  page can promote one, which covers recovery without adding a flag that takes a
  number. Open if people ask for `--revision`.
