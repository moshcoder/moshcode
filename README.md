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

A metal scripting toolkit — **secretly all JS is legal**. The simple surface
stays dead-simple, but a `.mosh` file is real JavaScript under the hood with the
full moshcode command vocabulary injected as globals:

```js
// alive.mosh — the starter script (unchanged, still works)
while (alive) {
  code();
  mosh();
  notify();
  repeat();
} // no bugs, only features
```

The secret that it's all JS — no new syntax to learn:

```js
// deploy-agents.mosh — real work, still reads like the toy
const engines = ["claude", "codex"];
for (const e of engines) {
  install(e);                                  // → moshcode install <e>
}
mcp("install", "https://mcp.sentry.dev/mcp");  // fan out across engines
say(`ready to mosh with ${engines.length} engines`);
agents("claude");                              // drop into an autonomous session
```

### Run

```sh
moshcode run examples/alive.mosh              # run a script
moshcode run deploy.mosh --dry-run            # narrate without executing
moshcode run alive.mosh --max 5               # bound the while loop (default 3)
moshcode run deploy.mosh staging --fast       # extra args reach the script as argv
moshcode run - < script.mosh                  # pipe/paste from stdin
moshcode commands                             # list the full vocabulary
```

No install/build step — it's plain ESM. `node bin/moshcode.mjs …` works too.

### Shebang — self-running scripts

`.mosh` files support shebang lines, so `chmod +x` makes them run like shell
scripts. The `moshscript` executable is installed alongside `moshcode`:

```js
#!/usr/bin/env moshscript
// deploy.mosh — chmod +x it and run it like any shell script
install("claude");
agents("claude");
```

```sh
chmod +x deploy.mosh
./deploy.mosh                        # shebang → moshscript → moshcode run
./deploy.mosh --dry-run staging      # args after the file reach the script
```

### Commands

**Local verbs** (moshscript-only, in-process):

| verb | description |
|---|---|
| `code()` | compile features (no bugs) |
| `mosh()` | open the pit + blast the moshcoding playlist |
| `notify(msg)` | fire-and-forget ping + approval link on moshcode.sh |
| `ask(prompt)` | blocking gate — waits for human reply at moshcode.sh |
| `say("…")` | print a line |
| `sleep(ms)` | pause for N milliseconds (blocking) |
| `stop()` | end the loop (`alive = false`) |
| `repeat()` | back to the top of the loop |

**CLI verbs** (each shells out to `moshcode <name> ...args`):

| verb | description |
|---|---|
| `agents(engine)` | launch an autonomous agent session |
| `start(engine)` | raw-launch an engine |
| `install(target)` | install an engine or workflow tool |
| `upgrade(targets…)` | upgrade moshcode, engines, and tools |
| `mcp(args…)` | register/fan out an MCP server |
| `skill(args…)` | install a skill across engines |
| `prd(idea)` | publish/author an OpenPRD doc |
| `ugig(args…)` | drive the ugig workflow CLI |
| `coinpay(args…)` | drive the coinpay workflow CLI |
| `c0mpute(args…)` | drive the c0mpute workflow CLI |
| `pwd()` | print the current repo/location |
| `run(file)` | run another .mosh file (include/compose) |

**Specials** (injected globals, not commands):

| name | description |
|---|---|
| `alive` | `true` while the loop may continue; reads bounded by `--max` |
| `argv` | positional args passed after the script file |
| `env` | `process.env` — parameterize scripts from the environment |

### Human-in-the-loop

- `notify(msg)` — fire-and-forget. Pings the operator across configured channels
  and surfaces an approval link at `app.moshcode.sh/approve/:id`. Returns `{ id, url }`.
- `ask(prompt)` — blocking gate. Same ping + link, then **blocks** until the
  operator opens the link, reads the context, types instructions, and submits.
  Resolves with their text (or `null` on timeout). Use with `await`:

```js
const task = await ask("what should I work on next?");
say(`got it: ${task}`);
```

### Dry run

`--dry-run` narrates every action without executing it — no engine spawns, no
installs, no network POSTs, no PRD writes:

```
$ moshcode run deploy.mosh --dry-run
🎸 moshcode — running moshscript (dry run)

  ▶ install(claude) → would run: moshcode install claude
  ▶ mcp(install, https://mcp.sentry.dev/mcp) → would run: moshcode mcp install …
  💬 ready to mosh with 2 engines
  ▶ agents(claude) → would run: moshcode agents claude

✓ 0 loop(s) — no bugs, only features. 🤘
```

### Add your own commands

The vocabulary is open for extension via the registry:

```js
import { moshVocabulary } from "moshcode/src/commands.mjs";
import { runScript } from "moshcode/src/runtime.mjs";

const commands = moshVocabulary();
commands.register({ name: "deploy", summary: "ship it", run: (ctx) => ctx.out("shipping…") });
await runScript(src, { commands });
```

## Env

| var | default | purpose |
|---|---|---|
| `MOSHCODE_API` | `https://moshcoding.com` | web-notifications endpoint host |
| `MOSHCODE_SITE` | `https://app.moshcode.sh` | approval URL base |
| `MOSHCODE_WEBHOOK_URL` | — | optional extra webhook for `notify()` |
| `MOSHCODE_WEBHOOK_SECRET` | — | signs notify() posts |
| `MOSHCODE_PLAYLIST` | Spotify playlist URL | what `mosh()` blasts in the browser |
