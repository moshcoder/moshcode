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

## Commands

`moshcode help <command>` drills into any of these — flags, examples and all.
`moshcode help --json` is the same thing for a machine.

This table is generated from the command table the CLI itself dispatches from
(`moshcode help --markdown`), so it cannot describe a verb that does not exist
or miss one that does. A test fails the build when it drifts.

<!-- COMMANDS:START -->
| command | group | what it does |
|---|---|---|
| `moshcode agents` | engines | list engines or launch one autonomously |
| `moshcode start` | engines | launch an engine with its native defaults |
| `moshcode herd` | runtime | run agent sessions that outlive this terminal |
| `moshcode ps` | runtime | list herd sessions and what each one is doing |
| `moshcode cost` <br>`usage` | runtime | what each session is spending, read from the engines' own logs |
| `moshcode attach` | runtime | attach this terminal to a herd session |
| `moshcode kill` | runtime | end a herd session |
| `moshcode wait` | runtime | block until a session is blocked, done, or idle |
| `moshcode restore` | runtime | rebuild the herd's sessions after a reboot |
| `moshcode install` | engines | install an engine or workflow tool |
| `moshcode uninstall` <br>`remove` | engines | take an engine or workflow tool off this machine |
| `moshcode upgrade` <br>`update` | engines | update moshcode, engines, or tools |
| `moshcode mcp` | extend | register and inspect MCP servers |
| `moshcode skill` <br>`skills` | extend | install and inspect agent skills |
| `moshcode prd` | script | publish or list product requirement documents |
| `moshcode login` | account | authenticate with app.moshcode.sh |
| `moshcode whoami` | account | show the logged-in account |
| `moshcode logout` | account | clear the logged-in account |
| `moshcode save` | account | save this machine's pit settings to your account |
| `moshcode load` | account | bring your saved pit settings onto this machine |
| `moshcode console` | account | serve or connect to the browser terminal |
| `moshcode dns` | hosting | resolve Moshpit names on this machine |
| `moshcode name` | hosting | prove you hold a Moshpit name, so an app can use it as your identity |
| `moshcode doh` | hosting | run the DNS-over-HTTPS resolver |
| `moshcode site` <br>`serve` | hosting | install web-server config for a Moshpit name |
| `moshcode template` <br>`templates` | hosting | scaffold a stack for a Moshpit-hosted service |
| `moshcode shorten` <br>`short` `link` | hosting | mint a short link on the pit — /f/<code> follows to your url |
| `moshcode games` <br>`game` `arcade` | arcade | the moshcode arcade — twenty-two games, no menus |
| `moshcode pwd` <br>`where` | system | show the current directory and git context |
| `moshcode engines` | engines | list engines and installation status |
| `moshcode tools` | tools | list workflow tools and installation status |
| `moshcode trade` | tools | look up markets and trade through Alpaca |
| `moshcode stocks` <br>`advisor` | tools | equity research from advis0r.com |
| `moshcode crypto` <br>`coins` | tools | crypto market data from advis0r.com |
| `moshcode news` | tools | headlines from your feeds, or a search |
| `moshcode rss` | tools | read the same headlines in a full-screen reader |
| `moshcode timer` | business | track time — on, off, and what it added up to |
| `moshcode client` <br>`business` `merchant` `customer` | business | who the work is for — clients, businesses, merchants |
| `moshcode team` <br>`teams` | business | who may do what on this machine |
| `moshcode rate` <br>`rates` | business | what an hour of agent time costs |
| `moshcode billing` <br>`invoice` | business | turn tracked time into an invoice |
| `moshcode payments` | business | the rail invoices go out on |
| `moshcode plugin` <br>`plugins` | extend | install moshcode's slash commands into Claude Code |
| `moshcode commands` | script | list built-in moshscript commands |
| `moshcode completion` | extend | print a shell completion script |
| `moshcode run` | script | run a moshscript |
| `moshcode help` <br>`--help` `-h` | system | show command help |
| `moshcode version` <br>`--version` `-v` | system | show the installed version |
<!-- COMMANDS:END -->

## Engines

```sh
moshcode engines            # list installable engines
moshcode engines --json     # machine-readable install status for automation
moshcode install opencode   # install opencode (curl … | bash)
moshcode install privacycode # curl -fsSL https://getprivacycode.com/install | sh
moshcode install claude     # npm i -g @anthropic-ai/claude-code
moshcode install codex      # npm i -g @openai/codex
moshcode install kimi       # curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
moshcode install qwen       # npm i -g @qwen-code/qwen-code
moshcode install deepseek   # npm i -g @serjm/deepseek-code
moshcode install openagents # curl -fsSL https://openagents.org/install.sh | bash
```

`openagents` is the odd one out: a launcher that supervises the engines above
rather than a coding agent itself. Its installer ends by offering to pair the
machine with a workspace — press Enter to skip that.

### Autonomous agents versus raw starts

`agents` opens the engine's native **agent view** when it has one, so you land on
your agent list. Engines without an agents view instead start an autonomous
session by injecting the engine's native bypass or auto-approval mode. Either way,
use this only in an isolated container, VM, or workspace you trust:

```sh
moshcode agents claude      # claude agents --dangerously-skip-permissions  (agent view)
moshcode agents opencode    # opencode --auto                              (autonomous)
moshcode agents privacycode # privacycode --auto                           (autonomous)
moshcode agents codex       # codex --dangerously-bypass-approvals-and-sandbox  (autonomous)
moshcode agents gemini      # gemini --approval-mode=yolo                       (autonomous)
moshcode agents kimi        # kimi --yolo                                       (autonomous)
moshcode agents qwen        # qwen --approval-mode=yolo                         (autonomous)
moshcode agents deepseek    # deepseek-code --turbo                             (autonomous)
moshcode agents aider       # aider --yes-always                                (autonomous)
moshcode agents openagents  # openagents                                        (dashboard)
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

## The herd — sessions that outlive your terminal

Every launch above hands an engine the whole terminal and waits. That is why
they feel native, and it is also why the pit can only do one thing at a time and
why closing the lid kills the work.

The herd inverts it. Add `-d` and the session runs in a runtime that outlives
the pit, so you get your prompt back immediately:

```sh
moshcode start claude -d --name api      # runs in the background, prompt returns
moshcode agents codex -d                 # autonomous, and still detached
moshcode ps                              # who is running, and who wants you
moshcode attach api                      # step in; Ctrl-b d steps back out
moshcode kill api                        # end it
```

### Everything on screen at once

```sh
moshcode herd tile
```

```
┌─ work ──────────────────┬─ logs ──────────────────┐
│ $ npm test              │ tailing deploy.log      │
│ ✓ 1492 passing          │ 12:04 build ok          │
├─ api ───────────────────┴─────────────────────────┤
│ claude — Do you want to proceed?                  │
│ ❯ 1. Yes    2. No                                 │
└───────────────────────────────────────────────────┘
 herd            S:shell A:agent X:stop B:pop out z:zoom
