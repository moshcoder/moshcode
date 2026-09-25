---
openprd: "0.3"
id: "0019"
title: "Take what swamp got right: heartbeat liveness, immutable run history, and workflow DAGs"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-09-25
updated: 2026-09-25
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/tools.mjs, src/herd-state.mjs, src/openfleet.mjs, src/swarm.mjs, src/moshscript.mjs, src/skills.mjs, src/settings-sync.mjs
tags:
  - herd
  - openfleet
  - swarm
  - moshscript
  - dx
supersedes:
superseded-by:
---

## Problem

Swamp (swamp-club.com, github.com/systeminit/swamp, by System Initiative) is a
deterministic automation CLI written in TypeScript on Deno. It is not a coding agent.
It is the thing a coding agent drives, and it ships first-class skills for Claude Code,
Cursor, OpenCode and Codex so all four can call it. moshcode now installs it as a tool:
`moshcode install swamp`.

It is worth a PRD because swamp has already solved three problems moshcode keeps paying
for.

The first is liveness. moshcode decides whether an engine is working, blocked or gone by
matching regular expressions against what the engine printed. `src/engines.mjs` carries
per-engine `state` patterns for permission prompts and trust dialogs, and the herd reads
pane titles. Every one of those is a guess about another vendor's UI, and the guesses
expire. Claude Code 2.1 overwrote the pane title and dropped "? for shortcuts" from its
footer, and detection broke. It will break again, because nothing in that arrangement is
a contract. Swamp does not guess. It keeps a local SQLite run tracker and a run is alive
because it sent a heartbeat.

The second is the record. moshcode writes an OpenFleet ledger and parses engine
transcripts in `src/cost.mjs`, but there is no single immutable, versioned, searchable
answer to "what ran, with what inputs, producing what". Swamp records every run that way
by default, inputs and outputs and every step between.

The third is orchestration shape. `moshscript` (PRD 0004) is a script and `moshcode
swarm` (PRD 0015) is a flat fan-out into phases. Swamp's workflows are DAGs with
dependency resolution, which is where its parallelism comes from: it does not need to be
told what can run at once because the graph already says so.

There is also a smaller lesson worth writing down. Swamp has four configuration layers
with a documented precedence: repo, user, environment, CLI. moshcode has `~/.moshcode`,
synconfig, and environment overrides such as `MOSHCODE_ENGINE_BIN_*`, with no written
order. PR #535 existed to isolate the test suite from those overrides, which is the bill
for leaving precedence undocumented.

## Goals

- An engine's state is reported because the run said so, not because its footer still
  matches a pattern we wrote months ago.
- A run's inputs, outputs and steps are recoverable afterwards, immutably, without
  re-parsing a vendor transcript.
- A swarm expresses what depends on what, and gets its parallelism from that rather than
  from a phase count chosen by hand.
- `moshcode doctor` answers "is this installation actually healthy" in one command.
- Configuration precedence is written down and tested.
- Ideas are taken, code is not. See Non-Goals.

## Non-Goals

- Vendoring or copying swamp's source. Swamp is AGPL-3.0 with a Swamp Extension and
  Definition Exception. moshcode is MIT. Every requirement here is an independently
  implemented idea, and no swamp code, schema file or extension is to be copied into this
  repo. This is the binding constraint on the whole PRD.
- A Deno runtime. moshcode is Node and ESM per the house stack.
- Replacing moshscript or swarm. This reshapes what swarm records and how it orders work.
  It does not add a second orchestrator.
- Re-proposing the credential vault. Swamp injects credentials at runtime so they never
  reach a prompt, which is the same requirement as PRD 0018 R8 arriving from a second
  direction. It stays in 0018. That two unrelated tools converged on it is the argument
  for building it, not for writing it twice.
- Swamp's hosted side. Serve, fleet tokens and the club account are theirs. moshcode
  wraps the local CLI.

## Users

- The sysop whose herd says an engine is idle when it is waiting on a permission prompt,
  because that engine shipped a new footer last week.
- The human asking, a day later, what a swarm actually did and with which inputs.
- Anyone debugging an install where the binary is present but not on PATH, or where the
  checkout is twenty commits behind `~/.moshcode/pkg`.

## Requirements

