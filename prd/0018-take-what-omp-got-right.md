---
openprd: "0.3"
id: "0018"
title: "Take what omp got right: cross-engine handoff, stream rules, and a usage ledger"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-09-25
updated: 2026-09-25
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/cost.mjs, src/pty.mjs, src/engines.mjs, src/openfleet.mjs, src/swarm.mjs, src/herd.mjs, src/mcp.mjs
tags:
  - engines
  - herd
  - cost
  - openfleet
  - dx
supersedes:
superseded-by:
---

## Problem

moshcode v0.104.2 added omp as an engine (#536). Installing it meant reading what it
does, and omp turns out to be the most interesting harness in the set: roughly 80k
lines of Rust, 60+ providers, 31 built-in tools, 14 LSP operations, 28 DAP operations,
and a handful of ideas nobody else has shipped.

Most of that is not ours to take. The Rust core, the in-process ripgrep, the LSP and
DAP wiring are engine internals. moshcode is a wrapper. It inherits those from whatever
engine it launches, and rebuilding them would be building a twelfth engine instead of
wrapping eleven.

But a few of omp's ideas are only half-built, because omp can only ever apply them to
omp. It imports sessions from Claude Code and Codex, one direction, into itself. Its
stream rules correct one model, its own. Its usage report covers the providers it
happens to be configured with. Each of those is a single-agent version of something
moshcode is already positioned to do across all eleven engines.

Three things make this cheap rather than speculative:

- `src/cost.mjs` already knows where every engine writes its session log, because that
  is how burn windows and folded subagent transcripts work. That is the half of a
  cross-engine handoff worth reusing, and it is smaller than it first looked: cost.mjs
  reads usage and throws the conversation away on purpose. Its Claude reader skips every
  record that is not an assistant turn and never opens `message.content`; its Codex
  reader loads only the head and the tail of a rollout, so the middle, which is the
  conversation, is never read; its opencode reader takes the token columns and never
  joins the table the text lives in; its qwen reader is pointed at a usage log with no
  message text in it at all. So the path discovery and the file plumbing are reusable
  and are reused, and the conversation readers are new. See R1.
- `src/pty.mjs` and the herd panes already sit between the user and the engine's output
  stream. Stream rules belong at that layer, where they are engine-agnostic by
  construction.
- `moshcode cost` already reports spend. It does not report remaining limits, which is
  the number that actually matters when one Anthropic key is shared across 13 production
  vaults under a single spend cap.

Two things are already done and should not be re-proposed. `src/completion.mjs`
generates shell completions from `src/cli-schema.mjs`, so moshcode already has omp's
no-drift completions. And `src/advisor.mjs` is advis0r.com equity research, not an
advisor model, so that filename is taken and any advisor-model work needs a different
name.

## Goals

- A conversation can move between engines. Start in Claude Code, continue in Codex,
  finish in omp, without retyping context or losing what was decided.
- A swarm's lineage gap closes as a side effect, because a handoff is exactly the edge
  OpenFleet wanted recorded and PR 502 did not write.
- Correcting a model mid-run does not cost context, and does not have to be reimplemented
  per engine.
- Before a run starts, the sysop can see what headroom is left on the account it will
  land on, not just what the last run cost.
- No engine process ever reads a credential out of a .env file.
- Every verb this PRD adds is reachable from the CLI, the TUI and the MCP bridge, per the
  house agent-surfaces rule.

## Non-Goals

- Rebuilding omp's engine internals. The Rust core, in-process utilities, LSP and DAP
  stay where they are. moshcode wraps omp to get them.
- Shell completions. Already generated from `cli-schema.mjs`.
- A web dashboard on a localhost port. omp's `stats -p` is a browser page. The house
  stack says hqtui for dashboards, so moshcode's equivalent is a TUI.
- Lossless handoff. Engines do not share a transcript schema and never will. This PRD
  targets a faithful conversational handoff, not a byte-exact clone.
- Replacing `moshcode swarm`. `cleanse` is a preset over the existing swarm, not a
  second orchestrator.

## Users

- The sysop running several engines a day who currently restarts a conversation from
  scratch whenever one engine stalls or hits a cap.
- The human reading `moshcode fleet tree` afterwards, who wants to know which run
  descended from which.
- The operator on a shared key who needs to know whether the next run will be refused
  before starting it.

## Requirements

- R1 [P0] `moshcode handoff <from-engine> <to-engine> [--session <id>]` reads the source
  engine's transcript, renders it to a portable transcript, and launches the target
  engine seeded with it. Defaults to the source engine's most recent session for the
  current directory. The reader lives in `src/transcript.mjs`, which takes cost.mjs's
  path discovery and file plumbing (`claudeProjectSlugs`, `claudeTranscripts`,
  `codexSessionsDir`, `OPENCODE_DBS`, and the head/tail line readers) and adds the
  conversation readers cost.mjs does not have, because cost.mjs discards message content
  by design. cost.mjs imports the shared half back, so there is one place that knows
  where an engine writes. Source coverage is narrower than target coverage and both are
  stated by name: an engine moshcode cannot read, and an engine that takes a prompt only
  headlessly, are each refused with the reason rather than half-supported.
- R2 [P0] A handoff writes an OpenFleet record linking child to parent, so the edge shows
  up in `moshcode fleet tree` without a separate lineage feature.
- R3 [P0] The portable transcript is a documented format under `prd/` or `docs/`, not an
  internal shape, so a twelfth engine only needs a reader and a writer to join. Written
  down at [docs/portable-transcript.md](../docs/portable-transcript.md).
- R4 [P0] `moshcode cost limits` reports remaining provider headroom per account, across
  engines, alongside the burn rows already there. Credentials come from the vault, never
  from the environment.
- R5 [P1] `moshcode cost route <model>` is a dry run answering which account a call would
  actually land on, before spending anything on finding out.
- R6 [P1] Stream rules. A rule watches an engine's output stream through `pty.mjs` and
  can inject a correction without adding to the model's context. Rules live in
  `~/.moshcode`, sync through synconfig, and apply to every engine because they sit below
  all of them.
- R7 [P1] `moshcode rules test <rule> <transcript>` replays a rule against a saved
  transcript so a rule can be trusted before it is armed. Tests use `node --test`.
- R8 [P1] `moshcode auth serve` hands per-engine credentials to engine processes from the
  vault, so no engine reads a .env. Honours the existing `login` and `whoami` verbs.
- R9 [P2] Session branching. Forking a conversation at an earlier turn opens the branch as
  a new herd pane beside the original, rather than as a modal tree the user pages through.
  Both branches run and are visible at once.
- R10 [P2] `moshcode grievances [list|clean|push]` collects engine complaints about their
  own tooling and pushes each as an issue to the correct repo.
- R11 [P2] `moshcode cleanse [-n <agents>]` is a swarm preset that finds and fixes
  diagnostics and failing tests.
- R12 [P0] Every verb above is exposed through the MCP bridge, per the house rule that a
  CLI ships an MCP bridge. Any dashboard is hqtui.
- R13 [P0] Copy in this feature set follows the house standard. Short sentences, no em
  dashes.

## UX Notes

The handoff is the whole product and should read like one line of intent. `moshcode
handoff claude codex` with no further arguments picks the obvious session and says what
it picked before launching. When the target engine is already running in a herd pane, the
handoff lands in that pane rather than opening another.

Naming matters here. `advisor` is taken by equity research, so an advisor-model feature
needs its own word if it is ever built. `cost limits` is a verb under an existing noun
rather than a new top-level `usage`, because the sysop already looks at `moshcode cost`
and should not have to learn where the other half of the same question lives.

Stream rules are the one feature that can silently make an engine worse. They are off
until armed, `rules test` runs against a real saved transcript, and an armed rule that
fires is visible in the pane rather than invisible.

## Success Metrics

- A conversation survives a move between at least three engines with the decisions intact,
  judged by the receiving engine continuing the work without re-asking.
- `moshcode fleet tree` shows handoff edges, closing the lineage gap PR 502 left.
- `moshcode cost limits` answers "will this run be refused" before the run, on the shared
  Anthropic key.
- Zero engine processes launched by moshcode read a credential from a .env file.
- Stream rules are engine-agnostic in fact, demonstrated by one rule correcting at least
  three different engines unchanged.

## Risks & Open Questions

- Transcript formats drift. `cost.mjs` reads them today and will break when an engine
  changes its shape. Handoff inherits that fragility and makes it louder, since a bad read
  now corrupts a conversation instead of a cost number. Fixtures per engine, and a handoff
  that refuses rather than guesses.
- Seeding a target engine is per-engine work. Some take a prompt on stdin, some take a
  file, some have a resume flag that only reopens their own last session. `engines.mjs`
  already records the resume argv, so the seam exists, but each engine needs its own
  writer and some may not be seedable at all. Those should be listed as unsupported rather
  than half-supported.
- A rule that injects mid-stream is close to prompt injection against your own engine.
  Rules must be local files under `~/.moshcode`, never fetched, and never installable by
  an agent without the human arming them.
- Provider limit reporting is not uniform. Some providers publish headroom, some only
  report after a refusal. `cost limits` should say which of the two it is showing rather
  than presenting a guess as a reading.
- Open question, now settled: handoff carries the conversation plus the list of files the
  source session wrote, and no edits. Carrying edits risks replaying them, and the working
  tree is already the real state. The format says so as a rule rather than as a default.
- No engine can reopen an arbitrary session from the command line. Every `resume` argv in
  `engines.mjs` reopens that engine's own last conversation and nothing else, so a handoff
  always starts a new session on the target and hands it the old conversation to read.
- Seeding is bounded twice over. An engine takes its first prompt as one argv value, and
  argv is roughly 2MB on Linux; a prompt typed into a live pane is submitted by its first
  newline, which is why `swarm` flattens newlines out of what it sends. The seed is
  therefore a single line naming a file on disk, not the transcript itself.
- Open question: the portable transcript format is a candidate for a `@profullstack/*`
  package if anything else ever needs to read engine transcripts. Per the reuse-first rule,
  check before writing a second copy.