```

Every member becomes a tile in one window. Click a tile to focus it, `Ctrl-b z`
to blow it up full-screen and again to come back, `Ctrl-b d` to leave the lot
running. Start and stop without leaving:

| key | |
|---|---|
| `Ctrl-b S` | new shell tile |
| `Ctrl-b A` | new claude tile |
| `Ctrl-b X` | stop the focused tile |
| `Ctrl-b B` | pop it out into its own session |
| `Ctrl-b z` | zoom / unzoom |

`moshcode herd untile` puts them all back in their own sessions. Tiling is just
a view — the processes never restart, and a tiled member stays on `moshcode ps`
and answers `read`, `prompt` and `wait` exactly as before.

Needs tmux. The `script(1)` fallback gives each session its own pty with no way
to lay them out together, so it says so and points at the list instead.

### The workspace

```sh
moshcode herd ui
```

```
┌ herd ──────┬─ api ─────────────────────────────┐
│ herd       │                                   │
│            │  claude                           │
│ MAIN       │  Do you want to proceed?          │
│ ▸ ! api    │  ❯ 1. Yes                         │
│   · work   │    2. No                          │
│ SCRATCH    │                                   │
│   · logs   │                                   │
│            │                                   │
│ ACTIONS    │                                   │
│   + shell  │                                   │
│   + agent  │                                   │
│   ✕ stop   │                                   │
│   ⊞ tile   │                                   │
│   ← detach │                                   │
│            │                                   │
│ enter ▸ …  │                                   │
│ F12 ▸ …    │                                   │
├────────────┴───────────────────────────────────┤
│ mosh ▸ ps · start claude · show <n> · detach   │
└────────────────────────────────────────────────┘
```

Members and actions down the left, the selected member's **real terminal** on
the right. Click a member to show it; click an action to start a shell, start an
agent, or stop the selected one. `q` detaches and leaves everything running.

Click the member that is already on screen — or press Enter — and the keyboard
goes to it, so you are typing at the agent itself.

### The mosh bar

The row along the bottom is a mosh prompt, and it is always there. **F12** jumps
to it from anywhere, including from inside an agent that has taken the keyboard,
which makes it the way out of a session you cannot otherwise leave. Esc goes
back to the session; `detach` leaves with everything still running.

It takes any `moshcode herd` verb, so you can start a second agent without
leaving the first:

```
mosh ▸ start claude          # another agent, now on screen
mosh ▸ show api              # put a different member up
mosh ▸ ps                    # the roster, over the session, then out of the way
```

`attach` means `show` here — in a workspace the word means "put it in the
content pane", and the real attach would be a tmux client inside a tmux client.
Output grows the bar over the content for as long as you are reading it, then it
collapses back to one row.

**`moshcode attach <name>` gets the bar too.** A session you attach to directly
grows the same one-line prompt along the bottom for as long as you are there,
and it is taken away again when you detach — so a member is a plain member when
nobody is looking at it. `show <name>` from that bar switches you to another
member (and gives that one a bar before you land in it). The bar is the bottom
row either way, which is why one key finds it in both places.

The right-hand pane is not a picture of a session — it *is* the session's pane,
moved in. tmux's model is session → window → pane, so moving between *windows*
cannot keep anything on screen; but `join-pane` moves a running pane into an
existing window, so swapping only the content pane leaves the sidebar untouched.
Both panes keep their process and their scrollback because tmux is moving the
real thing, not redrawing it.

Group sessions with `--herd <name>` when you start them; anything without one is
in `main`. Without tmux there is nothing to swap panes with, so `herd ui` falls
back to a plain clickable list.

### A workspace: a few shells and an agent

This is what most people actually want — a couple of shells to work in and an
agent or two running beside them, none of which die when the terminal does:

```sh
cd ~/src/coinpay
moshcode herd shell --name work          # a plain $SHELL
moshcode herd shell --name logs          # another
moshcode agents claude -d --name api     # and an agent
```

```sh
$ moshcode ps
  api    claude  blocked   ~/src/coinpay   3m   screen
  logs   shell   idle      ~/src/coinpay   3m   screen
  work   shell   idle      ~/src/coinpay   3m   screen

⚠ 1 waiting on you — moshcode attach api
```

`moshcode attach work` puts you in one; `Ctrl-b s` hops between all three;
`Ctrl-b d` leaves the lot running. Close the laptop and they are still there.

### Agents moshcode does not ship

`start` only knows the engines moshcode installs. `run` takes anything —
an agent with no install spec here, a build, a script:

```sh
moshcode herd run --name cur -- cursor-agent
moshcode herd run --name build -- npm run watch
```

Everything after `--` is the command, flags and all. These get a roster entry
and the same state detection as a known engine: the shared rules match what a
terminal *draws* — a y/n prompt, a numbered menu, "esc to interrupt" — not
anything engine-specific, so an agent moshcode has never heard of still shows up
`blocked` when it stops to ask you something.

Close the terminal, drop the SSH link, come back tomorrow — `moshcode ps` still
answers, and `moshcode attach` puts you back inside. In the pit the same verbs
are `/ps`, `/attach`, `/kill`, and the roster prints on the way in.

### Switching between them without leaving

Every session lives in one tmux server that moshcode owns, so once you are
attached to any of them you can move around the whole herd without going back to
the pit:

| key | |
|---|---|
| `Ctrl-b s` | pick from a list of every session |
| `Ctrl-b )` / `Ctrl-b (` | next / previous session |
| `Ctrl-b L` | back to the one you were just in |
| `Ctrl-b d` | detach — the session keeps running |

That server is started without your `~/.tmux.conf`, so these are the stock
bindings whatever your own tmux does with the prefix. Under the no-tmux fallback
there is no switcher: detach with `Ctrl-]` and `moshcode attach <name>` the next
one.

### Which one needs you

Every session carries a state: `working`, `blocked`, `done`, `idle`, or
`unknown`. `blocked` means a human decision is the only thing missing.

```
  api       claude  blocked   ~/src/coinpay        12m   hook
  web       codex   working   ~/src/ugig.net        4m   screen
  audit     opencode  done    ~/src/moshpit-dns     1h   runtime
```

State comes from one authority per session, never two. An engine that reports
through a lifecycle hook (`moshcode herd report <name> <state>`) is believed and
its screen is not second-guessed; everything else is classified from the bottom
of its screen. Nothing recognisable reads `unknown`, which is a safe answer —
detection never gates a launch. Patterns that go stale can be fixed in
`~/.moshcode/herd/rules.json` without waiting for a release.

Blocked can also come and find you, using the same notification fan-out as
`notify()`/`ask()`:

```sh
moshcode herd notify on --ask            # email/SMS/Slack/Telegram/push
moshcode herd start claude --name watch  # then run `moshcode herd watch` in the herd
```

With `--ask`, whatever you reply is typed into the session that was waiting.

### What it is costing

Every engine already writes down what it used, so nothing has to be
instrumented or proxied — `moshcode cost` reads the CLIs' own session logs and
lines them up against the herd:

```sh
moshcode cost                    # per session, in the window (default: 24h)
moshcode cost api                # one session, with its engine runs
moshcode cost --all --since 7d   # every engine session on the box, herd or not
moshcode cost --watch            # the same report, re-read every 10s
moshcode cost --json             # for a script
```

```
  session  engine  model          in    out   cache  cost    age
  api      claude  claude-opus-5  1.2k  27k   10.5M  $9.91~  42m
  audit    codex   gpt-5.6-sol    400   200   600    —       12m

  total  $9.91~  1.6k in · 27k out · 10.5M cached
  ~ estimated from published rates; unmarked figures are the engine's own.
⚠ no rate for gpt-5.6-sol — tokens counted, cost omitted.
```

| engine | where the number comes from |
|---|---|
| claude | per-message `usage` in `~/.claude/projects/**/*.jsonl` |
| codex | cumulative `token_count` events in `~/.codex/sessions/…` |
| opencode, privacycode | the per-message `cost` each one computed itself |
| aider | the running session total it prints into `.aider.chat.history.md` |

**A `~` is an estimate, and an unmarked figure is not.** opencode and aider
price their own messages, and that price is reported untouched. Claude Code and
Codex record tokens only — which is the honest state of things on a
subscription, where the marginal request costs nothing extra — so those are
multiplied by published rates to answer "what would this have cost on the API".

A model nobody has priced shows its tokens and no cost, rather than a
convincing-looking zero. Price it yourself in `~/.moshcode/pricing.json`:

```json
{ "gpt-5.6-sol": { "input": 1.25, "output": 10 } }
```

Cache tokens get their own column because on a long agent session they are most
of the traffic and a tenth of the price; folding them into `in` makes a $3
session look like a $60 one. Attribution is engine + directory + "started before
this run did", so a session that shares a directory with another agent can pick
up its neighbour's work — `--json` carries the run list when you need to check.
gemini, kimi, qwen, deepseek and openagents keep no readable usage log, so they
report no cost rather than zero cost.

### Driving it from a script or another agent

There is no second API — every verb takes `--json`, and that is what a machine
reads. `wait` exists to be branched on: exit `0` matched, `2` timed out, `3` no
such session.

```sh
moshcode herd start claude --name api --json
moshcode herd prompt api "port the auth routes" --wait
moshcode herd read api --lines 40
moshcode wait api --state blocked --timeout 1h
```

moshscript gets the same surface as values rather than exit codes, which is what
makes fan-out practical:

```js
herdStart("claude", { name: "api" });
herdStart("codex",  { name: "web" });
herdPrompt("api", "port the auth routes");
herdPrompt("web", "port the dashboard");
await herdWait("api"); await herdWait("web");
say(herdRead("api", { lines: 20 }));
```

Fanning work out is easy; joining on it used to be a hand-rolled polling loop.
`--any` returns on the first session to get there, `--all` when the last one
has, and both take the same `--state` and `--timeout` as a single wait:

```sh
moshcode wait --any api web docs           # --json names the winner
moshcode wait --all api web --state done
```

```js
const first = await herdWait(["api", "web", "docs"], { any: true });
await herdWait(["api", "web"], { states: ["done"] });
```

### Let the engine say what it is doing

Reading a screen works and it rots — engines change their wording between
releases and nothing tells you. When an engine has lifecycle hooks, install
them once and its state comes from the engine itself:

```sh
moshcode herd hooks install claude
✓ claude — 3 hooks installed (stop, notification, prompt-submit)
```

`moshcode ps` then reads `hook` in its last column instead of `screen`. The
file is **merged, never clobbered** — your own hooks stay, and `hooks remove`
takes out only what moshcode put in. A hook that fires outside a herd session
does nothing and exits 0, so installing one cannot break an engine you run by
hand, and the screen rules stay as the fallback for everything else.
`moshcode herd doctor` says what is installed, what has drifted, and — for the
first time — what is wrong with your `rules.json` instead of ignoring it.

### What happened while you slept

Every prompt through the herd mints a **task**: an id, its state transitions
with timestamps, and the output it produced. `ps` still answers "now"; this
answers "what happened".

```sh
$ moshcode herd tasks api
  t-01  22:14  done      4m     "port the auth routes"
  t-02  22:19  blocked   6h11   "run the migration"

