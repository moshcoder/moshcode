---
openprd: "0.2"
id: "0009"
title: "Keep the herd alive — a persistent runtime, semantic agent state, and one control surface for humans and agents"
status: Accepted
authors:
  - anthony@profullstack.com
created: 2026-08-09
updated: 2026-08-09
repo: https://github.com/moshcoder/moshcode
discussion: https://github.com/moshcoder/moshcode/pull/341
implementation: src/herd.mjs, src/herd-state.mjs, src/herd-cli.mjs
tags: [runtime, sessions, agents, tui, notify]
supersedes:
superseded-by:
---

## Problem

moshcode is a *launcher*. `openPassthrough` hands the whole terminal to an
engine with inherited stdio, which is exactly why `moshcode agents claude` feels
native — and exactly why everything about that session is tied to the terminal
that started it. Three consequences, all of them daily:

**Work dies with the window.** Close the lid, drop the VPN, lose the SSH link,
reboot for a kernel update — every running engine goes with it. `tabs.mjs`
already reaches for tmux, but it starts a *private server keyed to the pit's
pid* (`moshcode-${pid}-${stamp}`, `-f /dev/null`), so the tabs are as mortal as
the pit that spawned them. There is no way to walk away from a long agent run
and come back to it.

**You cannot see which agent needs you.** The pit knows an engine is running; it
does not know whether that engine is thinking, waiting on a permission prompt,
or finished twenty minutes ago. With one engine you notice. With four tabs you
tab-cycle and squint. The information exists on the screen and moshcode throws
it away.

**The mirror is blind at the only moment that matters.** `mirror.mjs` documents
its own limit: *"once an engine takes the terminal (`/agents claude`), the child
writes straight to the tty on its own fd — those bytes never pass through this
process. The mirror shows the hand-off, not the engine's screen."* So
`/sessions` on app.moshcode.sh, the PWA, and `moshcode console` all watch a pit
that has stopped saying anything interesting. `pty.mjs` was built to solve this
and is not yet load-bearing.

