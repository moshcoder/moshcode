---
openprd: "0.3"
id: "0021"
title: "Work — a queue, a verifier, an inbox"
status: Draft
authors:
  - anthony@profullstack.com
created: 2026-10-17
updated: 2026-10-17
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/work.mjs, src/work-cli.mjs
tags:
  - agents
  - scale
  - openfleet
supersedes:
superseded-by:
---

## Problem

The people running tens of thousands of agents on math proofs are not managing tens of thousands of agents. The proof checker manages them: Lean says yes or no to every attempt, cheaply and without being argued with, so a wrong attempt is discarded and nobody reads it. The human writes the goal, breaks it down, sets the budget, and looks at two things: what passed, and what stays stuck.

moshcode's agent surfaces are built the other way round. The herd is a pane per agent, the swarm (PRD 0015) is a planned handful of panes, W3BS fleet screens are desktops to watch. All of them assume a person looks at each agent, which caps a fleet at the number of panes a person can read: ten, maybe twenty. OpenFleet (PRD 0016) already gives every agent a record, a ledger line and a ceiling; what is missing is everything that lets the person stop watching.

## Goals

- A task always carries its own verifier: a shell command whose exit 0 is the only definition of done. No verifier, no task.
- Workers are headless processes, not panes. One moshcode drives as many as the box and the fleet ceiling allow; several moshcodes on one queue split it.
- Every attempt is isolated (its own git worktree at a fixed base) so workers never collide, and its result is a patch, not a dirty checkout.
- Failure is cheap and automatic: a failed attempt goes back to the queue with the verifier's output in its next prompt; only after the attempt budget is spent does it reach a person.
- The person sees numbers (pending, working, done, inbox, pass rate, attempts per pass, done per hour) and an inbox. Never a wall of transcripts.
- The same ask is one task: done work is never paid for twice.
- Every run is an OpenFleet swarm, so `fleet tree`, `fleet log` and the ceiling's `fan_out` already apply.
- The first workload is one that already has a verifier: failing test files.

## Non-Goals

- Planning. The queue is filled by a person, a generator (`from-tests`) or a script; splitting a goal into tasks is the swarm's planner or the sysop's job. A later `work plan` may call the swarm planner and require a verify per piece.
- Tasks without a mechanical verifier. Work that only a person can judge is what the inbox is for; it is not what the queue is for.
- A network queue. The queue is a directory; a shared filesystem is the multi-host story for now.
- Spend accounting per attempt. `moshcode cost` already reads the engines' logs; folding it into status is a follow-up.

## Design

`moshcode work <verb>`:

| verb | does |
|---|---|
| `add <queue> "<prompt>" --verify "<cmd>"` | one task, or `--file` of JSON lines |
| `from-tests <queue>` | each test file run alone; one task per failing file, verify = that file, the failure as the hint |
| `run <queue> -n <workers>` | drain it |
| `status`, `inbox`, `show` | the numbers; what needs a person; one task's attempts |
| `retry`, `drop`, `apply`, `recover` | inbox back to the queue; remove; land patches; put back dead claims |

**Files.** `$MOSHCODE_WORK_DIR/<queue>/{pending,claimed,done,inbox}/<id>.json`, plus `results/<id>.patch`, `runs/<id>-<n>.log` and `trees/`. The id is the first 12 hex of sha256 over prompt, verify and cwd.

**Claim.** `rename(pending/<id>, claimed/<id>)`. Atomic on one filesystem, so the claim needs no lock server. A claim records worker, host, pid and time; `run` puts back same-host claims whose pid is gone, `recover --stale` puts back old ones from anywhere.

**Attempt.** `git worktree add --detach` at the base commit read once per run, `node_modules` linked in from the checkout, optional `--setup`. On the first attempt verify runs once before the engine: a task that already passes is done for one verify and no tokens. The engine runs its headless argv plus its autonomous flags (`claude -p … --dangerously-skip-permissions`, `codex exec … --dangerously-bypass-approvals-and-sandbox`) with `OPENFLEET_*`, `MOSHCODE_WORK_QUEUE` and `MOSHCODE_WORK_TASK`. Then verify. Pass: `git add -A` (linked paths excluded) and `git diff --cached --binary <base>` become the patch, the tree is removed. Fail: back to pending with the attempt (exits, verify tail, summary) appended, or the inbox with the tree kept once `--max-attempts` is spent. Setup failing goes to the inbox at once.

**Apply.** Oldest first, `git apply --check` then `git apply`; a patch that no longer applies goes to the inbox, and retry runs it against the new HEAD.

**OpenFleet.** One swarm per run, id `<queue>-<nonce>-<HHMM>`, checked against the ceiling (depth, `fan_out` = workers, hosts, approvals) before anything starts, `ceiling.refuse` when it does not fit. Each engine attempt is a member with a record, `member.start`, and `member.end` carrying `verdict: { verify, exit, passed }`. One `swarm.end` with the tallies.

## The pilot

moshcode's own suite has ~140 tests that fail locally on main and pass in CI. `moshcode work from-tests local-fails` then `moshcode work run local-fails -n 50`, and the measures that decide whether this scales: pass rate, attempts per pass, done per hour, inbox size, and spend per verified fix from `moshcode cost`.

## Later

- The inbox in the pit and the PWA, so the one surface a person needs is on their phone.
- `work plan "<goal>"`: the swarm planner, with a verify required per piece.
- Generators beyond tests: typecheck errors, lint, a live URL that must return 200, Lean.
- A cheap engine for breadth and an expensive one for tasks that reached the inbox once (`--engine` per attempt number).
- Per-attempt spend in status, and a fleet budget that stops `run`.