$ moshcode herd task t-02        # transitions, and what came back
$ moshcode herd log api          # the raw state history
$ moshcode herd stats api
api          working 3h02 · blocked 6h11 · idle 1h40
  blocked 6h11 over 2 spell(s) — that one is you
```

Blocked time is the herd's name for *human latency*: the agent was ready and
you were asleep. Ledgers live in `~/.moshcode/herd/tasks/<session>.jsonl` at
`0600`, capped at the last 500 tasks per session. From a script,
`herdTasks(name)` and `herdTask(id)` return them as values.

### Agents that are not on this box

A deployed agent can be a herd member. Two kinds: `a2a` speaks
[A2A v0.3.0](https://a2a-protocol.org/v0.3.0/specification/) (card discovery,
`message/send`, `tasks/get`, `tasks/cancel`), and `run` is a bare endpoint that
takes `POST {"prompt": …}` — the shape a `gradient agent deploy` prints.

```sh
moshcode herd remote add research https://agents.do-ai.run/…/production --kind run
export MOSHCODE_REMOTE_RESEARCH_TOKEN=…       # never written to the manifest, never synced
```

```
$ moshcode ps
  api        claude   blocked   ~/src/coinpay      12m   hook
  research   remote   idle      agents.do-ai.run   —     remote
```

`prompt`, `read`, `wait` and `kill` work on it unchanged, which is the point: a
fan-out script across a local pty and a deployed agent contains no `if
(remote)`. A remote's state is the *remote's claim* — `ps` says `remote` in the
last column so it is never mistaken for something this box verified — and
`kill` on one deregisters it here rather than reaching across the network to
end somebody else's agent.

### The herd, over A2A

`moshcode herd serve` exposes this machine's herd to any A2A client: the herd's
card at `/.well-known/agent-card.json`, each member at `/<name>/`,
`message/send` → prompt, `tasks/get` → the ledger, `tasks/cancel` → interrupt.
`blocked` is A2A's `input-required`; the states that do not map cleanly round
down and carry the honest one in task metadata.

```sh
moshcode login                 # it verifies tokens against app.moshcode.sh
moshcode herd serve            # 127.0.0.1:7683 by default
```

It is a shell on a socket and is treated like one: **no unauthenticated mode,
loopback included**, a loud warning past `127.0.0.1`, and sessions started with
`--agent` withheld unless you pass `--expose-autonomous` — an engine with its
approvals bypassed plus a network prompt is the worst pairing on the menu.

### Which engine is best at *this* repo

Not a leaderboard run against engines nobody deploys on repos nobody has — your
dataset, your engines, your machine:

```sh
moshcode herd eval --dataset evals/moshcode.jsonl --engines claude,codex --threshold 0.8
```

A row is `{"prompt": "…", "expect": "pattern"}` or
`{"prompt": "…", "rubric": "…"}` (jsonl, json or csv). Scoring is either the
dataset's own patterns or an engine acting as judge (`--judge claude`). Exit
codes are distinct on purpose — `0` pass, `4` below the threshold, `5` the
harness could not run — because CI has to tell a worse agent from a broken box.

### After a reboot

```sh
moshcode restore --dry-run       # what would come back
moshcode restore --resume        # and ask each engine to reopen its conversation
```

This brings back the *shape* — the sessions, in their directories, on their
engines. The processes are new. Work that was in flight is not still running,
and `--resume` only reaches engines that have a resume flag of their own.

### What it runs on

`tmux` when the box has it: real resizing, scrollback, native attach. Without
tmux, sessions run under `script(1)` with their input on a FIFO — they work and
they persist, but their size is fixed when they start. With neither, launches
stay in the foreground and say so once. moshcode does not turn a soft dependency
into a hard one, so `-d` never fails; at worst it degrades and tells you what
would fix it.

The session manifest and every transcript are written `0600`: engine argv and
engine output both carry secrets.

### Parallel pit tabs

At the mosh prompt, `/new` opens and switches to another independent moshcode
tab. Run `/agents <engine>` in each tab and switch between them with tmux's
`Ctrl-b n`, `Ctrl-b p`, or `Ctrl-b <number>` keys. If moshcode is already inside
tmux, `/new` adds a window to that session and respects its configured window
keys. Otherwise the first `/new` opens an isolated two-tab workspace with those
default keys and its tab bar at the bottom.

Each tab is a separate moshcode process and provider CLIs still receive an
ordinary inherited terminal. Moshcode does not intercept or reinterpret their
input, output, full-screen UI, or provider-specific shortcuts. The feature
requires `tmux`; without it `/new` reports that requirement and leaves the
current pit untouched.

The modes are not identical across providers. In particular, OpenCode `--auto`
auto-approves permission requests but continues to enforce explicit deny rules.

## Workflow tools: UGig, CoinPay, and the cloud CLIs

These remain independent native CLIs with their own authentication,
configuration, command trees, output formats, and release cycles. MoshCode
installs them and passes control through without reimplementing their APIs.

The primary development toolchain runs through `moshcode` as a
[dev.profullstack.com](https://dev.profullstack.com/) user.

```sh
moshcode tools                    # list tools and native install status
moshcode tools --json             # machine-readable install status for automation
moshcode install ugig             # runs the vendor's official install script
moshcode install coinpay          # same — each tool owns its installer

moshcode ugig --json gigs list    # arguments/output go straight to ugig
moshcode coinpay wallet balance   # arguments/output go straight to coinpay
```

### BufferOverride — the failure in front of you, already answered

[BufferOverride](https://bufferoverride.com) is where humans and agents debug
together: every answer declares the versions it works on, who or what wrote it,
and whether anyone independent reproduced it. `bo` is that from a terminal.

```sh
moshcode install bo               # npm i -g @profullstack/bufferoverride

moshcode bo run -- pnpm test      # run it, keep what it printed, search for it
moshcode bo search "worker exited before finishing"
moshcode bo get a1b2c3d4e5 --markdown
```

The product is BufferOverride and the binary is `bo` — the same split
`secrets`/`logicsrc` and `spinifex`/`spx` have, keyed the short way round here
because this is a command you type every time something fails.

`bo run --` wraps a command rather than replacing it: the wrapped command's exit
code passes straight through, so it can go in front of something already in CI
without changing what CI sees. It captures stdout, stderr, the exit code, the
OS, the architecture and the detected dependency versions, redacts what it
recognises as a secret, and searches for the failure **before** offering to
publish it. Nothing leaves the machine until you have seen it, and outside a TTY
nothing is published at all unless you pass `--ask`.

Redaction is best effort and cannot be complete — no pattern list catches a
custom-format secret — so `--dry-run` is the habit its own docs ask for.

Reads need no credential: `search` and `get` work before you have ever run `bo
login`. Publishing needs one, and `bo login` is a device-code exchange, so a
terminal never handles a browser session. `bo mcp config` prints the MCP
registration for a coding agent, which is the same graph over a different door.

### Cloud + infra CLIs

```sh
moshcode install railway          # npm i -g @railway/cli
moshcode install gh               # GitHub release binary → ~/.local/bin
moshcode install supabase         # GitHub release binary (no global npm package exists)
moshcode install doppler          # official script, installed user-local (needs gpgv)
moshcode install doctl            # GitHub release binary → ~/.local/bin
moshcode install turso            # official script → ~/.turso (new shell to pick up PATH)
moshcode install tailscale        # official script; system daemon, so it needs root
moshcode install coral            # official script → ~/.local/bin (checksum-verified)
moshcode install spinifex         # official script; Linux host platform, so it needs root

