---
openprd: "0.3"
id: "0016"
title: "OpenFleet: the record a swarm leaves behind, and the fleet verb that reads it"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-09-13
updated: 2026-09-13
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/openfleet.mjs, src/swarm.mjs, src/fleet-cli.mjs
tags:
  - herd
  - swarm
  - openfleet
  - sysop
supersedes:
superseded-by:
---

## Problem

On 2026-09-13 a Claude Code job asked `moshcode swarm` to split a task across two agents. One piece became a Claude Code job, the other a tmux pane. Neither could say who had started it, why, who its sibling was, what it was allowed to touch, or which human had approved any of it. The herd's manifest said `agent: false` about a pane running `claude --dangerously-skip-permissions`. The human could not see the tree, stop the pair as one unit, or cap what they could do. The relationship existed in a process tree and in a prompt the planner wrote, and nowhere else.

OpenFleet (logicsrc.com/docs/openfleet, 0.1) is the record and the ledger that fix this: one JSON file per member saying where it sits, and one append-only ledger per fleet per host saying what happened, who did it, and what was refused. This PRD is moshcode's side of it: what `moshcode swarm` writes, what a pane is told, and the sysop tool that reads it back.

## Goals

- A swarm's members are recorded before they start, in the files every OpenFleet tool reads, so `moshcode fleet tree`, `logicsrc fleet tree` and Claude Code's own view show one tree.
- What a member may write is data, not prose: the planner's `files` per piece becomes `piece.owns`.
- The manifest tells the truth about approvals. A pane started with the engine's bypass flag says so, and a bypass the ceiling forbids is refused and written down.
- The sysop can see the tree, stop a swarm as one unit, cap what runs, and read what happened, with five verbs over `$OPENFLEET_HOME`.
- Nothing about this needs a network, a daemon, or the other tools to be installed. Files on one host, under one account.

## Non-Goals

- Orchestration changes. The four phases of PRD 0015 stay as they are; this records them.
- A permission system. `piece.owns` and `approvals` are carried and honoured by engines; the ledger makes what they did checkable.
- Cross-host ledgers. A fleet spanning hosts merges per-host files by hand in 0.1.
- Stopping engines moshcode did not start. `moshcode fleet stop` ends its own panes, a Claude Code job through `claude stop`, a `claude -p` through its pid, and reports anything else.

## Users

- The human who runs `moshcode swarm` and wants to know, afterwards or during, what it started and under what terms.
- An agent that runs `moshcode swarm` from inside a member, whose swarm must be visible as its own and stoppable by its sysop.
- Another sysop tool reading the same files.

## Requirements