- R1 [P0] Swamp is installable as a moshcode tool, with its non-interactive flag set so a
  piped install never stalls on the vendor's signup prompt, and with every non-root
  landing directory searched. Done in this change.
- R2 [P0] Heartbeat liveness. A moshcode-started run records a heartbeat, and herd state
  is derived from it first. Output pattern matching stays as a fallback for engines that
  cannot report, and is labelled as inference rather than fact.
- R3 [P0] A run record is immutable and versioned: inputs, the engine and model, every
  step, and outputs. It extends the OpenFleet ledger rather than opening a second store.
- R4 [P1] Run history is searchable from the CLI, the TUI and the MCP bridge, per the
  house agent-surfaces rule. Any dashboard is hqtui, not a localhost web page.
- R5 [P1] Swarm pieces declare dependencies, and the runner derives concurrency from the
  resulting DAG instead of from a fixed phase list. A piece with no dependencies starts
  immediately.
- R6 [P1] `moshcode doctor` checks the things that have actually gone wrong before: binary
  present but not on PATH, checkout behind the installed package, an engine bin override
  in the environment, a half-finished DNS enable, and a stale config. It exits non-zero on
  a real fault and says what to run next.
- R7 [P1] Configuration precedence is documented and tested: repo, user, environment, CLI,
  in that order, with `moshcode doctor` able to print which layer won for a given key.
- R8 [P1] Skills install to `.agents/skills` alongside the per-vendor paths, so a skill
  moshcode installs is visible to any agent that adopts the neutral convention. Extends
  PRD 0003.
- R9 [P2] `moshcode audit` reviews command history: what was run, by whom or by which
  agent, and what it touched.
- R10 [P2] Plugins carry a quality signal, so `moshcode plugin discover` can rank rather
  than only list. Extends PRD 0008.
- R11 [P2] A generated moshscript can be validated against a schema before it runs, so a
  script an agent wrote fails at validation rather than halfway through execution.
- R12 [P0] Copy follows the house standard. Short sentences, no em dashes.

## UX Notes

Liveness is the requirement that changes what the herd feels like, and it has to degrade
honestly. An engine that reports a heartbeat is shown as known. An engine whose state was
inferred from its output is shown as inferred. Today both look identical and one of them
is frequently wrong, which is worse than either.

`doctor` should be boring and specific. Not a score, not a spinner. A list of checks with
a verdict each, and for anything that fails, the exact command that fixes it. Every check
in R6 is drawn from a failure that has already happened here at least once.

Swamp is a tool, not an engine, and the help wall should keep it that way. `moshcode
agents` lists things you can land a herd pane on and start talking to. Swamp has no
interactive session, so it lives with railway, gh and supabase instead.

## Success Metrics

- A vendor UI change no longer produces a wrong herd state for engines that heartbeat.
- Every swarm run is reconstructable from its record alone, without the original
  transcripts.
- Swarm wall-clock time on a task with independent pieces improves against the current
  phase-ordered run.
- `moshcode doctor` reproduces at least four previously-hit failures as failing checks,
  on purpose, in tests.
- Precedence has a test that pins the order, so PR #535's isolation problem cannot recur
  silently.

## Risks & Open Questions

- Heartbeats only exist for runs moshcode starts. An engine launched by hand in a pane
  still has to be inferred, so the two-tier display in UX Notes is permanent rather than
  transitional.
- An immutable run record grows without bound. It needs a retention story before it
  ships, not after. omp's `gc` with per-directory retention is the shape to copy.
- A DAG is more expressive than the current phase list, which means a planner can now
  author a cycle or a deadlock. The runner must reject a cyclic graph up front with the
  cycle named.
- The license boundary is real and easy to cross by accident, particularly for anyone
  reading swamp's YAML schemas while implementing R5 or R11. Requirements here describe
  behaviour on purpose and name no swamp file. If an implementation needs their schema,
  that is the moment to stop and take legal advice instead.
- Open question: does the run record belong in SQLite like swamp's, or in the JSON and
  append-only files OpenFleet already uses? SQLite buys search cheaply. Files keep the
  "no daemon, no database, one host" property PRD 0016 chose deliberately. Deciding this
  is the first task, because R3 and R4 both depend on it.
- Open question: `.agents/skills` is a convention, not a standard. Worth checking whether
  anything beyond swamp reads it before treating it as a destination.