moshcode gh pr list               # straight through to the native CLI
moshcode railway up
moshcode doctl compute droplet list
moshcode spinifex ec2 describe-instances
```

### Spinifex — your own AWS-compatible cloud

[Spinifex](https://mulgadc.com/spinifex) is the other end of the infra list:
instead of driving someone else's cloud, it turns your own hardware into one.
EC2, EBS, S3, VPC, and IAM, API-compatible with AWS, on bare metal, edge boxes,
or on-prem racks — so the same `aws` calls and Terraform providers work against
hardware you own.

```sh
moshcode install spinifex         # curl -fsSL https://install.mulgadc.com | bash
moshcode spinifex version         # straight through to the native `spx` CLI
moshcode spinifex admin init --node node1 --nodes 1
```

The product is Spinifex, the binary is `spx`, and `moshcode spinifex …` is exact
passthrough to it — the same split as `moshcode secrets` and `logicsrc`.

Spinifex is a host platform, not a standalone binary, so its installer is the
most invasive one on this list. Read this before running it:

- **Linux only**, and specifically Ubuntu 26.04 or Debian 13. The installer
  pulls QEMU/KVM, OVN/Open vSwitch, and the AWS CLI through apt.
- **Root.** It writes `/usr/local/bin/spx`, systemd units, and scoped
  `sudoers.d` rules. Like tailscale, it finds sudo itself; MoshCode only gets
  the password prompt out of the way first.
- **Your WAN interface must already be bridged to `br-wan`** before you start —
  check with `ip -br link show br-wan`. The installer does not create it, and
  bridging a live uplink can drop the box off the network.

After it finishes, Spinifex's own docs take over — `setup-ovn.sh --management`,
`spx admin init`, then `systemctl start spinifex.target`. See
[docs.mulgadc.com/docs/install](https://docs.mulgadc.com/docs/install).

MoshCode passes `INSTALL_SPINIFEX_SKIP_NEWGRP=1`, because on a TTY the vendor
script ends by `exec`ing `newgrp spinifex` to activate the new group. That would
strand you in a subshell instead of returning to the pit — and would park the
rest of a `moshcode update` run behind it. Log in again (or run `newgrp
spinifex` yourself) to pick up the group.

Re-running `moshcode install spinifex` is also its upgrade path: the installer
detects the existing install, replaces the binary, applies pending config
migrations, and restarts the services.

### MCP server testing

```sh
moshcode install mcpjam           # npm i -g @mcpjam/cli

moshcode mcpjam --help            # straight through to the native CLI
```

MCPJam is the companion to `moshcode mcp`: `mcp` registers a server across your
engines, `mcpjam` tells you whether that server is healthy first — health
checks, OAuth conformance, tool-surface diffing, and structured triage from the
terminal or CI. Re-running `moshcode install mcpjam` is also its upgrade path.

### ElevenLabs — Eleven Agents, voices, and speech

```sh
moshcode install elevenlabs       # npm i -g @elevenlabs/cli

moshcode elevenlabs auth login    # PKCE OAuth, stored in the system keyring
moshcode elevenlabs agents list
moshcode elevenlabs agents push   # upload local agent configs to the platform
moshcode elevenlabs text-to-speech convert …
```

[ElevenLabs](https://elevenlabs.io/docs/eleven-agents/operate/cli)' CLI manages
**Eleven Agents** — conversational voice agents you define in files and
`push`/`pull` against their platform, alongside the knowledge bases, tools,
tests and phone numbers those agents use. The same binary reaches the rest of
the API: voices, text-to-speech, dubbing, transcription, music, and workspace
usage.

They are agents in a different sense than the ones under `/agents`: you deploy
them and callers talk to them, rather than handing your terminal to one. That is
why it sits here with the workflow CLIs — every subcommand runs one request and
exits, so it pipes like the rest of the roster. `--format json` (the default
when stdout is not a TTY) and `--query` (JMESPath) are what a script wants.

The npm package is a small shim over a native binary shipped as an optional
dependency, so install it without `--omit=optional` or the `elevenlabs` on your
PATH will refuse to run. Re-running `moshcode install elevenlabs` is its upgrade
path.

### Alchemy — onchain data, wallets, and x402

```sh
moshcode install alchemy          # npm i -g @alchemy/cli

moshcode alchemy auth             # browser login, then pick an app
moshcode alchemy evm balance --address 0x…
moshcode alchemy --json --no-interactive wallet send …
```

[Alchemy](https://www.alchemy.com/)'s CLI covers four things from one binary:
querying onchain data across EVM and Solana (balances, NFTs, transfers, prices,
blocks, logs, traces, simulations, raw RPC), managing Alchemy apps, networks,
allowlists and webhooks, driving an agent-ready wallet (sends, swaps, contract
calls, approvals, cross-chain bridges), and paying third-party x402 APIs in
USDC under a spend cap.

`alchemy auth` opens a browser to link your account and saves the selected app's
API key; API keys and x402 wallet auth work too, depending on the command. Pass
`--json --no-interactive` when a script or agent is driving, which is also what
makes it read like the rest of the roster in a pipeline. It needs Node 22 or
newer, and re-running `moshcode install alchemy` is its upgrade path.

Where CoinPay is the payments product MoshCode ships alongside, Alchemy is the
read side of the same world — the chain itself rather than one wallet's ledger.

### yt-dlp, ffmpeg, ImageMagick — the media toolchain

```sh
moshcode install yt-dlp           # static binary → ~/.local/bin
moshcode install ffmpeg           # your distro's package manager (needs sudo)
moshcode install imagemagick      # likewise

moshcode yt-dlp https://…         # or `dl https://…` from cli-tools
moshcode ffmpeg -i in.mkv out.mp4
```

The odd three out: not workflow CLIs, but the media toolchain the rest of the
roster is built on. `cli-tools` fronts all three — `dl` for yt-dlp, `vid` for
ffmpeg, `img` for ImageMagick — and every one of them used to answer a missing
binary by telling you to go and install a system package by hand. Now the
registry that installs `cli-tools` installs what it runs on.

**yt-dlp** comes from its own releases as a self-contained binary, so it needs
no python and no package manager. That is deliberate rather than convenient:
extractors break whenever a site changes its markup, upstream ships a fix within
days, and a distro package of yt-dlp is frozen for the life of a release. Its
upgrade is `yt-dlp -U`, the project's own updater.

**ffmpeg** and **ImageMagick** exist only as distro packages — no vendor script,
and the static rebuilds floating around are unsigned third-party redistributions
of somebody else's codec stack, on the two tools most likely to be pointed at a
file from the internet. So they go through `apt`/`dnf`/`zypper`/`pacman`/`apk`,
or Homebrew on macOS, and ask for sudo everywhere but a Mac (see below).
Re-running the install upgrades them.

ImageMagick answers to two names: `magick` on version 7, `convert` on 6, both
current across supported distros under the same package name. MoshCode looks for
either, so a good install is never reported missing.

`gh`, `supabase`, and `doctl` publish no cross-platform install script, so
MoshCode resolves the latest GitHub release and drops the binary in
`$MOSHCODE_BIN` (default `~/.local/bin`) — no sudo, no package manager. Set
`MOSHCODE_BIN` to install elsewhere.

`tailscale`, `spinifex`, `ffmpeg` and `imagemagick` are the exceptions: none of
them is a user-local binary, so they go through the distro's package manager and
will ask for sudo (tailscale on macOS delegates to the App Store, and `ffmpeg`
and `imagemagick` to Homebrew, which refuses to run as root — so neither is
prompted for a password on a Mac; Spinifex has no macOS build at all).

MoshCode asks for that password **before** starting the work rather than letting
the installer stop for it partway through — which matters most in `moshcode
update`, where tailscale is one step in a long unattended run and the prompt
would otherwise land where nobody is watching. Nothing is asked when the plan has
no privileged step in it, when a credential is already cached, or on macOS.

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

### Alpaca trading

Alpaca is a workflow tool, not a coding engine. Install its official Go CLI,
use `alpaca` for exact native passthrough, or use `trade` for the shorter market
and order vocabulary:

```sh
moshcode install alpaca            # go install github.com/alpacahq/cli/cmd/alpaca@latest
moshcode trade login               # Alpaca profile login; paper trading is the default
moshcode trade ticker AAPL         # asset get --symbol-or-asset-id AAPL
moshcode trade quote AAPL          # latest quote
moshcode trade analysis AAPL       # quote/trade/bar snapshot for analysis
moshcode trade watch               # list watchlists
moshcode trade positions           # list open positions
moshcode trade orders              # list open orders
```

`buy` and `sell` are safe previews unless `--submit` is explicit. Other Alpaca
order flags pass through, including limit prices and its separate live-trading
opt-in:

```sh
moshcode trade buy AAPL 1                          # adds --type market --dry-run
moshcode trade buy AAPL 1 --type limit --limit-price 185
moshcode trade buy AAPL --notional 100              # preview a $100 market buy
moshcode trade buy AAPL 1 --submit                 # places the paper order
moshcode trade raw data news --symbol AAPL         # any native Alpaca command
moshcode alpaca order submit --help                # exact native passthrough
```

The same facade is `/trade …` in the pit and `trade(…)` in moshscript.
Alpaca's CLI has no confirmation prompts; `--submit` intentionally removes
MoshCode's preview guard. Live trading additionally requires Alpaca's `--live`
opt-in or corresponding environment setting.

### Equity research (`moshcode stocks`)

Where `trade` is Alpaca's order book, `stocks` is the research desk:
[advis0r.com](https://advis0r.com/api)'s public read-only API, rendered in the
pit. No key, no login, no write routes, no binary to install:

```sh
moshcode stocks NVDA               # score, technicals, fundamentals, thesis, signals
moshcode stocks lookup rivian      # company name → RIVN
moshcode stocks signals AAPL       # what was said, quoted and sourced
moshcode stocks search "data center"  # across every indexed transcript
moshcode stocks reports --limit 10 # the stored index, best score first
moshcode stocks discover fusion    # a ranked watchlist (slow — analyzes each candidate)
moshcode stocks open NVDA          # the shareable report page
```

Add `--json` to any of them for the raw response. The same facade is `/stocks …`
in the pit, and `MOSHCODE_ADVISOR_URL` points it at another instance.

Reports are **stored snapshots**, not live quotes: every response carries
`reportGeneratedAt` and every renderer prints it, alongside whether the price is
delayed and which feed produced it. Scores labelled `offline` come from
deterministic rules rather than a model. It is a research aid, not advice, and
nothing under `stocks` can place an order.

### Crypto market data (`moshcode crypto`)

`crypto` is `stocks`'s sibling on the same host: advis0r's read-only crypto
routes over Alpaca's US crypto venue, which trades 24/7 and needs no extra
subscription.

```sh
moshcode crypto BTC                     # price, technicals, score, supply, order book
moshcode crypto lookup bitcoin          # asset name → BTC/USD
moshcode crypto quote ETH-USD           # latest trade + quote, spread in bps
moshcode crypto spark BTC ETH SOL       # recent moves across pairs, as sparklines
moshcode crypto bars ETH-USD --timeframe 1Hour   # historical OHLCV
moshcode crypto book BTC-USD --depth 5  # top of book, both sides
moshcode crypto assets                  # every supported pair
moshcode crypto open BTC                # the shareable page
```

Pairs are accepted as `BTC`, `BTC-USD`, `BTC/USD` or `BTCUSD` — a bare asset
resolves to that asset's USD pair. `--json` gives the raw response, `/crypto …`
is the same facade in the pit, and `MOSHCODE_ADVISOR_URL` points it elsewhere.

Unlike a `stocks` report, this is a **live venue read**, not a stored snapshot —
there are no transcripts, no filings and no signals behind a crypto pair, and
the failure mode runs the other way: the price is accurate to the second and
stale by the time you act on it. Every response stamps when it was fetched.

The technical score counts venue-local liquidity, so it is **not comparable** to
an equity's score, and each response ships the `caveats` that say so. Prices are
Alpaca's US venue alone and can differ materially from other exchanges. Research
aid, not advice — and like `stocks`, nothing under `crypto` can place an order.

### Aliases (`/alias`)

The pit is a prompt you sit at all day, so it lets you name the lines you keep
retyping. An alias runs in `$SHELL` unless it starts with `/`, in which case it
is a pit command:

```text
/alias set gs "git status"        # then /gs — and /gs -sb appends to it
/alias set cx "/agents codex"     # a pit command, not a shell one
/alias                            # what is defined
/alias rm gs
```

They live in `~/.moshcode/aliases.json` (owner-only, like the history file) and
survive between sessions. A name that is already a pit command, an engine, or a
tool is refused rather than shadowed — built-ins are dispatched first, so such
an alias would never run.

Some workflow tools ship a *set* of commands rather than one binary, and propose
short words for them. Installing such a tool configures those words too — a
dispatcher fronting seven commands is not reachable from the pit until the names
that reach them exist:

```text
/install cli-tools                # or /tools install cli-tools
✓ cli-tools installed. 🤘
  ✓ /blog → blog-post
  ✓ /free → domainfree