- R1 [P0] `moshcode swarm` mints the swarm id, `<slug of the task, at most 23 chars>-<HHMM UTC>`, before the plan call. Member ids are `<swarm>-<n>` and are also the pane names. `--json` carries `swarm` and `fleet`.
- R2 [P0] The planner, the skeptic and the synthesis run without `OPENFLEET_SWARM`: the swarm's `swarm.spawn` does not exist when the planner runs, and a `claude -p` that found the id would join a swarm that has no line.
- R3 [P0] The planner's reply is `[{ "title", "prompt", "files" }]`. `files`, when given, becomes the member's `piece.owns` in its record, in `swarm.spawn` and in `member.start`.
- R4 [P0] The effective ceiling is checked before anything is written: the fleet's, merged with the parent's chain, narrowed by `fan_out` from `--agents` and `until` from `--timeout`. `depth`, `fan_out`, `hosts` and `until` refuse the spawn once; `approvals` refuses each member. A refusal appends `ceiling.refuse`, starts nothing, writes no record, and reports the pieces as `outcome: "refused"`.
- R5 [P0] `swarm.spawn` is written before the first member starts, with the task, the narrowed keys, and one `{ member, title, owns }` per piece. `by` is the member moshcode runs inside, or `sysop` by hand. `parent_swarm` is that member's own swarm when it has one.
- R6 [P0] One unclaimed record per member, written before its session starts and never rewritten: `openfleet`, `fleet`, `sysop`, `member`, `parent`, `swarm`, `task`, `piece`, `depth`, `engine` (`moshcode/<engine>`), `session` (the pane name, which is the tmux target), `host`, `cwd`, `started`, `approvals`, `ceiling`. Files are 0600, directories 0700.
- R7 [P0] The pane's environment carries `OPENFLEET_HOME`, `OPENFLEET_RECORD`, `OPENFLEET_FLEET`, `OPENFLEET_MEMBER` and `OPENFLEET_SWARM` beside `MOSHCODE_HERD_NAME` and `MOSHCODE_HERD_DIR`, on the same `env` prefix, so they survive the engine's strip of `ANTHROPIC_API_KEY` and `CLAUDE_CODE_SESSION_ID`. `herd start --env KEY=VALUE` is the flag; `startSession` takes `extraEnv`.
- R8 [P0] When the prompt is submitted and the ledger holds no `member.start` for the member, moshcode writes one on the pane's behalf, `by` the starter, at the submit moment. A claude pane with hooks claims its own record first and moshcode writes nothing.
- R9 [P0] The manifest says `approvals: bypass` when the engine's bypass flags are present, whether from `--agent` or as plain args; `herd start --json` and its warning agree. `moshcode ps` groups rows by fleet then swarm and marks bypass members.
- R10 [P0] At the end, for every member with a record and no real end line: `member.end` with state from the herd outcome (matched is done, timeout is timeout, gone is lost, anything else failed) and `summary` from the SUMMARY: section or the tail of what it printed. Then one `swarm.end` if none exists: `done` when every member ended done, else the first of failed, stopped, budget, timeout among them; `summary` the synthesis; `verdict` the `--verify` verdicts as `[{ member, refuted, reason }]`. Then the kills, in a `finally`, so a crash still ends the panes.
- R11 [P0] `--keep` writes the records, `swarm.spawn` and `member.start`, no end lines, no kills, and names the swarm so `moshcode fleet stop <swarm>` can end it later.
- R12 [P0] `moshcode fleet open|cap|tree|stop|log` over `$OPENFLEET_HOME`, every verb with `--json`. `open` and `cap` refuse with exit 4 when `OPENFLEET_MEMBER` is set; `stop` refuses anything outside what that member spawned. `tree` joins the herd roster for liveness, draws a herd session with no record as a root of the implicit fleet, and writes `member.end` lost for a claimed moshcode member the roster no longer lists. `stop` ends nested swarms first, each with its own `swarm.end`, then the members through their engines, then the target's `swarm.end`, never two for one swarm. `cap` stops members already above the new ceiling.
- R13 [P1] Everything above is testable without tmux, a model, or a real home: the fleet's files live under a mkdtemp `OPENFLEET_HOME`, the roster and the kills are injectable.
- R14 [P1] `moshcode help fleet`, the README, the pit's `/fleet` and moshscript's `fleet(...)` document the verb; the README table is regenerated from the schema.

## UX Notes

- A refused swarm prints why and exits 1. The refusal is in the ledger, which is the point: the sysop finds out what an agent tried.
- `moshcode fleet tree` draws the shape the spec's landing page shows: the fleet line with its ceiling, root members, each member's swarms, each swarm's members, with `[bypass]`, `owns`, `[orphan]`, `[roster]` marks and spend where an engine counted.
- `moshcode fleet log` is one line per event in time order, or `--json` for one object per line as the ledger holds them.
- Making the manifest truthful changes one thing a person might notice: `herd serve` withholds bypass sessions unless `--expose-autonomous`, and swarm panes now count as such.

## Success Metrics

- After `moshcode swarm`, `moshcode fleet tree` shows the swarm under the member that started it, with every piece, and `moshcode fleet log --swarm <id>` reads spawn, starts, ends, end.
- A `moshcode swarm` run inside a member whose ceiling says native ends with `ceiling.refuse` in the ledger and no pane started.
- `moshcode fleet stop <swarm>` on a kept swarm ends every pane and leaves one `swarm.end`.

## Risks & Open Questions

- The `member.start` a starter writes at submit time can race a claude pane's own hook claiming the record; both check the ledger first, and a reader takes the first line, so a duplicate is noise rather than a wrong tree.
- The pane's `session` equals its member id, so a claude session that claims the record keeps the tmux target as its handle and its own session id appears nowhere; the spec allows this and the tmux target is what a sysop tool stops.
- `until` is one `--timeout` from the spawn; every piece is bounded by that wait and the plan is capped at `--agents`, so one batch is the whole swarm. A later `--agents` smaller than the plan would need the batch arithmetic the code already carries.
- A `moshcode swarm` run inside a member at depth 1 of the implicit fleet is refused on depth. Correct under the spec, and noisy for a tool that spawns many; `moshcode fleet open --depth 2` is the answer.