[herdr](https://herdr.dev) attacks the same problem from the other end: *"a
server owns the terminals; every UI is a client of it."* Terminals live in a
background server, panes carry a semantic agent state (`idle` / `working` /
`blocked` / `done`), and the CLI and socket API are one surface so agents drive
it the same way people do. That inversion — the runtime outlives the client — is
the idea worth taking. Its implementation (a 10MB Rust multiplexer with mouse
drag, pane splits, and a plugin marketplace) is not.

This PRD ports the ideas, not the binary.

## Goals

- An agent session survives the terminal that started it — closing the lid, an
  SSH drop, or a reboot costs you nothing but a reattach.
- Opening the pit answers "what is running and what needs me?" before you type
  anything.
- A blocked agent reaches the human wherever they are, and the answer comes
  back into the session. moshcode already has `notify()`/`ask()` fan-out to
  email/SMS/Slack/Telegram/push; a runtime that knows what "blocked" means is
  what turns that into an unattended-agent story.
- The browser (`console`, `/sessions`, the PWA) becomes a real client of the
  same runtime, showing the engine's actual screen instead of the hand-off line.
- One agent can start, prompt, and wait on another without a human, through the
  same verbs a human types.
- None of the above changes what `moshcode start claude` feels like today.

## Non-Goals

- **Writing a multiplexer.** No pane splits, no mouse drag, no border
  resizing, no right-click menus, no theme engine. tmux exists, is already the
  substrate in `tabs.mjs`, and is better at this than we will be.
- **A native binary or a compiler in the install path.** `install.sh` untars a
  release and runs node; `pty.mjs` explicitly rejects node-pty for this reason.
  The runtime must hold that line — zero-dependency ESM, capability detection,
  graceful degradation.
- **A pane-plugin marketplace.** moshcode already ships plugins, skills, and MCP
  servers on the *engine* axis (PRD 0003, PRD 0008). A second plugin system for
  panes is not a gap we have.
- **Windows.** Same posture as today: POSIX first, and the capability check
  fails soft everywhere else.
- **A worktree/diff review UI.** Interesting, adjacent, and a different PRD.
- **Owning the user's tmux.** People with a tmux config keep it. The runtime is
  a separate named server, exactly as `tabPlan()` already reasons about.

## Users

- **The solo operator running several agents at once** — the pit's core user.
  Wants to fire off three long tasks, close the laptop, and find out later which
  one stopped to ask a question.
- **A moshcoder on a rented box.** Runs the pit over SSH on a Hetzner/Railway
  dev box. Every dropped connection currently kills a run. Wants `moshcode` over
  SSH to reattach to what was already going.
- **The agent itself.** A `moshscript` or a Claude Code session that needs to
  spawn a helper on a second engine, hand it a prompt, and block on the result —
  today that means `tabs.mjs` and hope.
- **The phone.** Someone away from the desk who gets a push saying "codex is
  blocked on a permission prompt in ~/src/coinpay" and answers from the PWA.

## Requirements

### Phase 1 — the runtime survives you

- **R1 [P0] A named, detached runtime.** `moshcode runtime` starts (or reports)
  a single long-lived tmux server on a stable socket (`moshcode`, not
  `moshcode-${pid}-${stamp}`), started with `-f /dev/null` so advertised
  keybindings stay true. Sessions inside it outlive every pit that attaches.
  `moshcode runtime status|stop --json` for the machine.
- **R2 [P0] Capability detection, and a soft floor.** Follow `pty.mjs`'s
  discipline exactly: probe for a usable tmux once, cache the verdict, and when
  it is missing fall back to today's foreground `openPassthrough` with a single
  honest line (`no tmux — this session ends with the terminal`). moshcode must
  never harden a soft dependency into a hard one.
- **R3 [P0] Named sessions.** `moshcode start`/`moshcode agents` accept
  `--name <slug>` (`[a-z][a-z0-9_-]{0,31}`, herdr's shape) and default to
  `<engine>-<basename-of-cwd>` with a numeric suffix on collision. The name is
  the handle for everything that follows.
- **R4 [P0] Attach and detach.** `moshcode attach <name>` drops you into the
  live session; the detach key returns you to the pit and leaves the engine
  running. Detaching is the default exit path; killing is explicit
  (`moshcode kill <name>`). Bare `moshcode` with exactly one detached session
  offers to reattach rather than opening an empty prompt.
- **R5 [P0] The roster.** `moshcode ps` lists every session: name, engine,
  state, cwd, age, attached-client count. `--json` for automation. The pit's
  banner shows the same roster in miniature when anything is running, so opening
  moshcode answers "what's alive?" before you type.

### Phase 2 — the runtime knows what the agents are doing

- **R6 [P0] Semantic state.** Every session carries one of `idle`, `working`,
  `blocked`, `done`, `unknown`. `blocked` means "a human decision is the only
  thing missing" — the permission prompt, the plan approval, the y/n. This is
  the vocabulary the roster, the notifications, and `wait` all share.
- **R7 [P0] Two-tier detection with one authority per session.** Adopt herdr's
  rule verbatim in spirit: *"each pane has one status authority."*
  - Tier 1, authoritative: engine-native lifecycle hooks. moshcode already
    installs across engines (`plugins.mjs`, `skills.mjs`, `mcp.mjs`, PRD 0003) —
    reuse that machinery to drop a status reporter into each engine's hook
    config, and let it report state directly.
  - Tier 2, fallback: classify the tail of the session's screen against a
    per-engine rule table declared next to `ENGINES` in `engines.mjs`, so a new
    engine ships its detection rules with its install spec.
  - A session with a working tier-1 hook does **not** also run tier-2. Two
    sources of truth is the failure mode herdr calls out and it is a real one.
- **R8 [P1] Unknown is a first-class answer.** An engine with no hook and no
  matching rule reports `unknown` and still runs perfectly. Detection is a
  feature of the roster, never a gate on launching anything.
- **R9 [P0] Blocked reaches the human.** A session entering `blocked` (and
  optionally `done`) fires `notify()` through the existing approvals app with
  the session name, engine, cwd, and the tail of the prompt that blocked it.
  When the operator answers via `ask()`, the reply is typed into the session.
  This is the piece herdr structurally cannot do — it can colour a pane; we can
  text you and take the answer back. Off by default, `moshcode notify on`, and
  rate-limited so a chatty engine cannot page someone forty times.
- **R10 [P1] Wait instead of poll.** `moshcode wait <name> --state blocked,done
  --timeout 30m` blocks until the transition and exits with a distinct code per
  outcome. Both a human in a shell script and an agent in a moshscript get to
  stop screen-scraping.

### Phase 3 — one surface for humans and agents

- **R11 [P0] Agent verbs.** `moshcode agent start|prompt|read|send-keys|
  wait|stop`, every one accepting a session name and every one supporting
  `--json`. `prompt --wait` submits input and blocks until the session leaves
  `working` — the single most useful composite. herdr's framing is the target:
  *"the cli and socket api are the same surface agents drive."* moshcode's
  version of that is simply that there is no second surface; the CLI *is* the
  API, and `--json` is how a machine reads it.
- **R12 [P0] moshscript verbs.** Every verb in R11 is exposed in `runtime.mjs`'s
  vocabulary, so a `.mosh` script can fan work out across engines and join on
  the results. This is what PRD 0004 was for and what it has been missing.
- **R13 [P1] The browser sees the real screen.** Route a session's output
  through `pty.mjs` into `mirror.mjs`, closing the documented blind spot, and
  point `console.mjs`'s ttyd at `moshcode attach <name>` so the browser terminal
  is a genuine second client of the same live session. Multiple clients on one
  runtime, which is herdr's axis and one moshcode is already three-quarters
  built for.
- **R14 [P1] Restore the shape after a reboot.** Persist a manifest
  (`~/.moshcode/runtime.json`, mode `0600`) of sessions: name, engine, cwd, and
  the engine's own resume reference where it has one. On the next `moshcode`,
  re-open the sessions in their directories and offer
  `moshcode restore [--resume]` to resume native engine conversations
  (`claude --resume`, `codex resume`, and per-engine equivalents declared in
  `ENGINES`). Structure comes back automatically; *processes* do not, and the
  UI must say so rather than implying the work continued.
- **R15 [P2] Scrollback replay, off by default.** Restoring screen contents
  across a reboot means writing engine output to disk. The same reasoning that
  put `.moshcode_history` at `0600` — *"the pit records whatever was typed at
  the prompt, and that includes secrets by design"* — applies harder here, since
  engine output includes tokens the user never typed. Opt-in flag, `0600`, and a
  documented retention cap. herdr ships this the same way (`[experimental]
  pane_history`) and that is the right call.

## UX Notes

**New verbs, in the existing shape.** The command table is generated from
`cli-schema.mjs` and a test fails the build on drift, so these land as real
entries in a new `runtime` group:

| command | what it does |
|---|---|
| `moshcode herd` | the namespace: status, start, prompt, read, send-keys, report, notify, watch, prune, stop |
| `moshcode ps` | list sessions with state |
| `moshcode attach <name>` | attach to a session |
| `moshcode kill <name>` | end a session |
| `moshcode wait <name>` | block until a state transition |
| `moshcode restore` | rebuild sessions from the manifest |

The namespace is `herd`, not the `runtime` / `agent <verb>` this document first
proposed. Two reasons, both found while building it. `agent` is already a
registered alias of `agents` in `PIT_COMMANDS`, and a test pins
`suggest("agent") === "agents"` — so `moshcode agent start` would have meant two
different things depending on where it was typed. And `runtime` is what
`src/runtime.mjs` already calls the moshscript interpreter. The five verbs
people reach for most are top-level anyway, which is what the original table was
really asking for: nobody should have to learn a namespace to ask what is
running.

TUI equivalents follow the existing convention: `/herd`, `/ps`, `/attach <name>`,
`/kill <name>`, `/wait`, `/restore`. `/agents <engine>` and `/start <engine>`
keep their meaning and simply gain `-d` / `--name`.

**The pit's front door changes.** Today `moshcode` prints a banner and a prompt.
With anything running it prints the herd first:

```
  mosh ▸ 3 running
    coinpay-fix    claude    blocked   ~/src/coinpay        12m
    ugig-tests     codex     working   ~/src/ugig.net        4m
    dns-audit      opencode  done      ~/src/moshpit-dns     1h
```

State is the column that earns its place — colour it with the existing `ui.mjs`
palette (`acid` working, `warn` blocked, `ok` done, `ash` idle). One line per
session, no box drawing, no full-screen takeover: the pit stays a prompt.

**Detach must be discoverable.** The single biggest confusion risk is a user who
thinks they quit and left an engine burning tokens. Print the detach key on
attach, and on detach print what is still running and how to get back:
`detached — coinpay-fix still working · moshcode attach coinpay-fix`.

**Naming is optional.** `--name` is there for scripts and for people who want
it. A user who never types it still gets `claude-coinpay` and can attach by it.

**Notifications are opt-in and quiet.** Default off. When on, one notification
per state transition into `blocked`, coalesced within a window, and never for
`working`. The approval link deep-links to the session in the PWA.

**Degradation is loud once, then silent.** Without tmux, the first session in a
pit prints one line explaining that sessions end with the terminal, then behaves
exactly like today. No repeated nagging, no failure.

## Success Metrics

- **Survival:** a session started in a pit is still running and reattachable
  after the terminal is closed and the machine is left for an hour — measured by
  an integration test that kills the parent pit and reattaches.
- **Reattach adoption:** share of pit launches that begin with a reattach rather
  than a cold start. If nobody reattaches, the runtime is not earning its
  complexity.
- **Time-to-unblock:** median wall-clock between a session entering `blocked`
  and a human answering, before vs after R9. This is the number that says
  whether the notification path is real.
- **Detection quality:** on the top five engines, `blocked` is reported within
  three seconds of the prompt appearing, with no false `blocked` in a
  thirty-minute unattended run.
- **Zero-regression:** `moshcode start <engine>` launch time and native feel
  unchanged; the runtime adds no measurable startup cost when no session exists.
- **Install stays clean:** `install.sh` gains no dependency, and the tmux-less
  path passes the full test suite.

## Risks & Open Questions

- **tmux is a soft dependency that this PRD leans on hard.** R2 is the mitigation
  and it must be honoured in code, not just in prose: every runtime call site
  needs a tested fallback. Open question: is a second substrate
  (`script(1)` + a detached child, reusing `pty.mjs`) worth building for
  tmux-less boxes, or is the honest degradation enough? Recommendation: enough,
  for now.
- **Screen-scraping state is fragile by construction.** Engines change their
  prompts between releases and the rules rot silently. Mitigations: rules live
  beside each engine in `ENGINES` so they version together; `unknown` is
  always safe; and tier-1 hooks are the real answer — prioritise hook coverage
  for `claude`, `codex`, and `opencode` over broad rule tables.
- **A long-lived runtime is a longer-lived attack surface.** The tmux socket is
  filesystem-permissioned to the user and that is the whole boundary. Anything
  that widens it — R13 pointing ttyd at a session, R15 writing scrollback —
  inherits `console.mjs`'s existing rule: loopback only, token-gated, `0600` on
  disk. A reboot-surviving runtime holding engine scrollback is a materially
  different secret-exposure profile from today's ephemeral pit, and the PRD
  should not pretend otherwise.
- **Notification fatigue kills the feature.** Get the coalescing window and the
  `blocked` definition right, or users turn it off in a day and never turn it
  back on. Open question: should `done` notify by default? Leaning no — `done`
  is what the roster is for.
- **Two ways to open a session is a real cost.** Detachable sessions plus the
  existing `tabs.mjs` tmux tabs is one concept too many. Open question: does
  `openNewTab` become a thin wrapper over the runtime (a tab is just an attach
  to a new session), and does that break the "fresh pit, never repeats argv"
  contract? Leaning yes, it should be folded in — a second tmux server per pit
  stops making sense once a stable one exists.
- **Reboot restore promises more than it delivers.** Users will read "restore"
  as "my agent kept going." It did not. The copy has to distinguish *the shape
  came back* from *the work continued*, and `--resume` has to be an explicit,
  visible act.
- **Scope.** Phases 1–3 are independently shippable and should ship that way.
  Phase 1 alone — sessions that survive the terminal — is the bulk of the value
  and does not require a single line of state detection.

## Implementation Notes

Written after the build, so the document and the code agree.

**A second substrate, which this PRD did not ask for.** R2 promised only to
degrade gracefully without tmux. That was not good enough: `/new` already
required tmux and it is the wart people notice. So there are two substrates
behind one interface — tmux when the box has it, and otherwise `script(1)` with
the session's stdin on a FIFO, reusing the capability detection `pty.mjs`
already does. The FIFO is opened `O_RDWR` before the spawn so the child is its
own writer and never sees EOF when the pit exits, which is the whole trick. Its
one real limit: nothing outside a pty can ioctl its master, so the size is fixed
at launch (set from inside by `stty`) and a later resize does not reach it.
`MOSHCODE_HERD=pty` forces it, which is how the fallback is tested on a box that
has tmux.

**Two bugs the survival test caught**, both of which would have shipped as
"finished agents report `gone`". tmux's `remain-on-exit` was being set in a
second call, and a fast command finishes before that process starts — fixed by
making the session and its option one invocation using tmux's `;` argument. And
the pty substrate could not tell "the agent finished" from "the box rebooted",
since both are a dead pid — fixed by having the session's own shell record its
exit code on the way out.

**Delivered:** R1–R12 and R14. Both substrates are covered by an integration
test that starts a session in one process, exits it, and talks to the session
from another.

**Not delivered, deliberately:**

- **R7 tier-1 hook installation.** The protocol ships and works —
  `moshcode herd report <name> <state>` takes authority, suppresses screen
  classification entirely while it is live, and expires so a crashed agent
  cannot read `working` forever. What is not built is auto-installing that call
  into each engine's hook config via the `plugins.mjs` / `skills.mjs` fan-out.
  Until then tier 1 is opt-in and tier 2 carries the roster.
- **R13, the browser as a real client.** `console.mjs` still points ttyd at a
  shell rather than at `moshcode attach <name>`, and `mirror.mjs` keeps its
  documented blind spot. The runtime it would attach to now exists, so this is a
  small follow-up rather than a design question.
- **R15, scrollback replay.** P2 and opt-in in this document; still the right
  call not to write engine output across a reboot by default.

**Rules will rot, and that is planned for.** The shipped patterns are
conservative and anchored to things a terminal draws — brackets, selectors, line
anchors — never bare English words, and a test asserts that. `unknown` is
common and safe. `~/.moshcode/herd/rules.json` lets a rotted pattern be fixed on
the box it rots on, and a malformed entry there loses that pattern rather than
the file.