```

`/upgrade` does the same, because an upgrade is where a tool *gains* commands —
a roster adopted once at install time otherwise goes stale the first time the
tool ships something new. `/alias install <tool>` (or `--all`) re-runs it on
demand, for tools you installed before this existed.

The tool proposes and the pit disposes: moshcode reads the suggestions and
writes the file, so nothing else reaches into a config it does not own. A name
you bound yourself always wins — your `/prs` may carry `--orgs` flags a generic
suggestion knows nothing about — and a tool that offers nothing, or cannot be
asked, is silent rather than turning a successful install into an error.

### Social posting from the pit

The pit can hand a prepared post to Bluesky or Nostr without storing either
account's credentials in MoshCode:

```text
/socials
/post bsky "shipped it 🤘"
/post nostr "shipped it 🤘"
```

Bluesky opens its official compose intent. Nostr opens the MoshCode composer,
connects to a NIP-07 browser signer (or a NIP-46 bunker through
[`window.nostr.js`](https://github.com/fiatjaf/window.nostr.js)), signs a kind-1
event, and publishes it to the displayed relays. Both flows leave the final
confirmation in the browser. If the pit is remote or headless, `/post` prints
the composer URL instead.

## Getting paid (`/timer`, `/client`, `/rate`, `/billing`, `/payments`)

Every agentic CLI helps you do the work. This one also bills for it. Six words,
each useful on its own — the timer needs no client, the rate needs no gateway
(PRD [0012](prd/0012-billing-baked-into-the-agent-cli.md)).

> **`/timer` and `/billing` now prefer their own CLIs.** Tracking time and
> sending an invoice are not moshcode ideas — they are useful under any agentic
> CLI, and on Windows, where moshcode does not go. So they also ship standalone:
> [`@profullstack/timer`](https://github.com/profullstack/timer) and
> [`@profullstack/billing`](https://github.com/profullstack/billing).
>
> ```sh
> moshcode install timer billing   # or: npm install -g @profullstack/timer @profullstack/billing
> ```
>
> Installing them changes nothing on its own. Switch the hand-over on when you
> are ready to move:
>
> ```sh
> billing import                       # look at what would come across
> billing import --apply               # move it
> export MOSHCODE_EXTERNAL_BILLING=1   # /timer and /billing now run the CLIs
> ```
>
> **It is opt-in for a reason.** Only half this layer has an outside home:
> `/client`, `/rate`, `/payments` and `/team` stay here, because the rails and
> the permission model are moshcode's and `/client`'s freeform dotted fields
> have no shape in the package's typed client model. Handing over the other
> half automatically would split your records across two stores — `/client` and
> `/rate` writing `~/.moshcode/business.json` while `/billing` reads the
> package's own ledger, so the invoice for a client you had just created would
> not exist. `billing import` is what closes that gap, which is why it comes
> first.
>
> The standalone billing carries the same rate model (`$100/hour/agent/upto:4`)
> and bills **agent-hours**.

```sh
moshcode timer on acme --task "batch payments" --agents auto   # auto counts the herd
moshcode timer off                                             # → 1h 12m, $480.00
moshcode timer log --week                                      # this week's timesheet
```

The timer is a stopwatch and a ledger in `~/.moshcode/timers.json`, and it knows
nothing about money. It does know about **agents**, which is what makes it
different from every other stopwatch: an hour of moshcode is an hour times
however many engines ran in it.

```sh
moshcode client create "Acme Inc", https://acme.com, +1-555-0100
moshcode client create globex --contact.telephone +1-555-0200 --contact.name Jane
moshcode client payee acme-inc solana:9xQe…        # where their payments land
```

Contact details are written the way they arrive: the comma form for what you
pasted out of a signature, `--a.b` dotted flags for anything else. There is no
fixed field list — `--billing.po` works because it says what it means.
`/business`, `/merchant` and `/customer` are the same command.

```sh
moshcode rate set default $100/hour/agent/upto:4
moshcode rate set acme-inc 0.5 SOL/day --prefer SOL,USDC --accept fiat
moshcode rate set initech $5000/project
```

`$100/hour/agent/upto:4` is the sentence from the contract, parsed: price,
period, unit, and the cap that made the client sign. Four agents cost four
hundred an hour and **so do six**. Order after the price does not matter.

```sh
moshcode billing acme-inc                 # a preview — writes nothing
moshcode billing acme-inc --month --mark  # claim the time, record the invoice
moshcode billing acme-inc --send          # compose the gateway command
moshcode billing acme-inc --send --yes    # …and run it
```

Two rules the shape enforces: time is never billed twice (an entry carries the
invoice that claimed it, and `--mark` is the only verb that writes), and nothing
settles to an address nobody chose — no payee and no wallet rail is a refusal,
not a guess.

```sh
moshcode payments connect coinpay                                   # runs `coinpay login`
moshcode payments connect wallet --chain solana --address 9xQe…     # no gateway at all
moshcode payments connect paypal --vault profullstack--prod         # keys live in the vault
```

moshcode composes an invoice; a gateway delivers it. No secret is stored here: a
CLI gateway keeps its own session, and an OAuth gateway gets a reference to the
vault its keys live in (`moshcode secrets`), never the keys.

### Teams and grants (`/team`)

For a machine you handed to somebody else:

```sh
moshcode team create Profullstack
moshcode team add profullstack preshy --role member --rate '$80/hour'
moshcode team grant profullstack preshy tools:coinpay
moshcode team can profullstack/preshy payments:write     # → no
```

A permission is `surface:target`, written however you say it — `tools:coinpay`,
`tools/coinpay` and `allow(tools/coinpay)` are one grant. Roles (`owner`,
`admin`, `member`, `client`) are a starting set; grants add to them.

The pit gates itself only when `MOSHCODE_MEMBER=<team>/<handle>` is set — with
it unset the owner is at the keyboard and nothing is checked. **This is a
guardrail, not a security boundary.** moshcode runs as the person at the
keyboard, and anyone who can type `/team` can also edit
`~/.moshcode/business.json`. A boundary that has to hold against somebody is an
OS account, a container, or a scoped credential.

## The arcade (`/games`)

Twenty-two games, in the pit or straight from a shell. There are no menus, no options
screens and no difficulty prompts — `/games tetris` is already playing.

```sh
moshcode games                # the cabinet (pit: /games)
moshcode games tetris         # play one   (pit: /games tetris)
moshcode games --json         # the roster, for a machine
```

```
  TETRIS       score 1200 · lines 12
  ┌────────────────────────────────┐
  │ · · · · ████· · · ·   NEXT     │
  │ · · · · ████· · · ·            │
  │ · · · · · · · · · ·   ████████ │
  │ · · · · · · · · · ·            │
  │ · · · ████· · · · ·   LVL 2    │
  │ ████████████· ██████           │
  └────────────────────────────────┘
  ← → move · ↑ rotate · ↓ drop one · space slam · q quit
