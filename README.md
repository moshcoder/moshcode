# moshcode 🤘

A metal wrapper CLI for agentic coding. moshcode doesn't reinvent the agent — it
**installs and drives** existing ones (opencode, Claude Code, codex) and adds a
tiny scripting toolkit (moshscript) on top.

## Install

```sh
curl -fsSL https://moshcoding.com/install.sh | sh
```

Zero-dependency ESM — all it needs is Node.js 18+. Later: `… | sh -s -- update`
to upgrade, `… | sh -s -- remove` to uninstall.

## Engines

```sh
moshcode engines            # list installable engines
moshcode install opencode   # install opencode (curl … | bash)
moshcode install claude     # npm i -g @anthropic-ai/claude-code
moshcode install codex      # npm i -g @openai/codex
```

## PRD — plan before you mosh

Write a product requirements doc *first*, then let your coding agents build to it.
`moshcode prd` uses [OpenPRD](https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md) —
a lightweight, **single-file** PRD standard: one `prd/<slug>/prd.md` per decision
(problem, goals, users, requirements, metrics). No multi-file ceremony.

```sh
moshcode prd "parked-domain service expansion"   # scaffold a PRD, then hand it to an engine to author
moshcode prd                                      # list existing PRDs
```

`moshcode prd <idea>` writes a private `prd/<slug>/prd.md` and hands it to a coding
engine (Claude Code by default) to fill in. **PRDs are private** — the `prd/` folder
is gitignored automatically; only the OpenPRD *standard* itself is public.

In the TUI shell it's `/prd [idea]`.

## moshscript

A metal scripting toolkit. Paste dead-simple, readable scripts and run them.

```
while (alive) {
  code();
  mosh();
  notify();
  repeat();
} // no bugs, only features
```

## Run

```sh
moshcode run examples/alive.mosh        # run a script
moshcode run - < script.mosh            # or pipe/paste from stdin
moshcode run --max 5                    # bound the while loop (default 3)
echo 'say("hi"); notify();' | moshcode run -
moshcode commands                       # list built-in commands
moshcode help
```

No install/build step — it's plain ESM. `node bin/moshcode.mjs …` works too.

## moshscript

The whole language:

- `while (alive) { … }` — loops the body while the `alive` flag is set (bounded by `--max`).
- `name(args…);` — call a command. `//` comments are ignored.

Built-in commands: `code()` `mosh()` `notify()` `repeat()` `say("…")` `sleep(ms)` `stop()`.

### notify()

Pings **moshcoding.com web notifications**, and — if `MOSHCODE_WEBHOOK_URL` is set —
also POSTs to that webhook. Both are HMAC-signed (`X-Moshcode-Signature`) with
`MOSHCODE_WEBHOOK_SECRET`.

### Add your own commands

```js
import { defaultCommands } from "moshcode/src/commands.mjs";
const commands = { ...defaultCommands(), deploy: (ctx) => ctx.out("shipping…") };
```

## Env

| var | default | purpose |
|---|---|---|
| `MOSHCODE_API` | `https://moshcoding.com` | web-notifications endpoint host |
| `MOSHCODE_WEBHOOK_URL` | — | optional extra webhook for `notify()` |
| `MOSHCODE_WEBHOOK_SECRET` | — | signs notify() posts |
