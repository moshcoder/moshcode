---
openprd: "0.2"
id: "0002"
title: Separate autonomous agent and raw engine launches
status: Accepted
authors:
  - anthony@chovy.com
created: 2026-07-13
updated: 2026-07-13
repo: https://github.com/moshcoder/moshcode
discussion:
implementation:
tags:
  - cli
  - agents
  - permissions
  - orchestration
supersedes:
superseded-by:
---

## Problem

MoshCode currently treats `/agents <engine>` as an ordinary native CLI launch.
That name implies an autonomous coding session, but the underlying engines still
pause for their normal permission or approval prompts. At the same time, users
need an explicit way to start the unmodified native CLI when they want its normal
safety model or need to supply their own flags.

## Goals

- Make `/agents <engine>` a predictable autonomous launch across every supported
  coding engine.
- Provide `/start <engine>` as an explicit raw passthrough that injects no flags.
- Preserve the existing bare `moshcode <engine>` raw behavior for compatibility.
- Make the dangerous nature of autonomous mode visible before handoff.

## Non-Goals

- Bypassing administrator policies that disable an engine's autonomous mode.
- Claiming that every engine provides identical sandbox or permission semantics.
- Applying autonomous flags to UGig, CoinPay, installers, upgrades, or moshscript.
- Parsing or rewriting user-supplied native engine arguments.

## Users

- Developers who intentionally want uninterrupted agent execution in an
  isolated or otherwise trusted workspace.
- Developers who want a memorable raw-start command for normal interactive use.
- Scripts that need the same distinction outside the MoshCode TUI.

## Requirements

- R1 [P0] Every coding-engine registry entry MUST declare the engine's current
  autonomous or auto-approval arguments.
- R2 [P0] The autonomous mappings MUST be Claude
  `--dangerously-skip-permissions`, Codex
  `--dangerously-bypass-approvals-and-sandbox`, Gemini
  `--approval-mode=yolo`, Aider `--yes-always`, and OpenCode `--auto`.
- R3 [P0] `/agents <engine> [args…]` MUST prepend the registered autonomous
  arguments and then preserve all user-supplied arguments.
- R4 [P0] `/start <engine> [args…]` MUST launch the engine with only the
  user-supplied arguments.
- R5 [P0] `moshcode agents <engine> [args…]` and
  `moshcode start <engine> [args…]` MUST provide the equivalent non-TUI paths.
- R6 [P0] Bare `moshcode <engine> [args…]` and bare engine names in the TUI MUST
  remain raw passthroughs for backward compatibility.
- R7 [P1] Agent-mode launches MUST show a warning that permission or approval
  protections are being bypassed or auto-approved.
- R8 [P1] `/agents` and `moshcode agents` with no engine MUST continue listing
  engines and their install status.
- R9 [P1] Automated tests MUST verify the registered mappings, autonomous
  argument order, and raw-start behavior for every engine.

## UX Notes

```sh
# Autonomous: MoshCode injects the engine-specific bypass/auto-approve flag.
moshcode agents claude
moshcode agents codex --model gpt-5

# Raw: MoshCode injects nothing.
moshcode start claude
moshcode start codex --sandbox workspace-write

# Backward-compatible raw shorthand.
moshcode claude
```

TUI equivalents are `/agents claude`, `/start claude`, and bare `claude`.
`/agents` remains the status list when no engine name follows it.

The mappings are intentionally not described as identical. Claude and Codex
offer explicit full-bypass flags. Gemini and Aider auto-approve confirmations.
OpenCode's `--auto` approves requests that are not explicitly denied, so deny
rules remain effective.

## Success Metrics

- Each engine receives exactly its registered autonomous arguments through the
  agent-mode path.
- Raw starts receive no MoshCode-injected engine arguments.
- Existing engine aliases, environment scrubbing, stdio, cwd, and exit behavior
  remain intact.
- The full MoshCode test suite passes.

## Risks & Open Questions

- Full-bypass modes can execute destructive or prompt-injected actions. Users
  should reserve `/agents` for isolated containers, VMs, or trusted workspaces.
- Engine flags can change between releases. Their own installers and help output
  remain authoritative, and the registry mappings need maintenance when upstream
  CLIs rename a mode.