```

| game | |
|---|---|
| `tetris` | stack the bricks, clear the lines, outrun gravity |
| `snake` | eat, grow, and try not to eat yourself |
| `pacman` | eat the dots, dodge the ghosts, `✳` makes them edible |
| `invaders` | forty of them, and the last one moves fastest |
| `centipede` | shoot it in the middle and now there are two of them |
| `asteroids` | turn, thrust, shoot — every rock you break becomes two |
| `breakout` | dig a channel up the side and let the ball do the rest |
| `pong` | first to seven, and the angle is all in where you hit it |
| `tank` | two tanks, one yard, five hits — line it up and let go |
| `digdug` | dig the tunnels, pump the monsters, drop rocks on the rest |
| `frogger` | the road kills what it touches, the river kills what it doesn't |
| `kong` | five girders, four ladders, and a barrel with your name on it |
| `pitfall` | jump the logs, swing the pits, and get the gold before dark |
| `choplifter` | fly out, land, fill the back, and get them home |
| `spyhunter` | keep it on the tarmac, shoot the ones shooting back |
| `outrun` | a road that bends, traffic that doesn't, and a clock that always wins |
| `excitebike` | turbo until it cooks, and land the way you took off |
| `stagedive` | run the barricade, hop the gear, duck the crowd, take the picks |
| `tictactoe` | three in a row against an opponent that cannot be beaten |
| `blackjack` | hit, stand, double, split — dealer stands on 17, and pays 3:2 |
| `chess` | full rules — castling, en passant, promotion — and it plays back |
| `hangman` | six wrong letters and you are done for |

Every one of them works the same way: arrows move, `q` quits, `r` starts
another, and the controls are written along the bottom of the game itself. Each
draws in place rather than on the alternate screen, so the board you finished on
stays in your scrollback.

The two games that read letters — `blackjack`, where `h` is hit, and `hangman`,
where it is a guess — keep their letters: `h j k l` are not arrows there, and `r`
only starts another once the game is over.

Playing needs a real terminal, because they read single keypresses — `moshcode
games` on its own lists them anywhere, including a pipe.

## Settings sync (`/save` and `/load`)

Your pit becomes yours by accretion — a dozen aliases, herd rules you tuned until
the roster stopped lying to you. All of it lives in `~/.moshcode` on one machine,
which is why every new laptop, container and droplet used to feel like someone
else's prompt.

`/save` pushes that configuration to your `app.moshcode.sh` account. `/load`
brings it down onto any machine you have run `/login` on.

```sh
moshcode save                 # push this machine's settings (pit: /save)
moshcode save --dry-run       # what would go up, and stop

# on the new box
moshcode login
moshcode load                 # pull them down (pit: /load)
moshcode load --dry-run       # the per-file plan, changing nothing
```

What syncs is an allowlist, not a directory walk:

| file | what it is |
|---|---|
| `~/.moshcode/aliases.json` | your pit aliases (`/alias`) |
| `~/.moshcode/herd/rules.json` | herd state-detection overrides |

What never syncs, by name: `credentials.json` (the account token this very
feature authenticates with), `herd/sessions.json` (live state pinned to one tmux
server), `sync.json`, and the `pkg/` binary cache. Engine configuration
(`~/.claude.json` and friends) is deliberately left alone — those files carry
provider API keys.

Nothing is overwritten quietly:

- Each save is a numbered **revision**. `/save` sends the revision it last agreed
  on, and the app refuses the write if another machine has saved since — you get
  told, with `/load` and `/save --force` as the two ways out.
- `/load` refuses to replace a settings file you edited since this machine last
  synced, and names it. `--force` overrides.
- The last ten revisions are kept. See them, and which machine each came from, at
  [app.moshcode.sh/settings/sync](https://app.moshcode.sh/settings/sync) — where
  you can also promote an older revision or delete the lot.

Both verbs take `--json`, so a provisioning script can act on the result.

## Browser terminal (`moshcode console`)

A real terminal in the browser — arrow keys, history, full-screen TUIs — because
the thing on the other end is a real pty, not a log view. moshcode does not
implement the terminal: [ttyd](https://github.com/tsl0922/ttyd) does, and
moshcode puts an authenticating proxy in front of it so your `moshcode login` is
the way in.

Two processes on the box you want a shell on:

```sh
# 1. ttyd — bound to loopback ONLY. It must never be reachable directly.
ttyd -i 127.0.0.1 -p 7681 -W login

