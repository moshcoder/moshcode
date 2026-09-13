---
openprd: "0.3"
id: "0015"
title: "Swarm — one task, a herd of agents, one answer"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-09-13
updated: 2026-09-13
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/swarm.mjs
tags:
  - herd
  - agents
  - workflow
  - ultracode
supersedes:
superseded-by:
---

## Problem

Claude Code has ultracode: put the keyword in a prompt and the prompt becomes a workflow of agents that is planned, fanned out, verified and synthesised. It is the single most useful thing that CLI does at scale, and it is one vendor's.

moshcode's herd is the same idea with the vendor removed. Sessions outlive the terminal, `herd prompt --wait` hands an agent work and blocks until it lands, the task ledger keeps what every session did, and moshscript can already wire a fan-out by hand: `herdStart` three times, `herdPrompt` three times, `herdWait`. Nobody does, because it is a script to write every time, and the pieces that make a swarm worth running, splitting the task so the agents do not collide and folding what they did back into one answer, are the pieces the script does not give you.

So agents at scale exist in moshcode as parts. This PRD is the verb.

## Goals

- One command turns a task into a swarm: `moshcode swarm "<task>"`.
- Any engine moshcode can start can be the swarm, not one vendor. Whatever `ai()` can run headlessly can plan and synthesise; whatever `herd start` can run can be a member.
- The operator sees each phase as it happens, and every piece of work is a task in the ledger they can open afterwards.
- A swarm is bounded by default. Four agents at a time, the same number the claude engine's settings defaults cap Claude's own workflows at, so one swarm cannot eat the box the rest of the herd runs on.
- A swarm degrades rather than fails. A plan that does not parse becomes one piece; a piece whose session never became ready is reported as failed and the synthesis says so; a synthesis that fails still leaves the pieces in the ledger.
- The orchestration is testable without tmux or a model on the box.

## Non-Goals

- A general workflow language. Ultracode's script API (pipeline, barriers, budgets) is out of scope; moshscript already exists for anyone who wants to compose the herd by hand.
- Cross-piece coordination while the swarm runs. Pieces are planned not to touch the same files; if the plan gets that wrong, the synthesis reports the contradiction and the operator resolves it.
- Remote members. A swarm runs on this box's substrate in v1; PRD 0011's remote members are the obvious next step and this design does not preclude them.
- Cost accounting beyond what `moshcode cost` already does per session.

## Users

- An operator with a task too wide for one session who does not want to write the moshscript.
- A herd already running that wants a burst of parallel work without losing track of what each burst did.
- moshcode itself: the swarm is what the pit reaches for when a task is an "all of these at once" task.

## Requirements

R1. `moshcode swarm "<task>"` plans the task, fans it out, and prints one synthesised answer. It works from the CLI, the pit (`/swarm`) and moshscript (`swarm(...)`).

R2. Planning is one headless engine call (`ai()`'s path, `aiExecArgs`). The engine is asked for a JSON array of at most `--agents` pieces, each a self-contained prompt that names the files it may touch and ends with a SUMMARY section. The first JSON array in the reply is the plan. A reply that does not parse, or a call that fails, degrades to one piece holding the whole task, and says so.

R3. Fan-out starts one herd session per piece with `herd start <engine> --agent`, named `swarm-<slug>-<n>`, in the herd `swarm` (`--herd` overrides), at most `--agents` at a time (default 4, maximum 16). Each session is waited on until it draws its prompt, then prompted exactly as `herd prompt --wait` does, so the ledger holds the piece's output.

R4. `--verify` runs one headless skeptic per piece, prompted to refute it and to default to refuted when unsure. Its verdict is attached to the piece and shown to the synthesis; it never drops a piece on its own.

R5. Synthesis is one headless call over the pieces' outputs, truncated per piece, that writes the answer the operator should read: what was done, found, unfinished or contradicted, and what to do next.

R6. Sessions are ended when the swarm is done. `--keep` leaves them for inspection and names them. The ledger is never pruned by a swarm.

R7. `--plan-only` prints the plan and starts nothing. `--json` prints the whole run as data: engine, plan, one row per piece with session, task id, state, outcome, output and verdict, and the synthesis.

R8. Exit codes follow the herd's: 0 when every piece finished and the synthesis was written, 1 otherwise.

R9. The engine, the substrate and the ledger reach the orchestration only through an injectable dependency object, so `test/swarm.test.mjs` exercises planning, throttling, degradation, verification and synthesis with fakes.

R10. `moshcode help swarm`, the README and the pit's `/help` document the verb, and the README command table is regenerated from the schema.

## Design

`src/swarm.mjs`. `parseSwarmArgs` is the flag grammar. `planPrompt`, `verifyPrompt` and `synthesisPrompt` are the three prompts, exported so their wording is testable. `parsePlan` and `parseVerdict` read the model's replies leniently (first array, first object). `throttled` is the concurrency gate. `runHeadless` is the engine call, with the engine's `stripEnv` applied so a swarm started from inside a Claude session does not inherit nested-session markers. `liveDeps` builds the real dependency object out of `herdStart`, `waitFor`, `herdPrompt` and `herdKill` with a capturing writer, and `findTask` for the ledger artifact. `runSwarm` is the four phases as data; `swarmCommand` is the CLI face.

## Open questions

- Whether the pit should offer a keyword trigger the way Claude Code does (a leading `swarm:` on a prompt line). The verb is enough to start with.
- Whether a remote member should be eligible for a piece. Nothing in the design stops it once `herd start` can target one.

## Acceptance

- `moshcode swarm "…" --plan-only` prints a numbered plan and starts nothing.
- `moshcode swarm "…" --agents 2` on a box with tmux and one installed engine ends with a synthesis, two closed tasks in the ledger, and no swarm sessions in `moshcode ps`.
- `moshcode swarm "…" --keep` ends with the sessions still in `moshcode ps`.
- `node --test test/swarm.test.mjs` passes without tmux or an engine.
