---
openprd: "0.2"
id: "0011"
title: "Teach the herd the agent protocol — hooks-first state, a task ledger, and an A2A surface for local and remote agents"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-08-16
updated: 2026-08-16
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/herd-hooks.mjs, src/herd-tasks.mjs, src/herd-serve.mjs, src/herd-remote.mjs, src/herd-eval.mjs; touches src/herd-state.mjs, src/herd-cli.mjs, src/herd.mjs, src/engines.mjs, src/tools.mjs, src/commands.mjs, src/cli-schema.mjs
tags: [herd, runtime, agents, a2a, state, tasks, evals, digitalocean]
supersedes:
superseded-by:
---

## Problem

PRD 0009 built the herd: sessions outlive the terminal, every session carries a
semantic state, and one verb set serves humans, scripts, and agents. It works.
Three limits are now the daily friction, and all three are the same limit seen
from different angles — **the herd reads paint instead of speaking protocol.**

**The state rules rot, and we said so ourselves.** `herd-state.mjs` documents
its own weakness: *"Screen rules are the fallback, and they are the part that
rots — engines change their prompts between releases and nothing tells us."*
The tier-1 mechanism exists (`moshcode herd report`, TTL-bounded, beats the
screen), but nothing *installs* the hooks that would use it. Claude Code has
lifecycle hooks. OpenCode has plugins and events. Codex has a notify path. We
built the socket and never plugged anything into it, so in practice every
session is classified by regex against a screen capture, and every engine
release is a chance for the roster to start lying.

