# moshcode 🤘

A metal wrapper CLI for agentic coding. moshcode doesn't reinvent the agent — it
**installs and drives** existing ones (opencode, Claude Code, codex) and adds a
tiny scripting toolkit (moshscript) on top. It also conducts adjacent native
workflow tools for finding work and getting paid.

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

### Autonomous agents versus raw starts

`agents` opens the engine's native **agent view** when it has one, so you land on
your agent list. Engines without an agents view instead start an autonomous
session by injecting the engine's native bypass or auto-approval mode. Either way,
use this only in an isolated container, VM, or workspace you trust:

```sh
moshcode agents claude      # claude agents --dangerously-skip-permissions  (agent view)
moshcode agents opencode    # opencode agent list                          (agent view)
moshcode agents codex       # codex --dangerously-bypass-approvals-and-sandbox  (autonomous)
moshcode agents gemini      # gemini --approval-mode=yolo                       (autonomous)
moshcode agents aider       # aider --yes-always                                (autonomous)
```

`start` is the explicit raw path. It injects nothing, so the native engine keeps
its normal permission model and receives only your arguments:

```sh
moshcode start claude
moshcode start codex --sandbox workspace-write
```

Bare engine commands remain raw for backward compatibility, so `moshcode claude`
is shorthand for `moshcode start claude`. In the TUI, use `/agents <engine>` for
autonomous mode or `/start <engine>` for raw mode. Running `moshcode agents` or
`/agents` without an engine still lists engines and their install status.

The modes are not identical across providers. In particular, OpenCode `--auto`
auto-approves permission requests but continues to enforce explicit deny rules.

## Workflow tools: UGig + CoinPay

UGig and CoinPay remain independent native CLIs with their own authentication,
configuration, command trees, output formats, and release cycles. MoshCode
installs them and passes control through without reimplementing their APIs.

```sh
moshcode tools                    # list tools and native install status
moshcode install ugig             # npm install -g ugig
moshcode install coinpay          # npm install -g @profullstack/coinpay

moshcode ugig --json gigs list    # arguments/output go straight to ugig
moshcode coinpay wallet balance   # arguments/output go straight to coinpay
```

Top-level passthrough preserves stdin, stdout, stderr, environment variables,
the current directory, and the native exit result. That keeps JSON pipelines
usable:

```sh
moshcode ugig --json gigs list | jq .
```

Run `moshcode ugig --help` or `moshcode coinpay --help` for each tool's current
native setup and authentication commands. CoinPay currently requires Node.js
20+, while MoshCode itself remains compatible with Node.js 18+.

In the TUI, use `/tools`, `/ugig [args…]`, or `/coinpay [args…]`. The native CLI
owns the terminal until it exits, then MoshCode returns to the pit.

## Upgrade everything

```sh
moshcode upgrade            # moshcode + every installed engine and tool
moshcode upgrade claude     # just one engine (name any; alias ok)
moshcode upgrade ugig       # just one workflow tool
moshcode upgrade tools      # all installed workflow tools, no self/engines
moshcode upgrade self       # just moshcode itself
```

Each target is updated with its own native updater when it has one (e.g.
`opencode upgrade`, `aider --upgrade`) and re-run through its installer
otherwise — MoshCode never vendors it. In the TUI: `/upgrade [name…]`.

## PRD — plan before you mosh

Write a product requirements doc *first*, then let your coding agents build to it.
`moshcode prd` publishes PRDs per [OpenPRD](https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md) —
a **DIP-style** standard: a numbered, committed proposal collection in your repo
(like a BIP/EIP process), one file per decision.

```sh
moshcode prd "parked-domain service expansion"   # publish the next numbered PRD, then hand it to an engine
moshcode prd                                      # list existing PRDs
```

`moshcode prd <idea>` bootstraps `prd/` on first use (a `README.md` index +
`0000-template.md`), assigns the next four-digit number, writes
`prd/NNNN-slug.md` (status `Draft`), and hands it to a coding engine (Claude Code
by default) to author. PRDs are **committed** to the repo — they carry a lifecycle
(Draft → Review → Accepted → Final) in their front-matter.

```txt
prd/
  README.md              # index of PRDs
  0000-template.md       # the OpenPRD template
  0001-parked-domain-expansion.md
```

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