# 2. the gateway — verifies moshcode tokens, then proxies to ttyd
moshcode console serve --port 7682 --ttyd 127.0.0.1:7681
```

Then, from any machine where you have run `moshcode login`:

```sh
moshcode console --url https://dev.example.com/    # prints an authenticated URL
```

The token is verified once against `app.moshcode.sh/api/me`, swapped for a
short-lived HMAC cookie, and stripped from the URL by the redirect, so it does
not sit in browser history or travel with every request. The websocket carrying
the terminal is authenticated too — an unauthenticated upgrade is refused before
it reaches ttyd.

**This is a shell on the internet.** Treat it accordingly:

- Keep ttyd on `127.0.0.1`. The gateway is the only thing that should reach it.
- `--bind` defaults to `127.0.0.1`. Put the gateway on a **tailnet address**
  (`moshcode install tailscale`) or behind a reverse proxy with TLS. Binding
  `0.0.0.0` publishes a login prompt to the whole internet, and moshcode warns
  when you do it.
- The gateway's signing secret is per-process, so restarting it logs everyone out.

## MCP and Agent Skills

See which installed engines can handle MCP servers or Agent Skills. Add
`--json` when another tool needs the capability matrix:

```sh
moshcode mcp list --json
moshcode skill list --json
```

Each row reports `installed` and `supported` separately, so an installed engine
without that integration primitive remains visible rather than looking absent.

### Known MCP servers

Some MCP servers are worth remembering by name rather than by npx invocation:

```sh
moshcode mcp catalog              # what we know how to run
moshcode mcp add porkbun          # expands to: npx -y @porkbunllc/mcp-server
moshcode mcp add bufferoverride   # expands to: https://bufferoverride.com/mcp
```

That registers it across every engine that supports MCP (claude, gemini, qwen,
codex, opencode, privacycode) in one go. Kimi is skipped with a reason: it runs
MCP servers but has no command to register one from a script — add those
in-session with its own `/mcp-config`, or in `~/.kimi-code/mcp.json`.

Re-running an install is safe: an engine that already has the server reports
`already registered` rather than an error, so the summary only goes red when
something actually went wrong.

The catalog is a convenience, never a gate — an explicit command always wins, so
`moshcode mcp add porkbun -- node ./my-fork.js` runs your fork.

**Credentials are named, not registered.** `porkbun` needs `PORKBUN_API_KEY` and
`PORKBUN_SECRET_API_KEY`; moshcode prints which are missing rather than copying
them into five engines' config files, which would be five places to leak them
from and five to rotate. Porkbun's API access is off by default and enabled
per-domain — and its documentation tools work with no keys at all, which is a
sensible way to try the server before trusting it with DNS writes.

**BufferOverride is the useful-unauthenticated one.** Five read tools
(`search_questions`, `get_question`, `list_questions`, `list_tags`, `whoami`)
work with no credential, and the write tools are gated on the scopes a key
actually carries — `tools/list` advertises only what your key can use. So the
bare `mcp add bufferoverride` above is a complete, working registration. To
publish from an engine, add the credential as a header:

```sh
moshcode mcp add bufferoverride -H "Authorization: Bearer bo_..."
```

`bo mcp config` prints the same thing from a terminal that has already signed
in, and `bo mcp config --no-token` prints a form safe to paste in public. It is
registered under the name the CLI uses, so both routes produce one server rather
than two. See [BufferOverride](#bufferoverride--the-failure-in-front-of-you-already-answered)
above for the CLI itself.

## Claude Code plugins

MoshCode publishes its own plugin marketplace, so the pit's slash commands work
inside your engine too:

```sh
moshcode plugin list              # what the marketplace ships, and who can take it
moshcode plugin install           # add the marketplace + install `stocks`
moshcode plugin install crypto    # add the marketplace + install `crypto`
moshcode plugin remove stocks     # take it back off
```

The two plugins share the four names for the questions both markets answer, and
differ only where the markets do. Either one's `/…:help` prints its own list.

| | `stocks@moshcode` | `crypto@moshcode` |
|---|---|---|
| shared | `help` `report` `quote` `lookup` | `help` `report` `quote` `lookup` |
| its own | `signals` `research` `list` `discover` | `book` `bars` `spark` `pairs` |

So `/stocks:report NVDA` and `/crypto:report BTC` are the same question asked of
different markets, while `/stocks:signals` (what an executive said on a call)
and `/crypto:book` (live order book depth) have no counterpart on the other
side. They ship separately because they are different surfaces, not modes of one
another: stored snapshots versus live venue reads, and a crypto score that must
not be ranked against an equity's.

Restart the engine after installing either; a newly installed plugin is not live
in a session that is already running.

Updating an installed plugin is its own step, and upgrading moshcode does not do
it: an engine only pulls a new copy when the *plugin's* own version moves.

```sh
claude plugin update stocks@moshcode
claude plugin update crypto@moshcode
```

Plugin commands are namespaced `/<plugin>:<command>` — always, not only when two
plugins collide — so it is `/stocks:signals AAPL`, and a bare `/signals` answers
`Unknown command`. Typing `/` and picking from the menu inserts the right form.
This is the one place the two surfaces differ: inside the moshcode pit the same
research is plain `/stocks …` and `/crypto …`, because those are moshcode's own
commands rather than a plugin's.

The equivalent by hand:

```sh
claude plugin marketplace add moshcoder/moshcode
claude plugin marketplace update moshcode   # `add` is a no-op if you already have it
claude plugin install stocks@moshcode
claude plugin install crypto@moshcode
```

The `update` line matters if you have ever installed from this marketplace
before: `add` declines to do anything for a marketplace already on disk, so
without a refresh the install reads a stale copy and fails with "not found in
any marketplace". `moshcode plugin install` runs both steps for you.

### Upgrading from `ticker@moshcode`

`stocks` was called `ticker` before v0.29.0. Installing the new id does **not**
replace the old one — engines install plugins side by side, so `/stocks:report` would
come from two plugins at once. Remove the old id first:

```sh
moshcode plugin remove ticker
moshcode plugin install stocks
```

`remove ticker` keeps working for exactly that reason, even though
`install ticker` no longer does.

Claude Code is currently the only engine with a plugin primitive. The others are
reported as skipped with a reason, the same way they are for skills, rather than
being left out of the summary. `MOSHCODE_PLUGIN_SOURCE=.` installs from a local
checkout instead of GitHub, which is how you try an unreleased plugin.

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

## Hosting at a Moshpit name (`moshcode template`)

Claim `foo.whatever` in [the Pit](https://pit.moshcode.sh/pit), then scaffold
something to put behind it:

```sh
moshcode template list                        # what there is
moshcode template list --json                 # machine-readable template metadata
moshcode template install bun-caddy-sqlite    # into the current directory
moshcode template install caddy-static --into /srv/site
moshcode template install owner/repo          # or a git URL, or a .tar.gz
moshcode template install caddy-static --dry-run # preview every file first
```

| template | what you get |
|---|---|
| `bun-caddy-sqlite` | Bun service + Caddy + SQLite — a local file in dev, Turso in prod, same client |
| `caddy-static` | Caddy and a directory of files. No runtime, nothing to keep alive. |

Each writes a Caddyfile, systemd units, and a README. **Nothing in a template is
executed on install** — including the bundled ones. `install <url>` takes a
stranger's URL, so the files are copied and what to run is yours to decide.
`--dry-run` labels every file as `create` or `overwrite` and leaves the target
directory unchanged; combine it with `--force` to preview an overwrite plan.

The one fact that catches everyone: **the machine serving the name never
resolves it, and every machine visiting it must.** Serving is a `Host` header
match and nothing more; visitors need `sudo moshcode dns enable` or the name
resolves to nothing.

Use JSON when a script needs to distinguish a live, parked, invalid, or
temporarily unreachable name without parsing terminal text:

```sh
moshcode dns resolve foo.whatever --json
```

A name points at an **IPv6 address** (bare — no scheme, brackets or port) or a
hostname. IPv4 literals are refused: an A record on a small host is usually
leased or NATed, and a name pointed at one goes stale silently.

Full walkthrough, including the layer-by-layer way to debug it and the limits
worth knowing before you build:
**[docs/hosting-a-moshpit-name.md](docs/hosting-a-moshpit-name.md)**.

### Filtering what resolves

With `dns enable` on, the bridge already sees every lookup this machine makes.
`dns filter` is the other thing a resolver in that position can do: refuse the
names that exist only to advertise, track, mine or phish, before a connection is
ever opened. Nothing is filtered until you ask for it.

```sh
moshcode dns filter on             # ads, malware, phishing, mining
moshcode dns filter update         # fetch the lists — nothing downloads on its own
moshcode dns filter                # what is on, and what it has blocked
moshcode dns filter test ads.example.com   # would this be blocked, and by which rule
moshcode dns filter allow news.example     # never block it, whatever any list says
```

| list | what it blocks |
|---|---|
| `ads` | ads and trackers — StevenBlack unified, on by default |
| `malware` | hosts serving malware — URLhaus, on by default |
| `phishing` | Phishing Army, on by default |
| `mining` | in-browser cryptominers, on by default |
| `adult` `gambling` `social` `fakenews` | opt in by name with `filter add <list>` |

Three things worth knowing. Blocking a name blocks everything under it, and an
`allow` rule always wins — that is the escape hatch for the day a list someone
else maintains takes down something you need. Changes reach a running bridge
within about five seconds, so nothing has to be restarted. And a blocked name is
answered `NXDOMAIN` by default; `--mode zero` answers `0.0.0.0` instead, and
`--mode refuse` says `REFUSED`, which is the one a client can tell apart from a
real absence while you work out whether the filter is what broke something.

`dns filter` never turns DNS routing on — it writes a config and nothing else,
so on a machine whose resolver has never heard of the bridge it changes nothing.
Its status says so rather than reporting `on` and leaving you to find out.

## Shell completion

MoshCode can print context-aware completion scripts for its commands, engines,
workflow tools, options, and file arguments. Load the one for your current
shell:

```sh
# Bash (~/.bashrc)
source <(moshcode completion bash)

# Zsh (~/.zshrc, after any existing compinit/Oh My Zsh setup)
source <(moshcode completion zsh)

# Fish (~/.config/fish/config.fish)
moshcode completion fish | source

# PowerShell (add to $PROFILE for future sessions)
moshcode completion powershell | Out-String | Invoke-Expression
```

Put the matching line in your shell profile to enable it in future sessions.

## PRD — plan before you mosh

Write a product requirements doc *first*, then let your coding agents build to it.
`moshcode prd` publishes PRDs per [OpenPRD](https://github.com/profullstack/logicsrc/blob/master/docs/openprd.md) —
a **DIP-style** standard: a numbered, committed proposal collection in your repo
(like a BIP/EIP process), one file per decision.

```sh
moshcode prd "parked-domain service expansion"   # publish the next numbered PRD, then hand it to an engine
moshcode prd                                      # list existing PRDs
moshcode prd list --json                          # machine-readable listing; writes nothing
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
moshcode run examples/account.mosh --dry-run  # log in, then do work that needs an account
moshcode run examples/aliases.mosh --dry-run  # define and run the pit's shortcuts
moshcode run examples/research-desk.mosh      # stocksRead/cryptoRead/newsRead → one digest
moshcode run deploy.mosh --dry-run            # narrate without executing
moshcode run alive.mosh --max 5               # bound the while loop (default 3)
moshcode run deploy.mosh staging --fast       # extra args reach the script as argv
moshcode run deploy.mosh -- --max 5           # -- preserves option-like script args
moshcode run - < script.mosh                  # pipe/paste from stdin
moshcode commands                             # list the full vocabulary
moshcode commands --json                      # machine-readable command metadata
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
| `shell(cmd)` | run a shell command (blocking, `$SHELL +m -ic`, so your rc file loads without job control taking the terminal); returns `{ ok, code }` |
| `stop()` | end the loop (`alive = false`) |
| `repeat()` | back to the top of the loop |