**Sessions have a present tense but no past.** `herd prompt api "…" --wait`
returns, and then the evidence evaporates. Which prompts were submitted, when
each one blocked, what the answer was, how long the human took — none of it is
anywhere. Fan-out (the herd's party trick) is therefore unauditable: a
moshscript that drove four engines overnight can tell you their state *now*
and nothing else. The watch loop already observes every transition it would
take to fix this, and throws each one away after deciding whether to buzz a
phone.

**The herd stops at the edge of the box.** A deployed agent — say a
DigitalOcean Gradient ADK deployment answering at
`agents.do-ai.run/<workspace>/<deployment>/run` — cannot be on the roster, and
nothing off the box can drive the herd. Meanwhile the ecosystem converged on
exactly the shape we need. DO's ADK gives every agent one uniform entrypoint
(`POST /run`, JSON in, JSON out), a lifecycle CLI (`init/run/deploy/logs/
traces/evaluate`), and — the interesting part — [A2A protocol
v0.3.0](https://a2a-protocol.org/v0.3.0/specification/) support: discovery at
`/.well-known/agent-card.json`, `message/send`, `tasks/get`, `tasks/cancel`,
tasks with ids, status history, and artifacts. A2A's task state vocabulary
includes `input-required`.

`input-required` is `blocked`. The mapping between A2A and the herd is not an
integration to be designed; it is a translation table to be written down:

| herd            | A2A                          |
| --------------- | ---------------------------- |
| `herd prompt`   | `message/send`               |
| state / `wait`  | `tasks/get` (poll)           |
| `herd kill`     | `tasks/cancel` (best-effort) |
| `ps` / roster   | agent-card discovery         |
| `blocked`       | `input-required`             |
| `working`       | `working`                    |
| `done`          | `completed`                  |
| killed          | `canceled`                   |

PRD 0009 took herdr's thesis — *"the CLI and socket API are one surface agents
drive"* — and implemented it locally. A2A is that thesis standardized across
machines. This PRD ports the ideas, not the SDK.

## Goals

- State comes from the engine when the engine can speak, and from the screen
  only when it can't. On a default install, a Claude Code herd session reads
  `authority: hook`, not `authority: screen`.
- Every prompt is a **task** with a durable record: an id, its state
  transitions with timestamps, and the output it produced. `moshcode ps` keeps
  answering "now"; the ledger answers "what happened."
- The roster spans machines. A deployed agent is a herd member; `ps`, `prompt`,
  `read`, and `wait` do not care whether a member is a local pty or a URL.
- The herd itself is drivable over a standard protocol, behind real auth, so
  another machine's herd — or anyone's A2A client — can submit work and poll it.
- "Which engine is best for this repo" is answered empirically:
  one dataset, N engines, a judge, an exit code CI can gate on.
- The DO Gradient ADK is a first-class workflow tool: installable, drivable
  from moshscript, and its dev server a well-classified herd member.

## Non-Goals

- **Not a multiplexer rewrite.** 0009's substrates (tmux, `script(1)`+FIFO,
  foreground fallback) stand unchanged. Everything here layers on the existing
  runtime.
- **Not a hosted control plane.** `app.moshcode.sh` remains the notify/approve
  surface it already is. `herd serve` runs on your box, like `moshcode console`.
- **Not the full A2A spec.** v0.3.0, JSON-RPC, text parts only —
  the same MVP scope the ADK itself ships. Streaming, push notifications, and
  authenticated extended cards are declared off in the card's capability flags,
  which the spec provides for exactly this.
- **Not token-level tracing.** We do not own the engines' runtimes; pretending
  to see inside them would be paint-reading with extra steps. Transitions and
  task artifacts are what the herd can attest to honestly.
- **Not replacing engine-native resume/history.** `restore --resume` semantics
  from 0009 are untouched; the ledger records what the *herd* saw, not the
  engine's conversation.

## Users

- **The operator with four agents and one attention span.** 0009 told them who
  needs them now; this tells them what happened while they slept, and lets a
  deployed agent sit on the same roster as the local ones.
- **The moshscript author.** Fan-out already works; fan-*in* is exit codes and
  screen reads. Tasks give joins something to join on, and `wait --all` stops
  the hand-rolled polling loops.
- **Another agent.** An engine in the herd, a CI job, or a deployed ADK agent
  that needs to hand work to a local session and collect the result — over a
  protocol it already speaks, not over SSH-and-tmux incantations.
- **The CI pipeline** that wants "the agent still passes the dataset" as a
  red/green check next to `npm test`.

## Requirements

### Phase 1 — believe the engine, not the paint

- **R1 [P0] `moshcode herd hooks install <engine>|all`.** Writes the
  engine-native lifecycle hook configuration that calls
  `moshcode herd report "$MOSHCODE_HERD_NAME" <state>` at the right moments.
  Claude Code first (its hooks are documented and stable): stop → `done`,
  notification/permission-request → `blocked`, prompt-submit/tool-use →
  `working`. Hook specs live in `ENGINES` next to each engine's screen rules,
  so detection ships with the install spec, exactly as 0009 R7 intended.
  `--dry-run` prints the config diff; `hooks remove` reverts;
  `hooks status --json` reports per-engine install state. **Merge, never
  clobber:** a user's existing hook file is extended, and `remove` takes out
  only what we added.
- **R2 [P0] Sessions know their own name.** The herd already launches the
  engine, so it injects `MOSHCODE_HERD_NAME` and `MOSHCODE_HERD_DIR` into the
  session environment at start. A hook fired outside a herd session (no env
  var) exits silently and successfully — hooks must never break an engine
  running outside the herd.
- **R3 [P1] `moshcode herd doctor`.** One verb that checks the things that
  actually go wrong: tmux server reachable, manifest vs. live sessions drift,
  stale hook reports past TTL, unwritable status dir, rules.json parse errors
  (today they vanish silently by design — doctor is where they get to be
  loud). `--json` for provisioning scripts.
- **R4 [P2] Blocked sub-kinds.** `blocked:permission`, `blocked:question`,
  `blocked:menu`. Hooks can say which; screen rules map their existing
  patterns (y/n → permission, `❯ 1.` → menu). The roster still prints
  `blocked`; the sub-kind rides in `--json` and in notifications, so
  `--ask` replies can be validated against what was actually asked (a menu
  wants a digit, not a paragraph).

### Phase 2 — the task ledger

- **R5 [P0] Every prompt mints a task.** `herd prompt` assigns a task id and
  appends to `~/.moshcode/herd/tasks/<session>.jsonl`: submission (text, ts),
  each state transition (observed by the same poll the watcher already runs),
  terminal state, and the output artifact captured as the screen delta via the
  existing `read` machinery. Files are `0600` for the manifest's stated reason,
  one step harder: engine output carries secrets the user never even typed.
- **R6 [P0] Read verbs.** `moshcode herd tasks <session> [--json]` lists;
  `moshcode herd task <id> [--json]` shows one, transitions and artifact
  included. moshscript gets `herdTasks(name)` and `herdTask(id)` as values,
  same contract as `herdRead`/`herdList`: `null`/`[]` on error, never throw.
- **R7 [P1] Transitions become history.** `herd log <session>` prints the
  timestamped state history; `herd stats [session]` aggregates time-in-state —
  including blocked-time, which is a number with a name: *human latency*.
  Retention is capped and documented (default: last 500 tasks per session,
  size-bounded), because an append-only file with no cap is a disk-eater with
  a delay on it.
- **R8 [P1] Fan-in verbs.** `moshcode wait --any <a> <b> …` returns on the
  first session to hit a target state (exit codes name the winner in `--json`);
  `wait --all` returns when every named session has. `herdWait` gains the same
  options. This deletes the polling loop from every fan-out script we have
  written so far.

### Phase 3 — the A2A surface

- **R9 [P0] `moshcode herd serve`.** An HTTP server exposing the herd per A2A
  v0.3.0. `GET /.well-known/agent-card.json` describes the herd; each session
  is addressable as `/<name>/` with its own card. `message/send` → `herd
  prompt` (mints a task per R5); `tasks/get` → ledger read; `tasks/cancel` →
  interrupt, escalating exactly as `kill` already does. State maps per the
  table in Problem; `idle` and `unknown` map to `working` with the honest
  state carried in task metadata, because A2A's vocabulary is smaller than
  ours and rounding *up* to "needs input" would page people for nothing.
- **R10 [P0] Serve is a shell on the internet, and is treated like one.**
  Reuse `console.mjs`'s discipline wholesale: bind `127.0.0.1` by default,
  verify the moshcode token against `app.moshcode.sh/api/me` once, swap for a
  short-lived HMAC credential, refuse unauthenticated requests before they
  reach anything, warn loudly on `0.0.0.0`. There is no unauthenticated mode,
  loopback included — `message/send` is keystrokes into a real pty, which is
  strictly more dangerous than a browser terminal that at least shows you what
  it's doing.
- **R11 [P0] Remote members.** `moshcode herd remote add <name> <url>
  [--kind a2a|run]` registers a remote agent on the roster. `a2a` discovers the
  card and drives JSON-RPC; `run` covers bare ADK-style endpoints
  (`POST <url>` with `{"prompt": …}` — the shape every `gradient agent deploy`
  prints). Manifest rows carry `kind: "remote"`; `ps` shows them with the host
  where local rows show cwd; state comes from `tasks/get` (a2a) or reachability
  (run — a request/response endpoint is `idle` when up, `working` while a call
  is in flight, and honest about knowing nothing more). Auth is a named header
  from the environment (`MOSHCODE_REMOTE_<NAME>_TOKEN`), never written to the
  manifest and never synced — 0010's allowlist reasoning, verbatim.
- **R12 [P1] The verbs don't care where a member lives.** `herd prompt`,
  `read`, `wait`, `kill`, and their moshscript forms work unchanged on remote
  members: prompt POSTs, read returns the last artifact, wait polls, kill
  cancels. A `.mosh` script that fans across `claude` (local pty) and
  `research-prod` (deployed on DO) is the acceptance test, and it should not
  contain a single `if (remote)`.

### Phase 4 — evals and the DO toolchain

- **R13 [P1] `moshcode herd eval`.** `--dataset <csv|jsonl> --engines a,b,…
  [--judge <engine>|rules] [--threshold N] [--json]`. Fans each dataset row
  across the named engines using the verbs that already exist, collects
  results from the ledger, scores with the `ai()` verb as judge (rubric in the
  dataset) or plain expected-pattern rules, and exits with `wait`'s discipline:
  distinct codes for pass, below-threshold, and infrastructure failure. The DO
  ADK ships `gradient agent evaluate --dataset-file --categories
  --success-threshold` for deployed agents; this is the same idea pointed at
  interactive engines, which is the comparison nobody else can run.
- **R14 [P2] Install the ADK like we install everything else.**
  `moshcode install gradient` runs the vendor path (`pip install gradient-adk`,
  Python ≥3.10 checked and named when missing — moshcode stays Node, the tool
  owns its runtime, same as CoinPay owning Node 20). Top-level passthrough
  `moshcode gradient …` and a `gradient(args…)` moshscript verb, per the
  existing tool table.
- **R15 [P2] The ADK dev loop is a good herd citizen.** Ship a `gradient`
  entry in the default state rules so
  `moshcode herd run --name agent -- gradient agent run --dev` classifies
  (uvicorn startup banner → `idle`, request handling → `working`), and a
  template pointer at `digitalocean/gradient-adk-templates` in
  `moshcode template list`. The workflow this buys: dev server in one tile,
  Claude editing it in the next, logs in a third, `gradient agent deploy` from
  the mosh bar, then `herd remote add` the printed URL — the whole lifecycle
  without leaving the pit.

## UX Notes

**New verbs, existing shape.** Everything lands in the generated command
table, drifts-fail-the-build included. `hooks`, `tasks`, `task`, `log`,
`stats`, `serve`, `remote`, `eval` are all `herd` subverbs; `wait` grows
`--any/--all` in place. Every verb takes `--json`. There is still no second
API — `serve` is not a new surface so much as the existing one answering a
socket.

**The one-time setup reads like this:**

```
moshcode herd hooks install claude
✓ claude — 3 hooks installed (stop, notification, prompt-submit)
  sessions started from the herd now report state directly.
  screen rules remain the fallback for everything else.
```

**A remote member on the roster:**

```
$ moshcode herd remote add research https://agents.do-ai.run/b168…/production --kind run
$ moshcode ps
  api        claude   blocked   ~/src/coinpay              12m   hook
  research   remote   idle      agents.do-ai.run           —     remote
⚠ 1 waiting on you — moshcode attach api
```

**What happened overnight:**

```
$ moshcode herd tasks api
  t-01  22:14  done      4m    "port the auth routes"
  t-02  22:19  blocked   6h11  "run the migration"        ← answered 04:30
$ moshcode herd stats api
  working 3h02 · blocked 6h11 · idle 1h40      blocked = you
```

**Honesty rules, carried forward.** A remote member's state is the remote's
claim, and `ps --json` says `authority: remote` so nobody mistakes it for
something we verified. `herd serve` prints the same warning `console` does
when bound beyond loopback. The ledger survives a reboot; the *processes*
still don't, and `restore` keeps saying so.

## Success Metrics

- On a machine with hooks installed, ≥95% of Claude Code herd sessions report
  `authority: hook`; `rules.json` edits for supported engines drop to
  approximately zero.
- Any prompt submitted through the herd is reconstructable after a reboot:
  what was asked, when it blocked, what came back.
- A deployed DO agent is driven by `herdPrompt`/`herdWait` in a fan-out script
  with zero remote-specific branches.
- An off-the-shelf A2A client (the ADK's own `examples/a2a/client.py` is the
  test) completes discover → send → get → cancel against `herd serve`.
- `moshcode herd eval` gates a CI job in this repo: engines below threshold
  fail the build with a distinct exit code.
- `blocked` time is a number on a screen, and it goes down.

## Risks & Open Questions

- **`serve` widens the attack surface.** `message/send` is remote keystrokes
  into a pty. Mitigations are R10 (auth always, loopback default, console's
  token discipline) plus one open question: should `serve` refuse to expose
  sessions launched with bypass/auto-approve flags unless `--expose-autonomous`
  is explicit? Leaning yes — an autonomous engine plus a network prompt
  injector is the worst pairing on the menu.
- **Hook drift is the new rule rot.** Engines change hook schemas like they
  change prompts. Contained the same way: specs live per-engine in
  `ENGINES`, `hooks status` detects a schema the engine rejected, and the
  screen fallback means a broken hook degrades to today, never below it.
- **A2A is v0.3.0 and moving.** Pin the version in the card, keep the surface
  to the four operations the ADK itself ships, and treat spec upgrades as
  their own PRD. Text-only parts for the MVP.
- **State vocabularies don't biject.** Our `idle`/`unknown` vs. A2A's
  smaller set (R9 rounds down, metadata carries truth). Accepted as lossy;
  revisit if clients demonstrably need more.
- **Ledger growth.** JSONL with per-session caps (R7). Open: should artifacts
  above a size threshold store a path to the transcript slice instead of
  inline text?
- **Card shape.** One card for the herd with sessions as skills, or a card per
  session (current lean: per session — it makes `remote add` of *someone
  else's* single session symmetric)? Decide during R9 spike.
- **Python as a soft dependency** for R14. Same posture as tailscale needing
  root: name the requirement, never harden it — `install gradient` fails with
  the fix printed, and nothing else in moshcode notices Python exists.

## Implementation Notes

The watch loop in `herd-cli.mjs` already observes every transition R5 needs —
the ledger is a write inserted where the notification decision already
happens, not a second poller. `notify.mjs`'s `ingestApproval`/`pollApproval`
pattern is the model for `tasks/get` long-polling if we want it later.
`console.mjs` is the auth gateway to lift for R10, not to reimplement.
Hook specs belong in `engines.mjs` beside the state tables they supersede.
`runtime.mjs` registration gives moshscript the new verbs for free once the
CLI verbs exist. Build order: R1–R2 (de-rots the core, smallest diff), R5–R6
(everything else reads from it), then R9–R11 as one spike since they share the
task model, with R13 as the demo that only moshcode can run.

## Decisions taken while building

Six questions this document left open were answered by the implementation.
They are recorded here rather than edited into the requirements above, so the
proposal stays the proposal and the answers stay attributable.

**Both card shapes ship, not one.** They answer different questions: the herd
card is discovery ("what is on this box"), and a per-session card is what a
client stores when it intends to talk to one member for a week. Publishing
both also keeps `remote add` of somebody else's single session symmetric with
adding a whole herd, which was the argument for per-session in the first place.

**`--expose-autonomous` is opt-in, as the risk section leaned.** A session
started with `--agent` is off the protocol surface entirely — not in the herd
card, not addressable, not promptable — until the flag says otherwise.

**`tasks/cancel` interrupts; it does not kill the member.** R9 says "escalating
exactly as `kill` already does", and the escalation *pattern* is what was
taken: Escape, then Ctrl-C. It stops one rung short of `kill`'s pane removal on
purpose. An A2A task is a unit of work inside a member, and the member is a
long-lived thing somebody may have attached to five minutes ago; ending it is a
decision, not a protocol call. `moshcode kill` is still the verb for that.

**A finished task is `completed` even when the session went back to `idle`.**
The `idle → working` rounding in R9 is about a *session* — it is sitting there,
it is not asking for anything. Applying it to a task that has an outcome and an
artifact would leave every A2A client polling a job that finished ten minutes
ago, because `send → poll until completed` is the whole protocol. The rounding
now applies only to open tasks; a closed one is `completed`, or
`input-required` when it ended by stopping to ask.

**A poll closes a task.** `tasks/get` and `herd tasks` both reconcile: if a
task is open and its session has stopped, the observation is recorded and the
artifact captured. Without it the only thing that ever finished a task was the
watcher, and a herd where nobody happened to be running one would hand every
client an eternal `working`.

**Artifacts stay inline, truncated at the tail.** The open question asked
whether oversized artifacts should store a path to a transcript slice instead.
They do not: the cap keeps the last 8000 characters — an agent's answer is the
last thing it printed — and records both that it was truncated and the original
length. A path into a transcript that `restore` may have already replaced would
be a reference to something the ledger cannot promise still exists.

**The ADK dev server has no `working` rule.** R15 asks for "request handling →
`working`", and uvicorn cannot supply it: it writes its access line when a
request has *finished*, so a rule matching that line would pin the tile to
`working` from the first request until the line scrolled away — the exact rot
this PRD exists to get away from. A completed request is therefore classified
`idle`, which is true both before traffic and after it. Watching a *deployed*
agent's state is what `herd remote add` is for.