**Account verbs** (see [Authentication](#authentication)):

| verb | description |
|---|---|
| `await requireLogin()` | gate — verify, log in if needed, **throw** if it can't; returns the user |
| `await login({ device, browser, force })` | authenticate; no-op when already signed in; returns `{ ok, email, already }` |
| `await whoami()` | the account as a value: `{ status, verified, api, user: { id, email, name, credits } }` |
| `logout()` | forget this machine's credentials |

**Alias verbs** — the pit's own shortcuts (`~/.moshcode/aliases.json`), readable and writable from a script:

| verb | description |
|---|---|
| `alias()` | every alias, as a `name → line` map |
| `alias(name)` | one alias's line, or `null` |
| `alias(name, line)` | define one; refuses names moshcode already owns |
| `unalias(name)` | forget one |
| `runAlias(name, …args)` | run one, args appended; returns `{ ok, code }` |

**Read verbs** — the tools as *values* rather than tables:

| verb | description |
|---|---|
| `await stocksRead(…)` | same args as `stocks(…)`, returns the parsed JSON |
| `await cryptoRead(…)` | same args as `crypto(…)`, returns the parsed JSON |
| `await newsRead({ list, limit })` | headlines as `[{ title, link, source, date }, …]` |
| `herdRead(name, { lines })` | a herd session's screen, as a string |
| `herdList()` | the roster: `[{ name, engine, state, cwd, alive }, …]` |

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
| `c0upons(args…)` | drive the c0upons workflow CLI |
| `bo(args…)` | drive the BufferOverride CLI (capture a failure, search, ask, answer, verify) |
| `secrets(args…)` | drive the logicsrc secrets CLI |
| `railway(args…)` | drive the Railway CLI |
| `gh(args…)` | drive the GitHub CLI |
| `supabase(args…)` | drive the Supabase CLI |
| `doppler(args…)` | drive the Doppler CLI |
| `doctl(args…)` | drive the DigitalOcean CLI |
| `turso(args…)` | drive the Turso CLI |
| `tailscale(args…)` | drive the Tailscale CLI |
| `coral(args…)` | drive the Coral CLI (SQL over APIs, databases, internal systems) |
| `alpaca(args…)` | drive the native Alpaca trading CLI |
| `mcpjam(args…)` | drive the MCPJam CLI (test, debug, and validate MCP servers) |
| `spinifex(args…)` | drive the Spinifex CLI (`spx` — AWS-compatible cloud on your own hardware) |
| `alchemy(args…)` | drive the Alchemy CLI (onchain data, apps, wallets, x402) |
| `elevenlabs(args…)` | drive the ElevenLabs CLI (Eleven Agents, voices, TTS, dubbing) |
| `trade(args…)` | look up tickers, inspect markets, preview/place Alpaca orders |
| `stocks(args…)` | research tickers via advis0r (`stocksRead` returns the data) |
| `crypto(args…)` | research crypto pairs via advis0r (`cryptoRead` returns the data) |
| `advisor(args…)` | query advis0r directly |
| `news(args…)` | read, search, and subscribe to news feeds (`newsRead` returns the items) |
| `rss(args…)` | manage RSS subscriptions and reading lists |
| `plugin(args…)` | install/manage moshcode plugins from the marketplace |
| `engines()` | list coding engines and whether they're installed |
| `tools()` | list the adjacent workflow CLIs and whether they're installed |
| `dns(args…)` | drive the Moshpit DNS bridge (enable, status, resolve) |
| `doh(args…)` | run/inspect the DNS-over-HTTPS endpoint |
| `site(args…)` | scaffold and publish a site |
| `serve(args…)` | serve a directory over HTTP |
| `template(args…)` | scaffold from a moshcode template |
| `save()` / `load()` | push/pull settings to your moshcode account (needs login) |
| `herd(args…)` | drive the herd (`herdStart`/`herdWait`/`herdRead` return values) |
| `ps()` | print the herd roster |
| `ai(prompt, { engine })` | run an engine headlessly and **return** its output as a string |
| `pwd()` | print the current repo/location |
| `run(file)` | run another .mosh file (include/compose) |

**Specials** (injected globals, not commands):

| name | description |
|---|---|
| `alive` | `true` while the loop may continue; iterations bounded by `--max` |
| `argv` | positional args passed after the script file |
| `env` | `process.env` — parameterize scripts from the environment |

### Authentication

Some verbs need an account: `notify()`/`ask()` reach you through
`app.moshcode.sh`, and `save()`/`load()` sync settings to it. A script says so
once, at the top, instead of failing one call at a time later on:

```js
const me = await requireLogin();          // verifies; logs in if it has to
say(`signed in as ${me.email} (${me.credits} credits)`);
```

- **`requireLogin({ device, browser })`** — the gate. Verifies this machine
  against the app; if there's no usable session it runs the login flow, then
  re-checks. Returns the verified `{ id, email, name, credits }`. **Throws** if
  it still can't authenticate — the one verb here that does, because "require"
  means the script must not continue without an account.
- **`login({ device, browser, force })`** — idempotent. Returns early with
  `{ already: true }` when you're already signed in, so a script you re-run all
  day never throws a browser tab at you. Returns `{ ok: false, error }` on
  failure rather than throwing, so a script can fall back to read-only work.
- **`whoami()`** — the account as a value, verified against the app:
  `{ status, verified, api, user }` where `status` is `authenticated`,
  `not_logged_in`, `expired`, `unverified`, or `unreachable`. Never throws — an
  unreachable app is a status, not an exception.
- **`logout()`** — forget the local credentials.

The flow is picked for where the script is running: the loopback/browser flow
locally, and the device-code flow over SSH or on a headless box (where a
`127.0.0.1` callback would land on the *browser's* machine and never arrive).
`{ device: true }` / `{ browser: true }` pin it either way. Credentials live in
`~/.moshcode/credentials.json` (mode `0600`) — the same ones `moshcode login`
writes, so logging in once covers the CLI, the pit, and every script.

```js
// gate on the balance, not just the session
const me = await whoami();
if (!me.verified) { say("read-only run — not signed in"); }
else if (me.user.credits < 10) notify(`only ${me.user.credits} credits left`);
```

### Aliases

The pit keeps named shortcuts for the lines you retype (`/alias set gs "git
status"`). Scripts read and write the same store, so your vocabulary and
moshcode's are one thing rather than two:

```js
alias("gs", "git status --short");   // define (refuses names moshcode owns)
alias("cc", "/agents claude");       // a leading `/` is a moshcode command
runAlias("gs", "--branch");          // → git status --short --branch
```

Expansion is the pit's rule: a leading `/` routes to the moshcode command of
that name, anything else is a shell line, and arguments are **appended** rather
than substituted — exactly how a shell alias behaves. `runAlias()` returns
`{ ok, code }` like `shell()`, and `{ ok: false, code: 127 }` when there's no
such alias.

### Reading the tools, not just running them

`stocks report NVDA` prints a table; a script usually wants the number. The
`*Read()` verbs call the same layer the printed commands render from and hand
back parsed data:

```js
const report = await stocksRead("report", "NVDA");   // → JSON, or null on error
const btc    = await cryptoRead("quote", "BTC/USD");
const items  = await newsRead({ limit: 5 });          // [{ title, link, source, date }]
```

A failed lookup returns `null` (or `[]`) rather than throwing, so one bad symbol
doesn't take a briefing script down. Same reasoning as the herd's
`herdRead()`/`herdList()`: shelling out gives you `{ ok, code }`, and the whole
point of these is the value.

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

### Error handling

CLI verbs and `shell()` return `{ ok, code }` instead of throwing on non-zero
exits, so scripts can branch on outcomes without `try/catch`:

```js
const r = install("claude");
if (!r.ok) {
  say(`install failed (exit ${r.code}), trying fallback…`);
  install("codex");
}

const test = shell("npm test");
if (!test.ok) notify("tests failed!");
```

Only truly fatal errors (e.g. `moshcode` binary not found) throw. This keeps
`while (alive)` loops resilient — a single failing verb doesn't crash the script.

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
| `MOSHCODE_PLAYLIST` | — | what `mosh()` blasts in the browser |
