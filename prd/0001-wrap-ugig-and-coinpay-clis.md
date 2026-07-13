---
openprd: "0.2"
id: "0001"
title: Wrap the UGig and CoinPay CLIs
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
  - ugig
  - coinpay
  - orchestration
supersedes:
superseded-by:
---

## Problem

MoshCode already installs and delegates to coding engines, but users and coding
agents must leave its workflow to discover paid work through UGig or operate the
CoinPay payment rail. Both products already ship broad native CLIs. Rebuilding
their APIs in MoshCode would duplicate authentication, command semantics, and
release cadence; omitting them leaves a gap between finding work, doing it, and
getting paid.

## Goals

- Make the native `ugig` and `coinpay` CLIs installable and discoverable through
  MoshCode.
- Provide transparent top-level and TUI delegation without changing native CLI
  behavior.
- Include installed external tools in MoshCode's existing upgrade workflow.
- Keep ownership clear: UGig owns marketplace state, CoinPay owns payment state,
  and MoshCode only conducts the installed CLIs.

## Non-Goals

- Reimplementing UGig or CoinPay API clients or command trees in MoshCode.
- Adding composed `gigs`, invoice, escrow, or settlement workflows in this
  release.
- Adding irreversible payment operations to moshscript.
- Normalizing or parsing either tool's human-readable or JSON output.
- Managing UGig or CoinPay credentials on MoshCode's behalf.

## Users

- Developers using MoshCode who want to find and manage UGig work from the same
  terminal workflow.
- Coding agents that need machine-readable UGig output or direct CoinPay access.
- Operators who want one installation and upgrade surface for their coding
  engines and adjacent workflow tools.

## Requirements

- R1 [P0] MoshCode MUST define UGig and CoinPay in a `TOOLS` registry separate
  from the coding-engine registry. Each entry MUST declare its executable and
  official package installation/upgrade command.
- R2 [P0] `moshcode tools` MUST list both tools and report whether each native
  executable is on `PATH`.
- R3 [P0] `moshcode install ugig` and `moshcode install coinpay` MUST install the
  official npm packages; existing engine installation behavior MUST remain
  compatible.
- R4 [P0] `moshcode ugig [args…]` and `moshcode coinpay [args…]` MUST pass
  arguments, stdin, stdout, stderr, the working directory, and environment
  through unchanged and MUST propagate the native process exit result.
- R5 [P0] The interactive shell MUST accept `/ugig [args…]` and
  `/coinpay [args…]`, hand terminal control to the native CLI, and return to the
  MoshCode prompt when it exits.
- R6 [P0] `moshcode upgrade` MUST update installed tools as well as installed
  engines. `upgrade tools`, `upgrade ugig`, and `upgrade coinpay` MUST be valid
  narrower targets.
- R7 [P1] Missing executables and unknown install/upgrade targets MUST produce
  actionable errors that identify the correct MoshCode command.
- R8 [P1] Help text and the README MUST document installation, status,
  passthrough, authentication ownership, and upgrade behavior.
- R9 [P1] Automated tests MUST cover tool resolution and transparent
  passthrough, including arguments, standard streams, and non-zero exit codes.

## UX Notes

```sh
moshcode tools
moshcode install ugig
moshcode install coinpay

moshcode ugig --json gigs list
moshcode coinpay wallet balance

moshcode upgrade tools
```

`moshcode tools` distinguishes adjacent workflow tools from `/agents` and
`moshcode engines`. The wrappers do not insert banners or status messages into
native stdout because that would corrupt JSON pipelines. Native authentication
continues to use each tool's config files and environment variables.

CoinPay currently requires Node.js 20 or newer while MoshCode itself supports
Node.js 18. Its npm installer remains the authority for enforcing that package
requirement; MoshCode documents it rather than changing its own runtime floor.

## Success Metrics

- All P0 requirements have automated coverage or direct CLI verification.
- Native `ugig` and `coinpay` help/output can be invoked through MoshCode without
  MoshCode text appearing on stdout.
- A native non-zero exit code is observed unchanged by a calling shell or agent.
- Existing MoshCode tests and coding-engine commands continue to pass.

## Risks & Open Questions

- CoinPay's machine-readable output is not yet uniform across commands. MoshCode
  will preserve it verbatim; CoinPay should standardize JSON-only stdout and
  diagnostics on stderr before agents depend on every command in pipelines.
- Composed gig-to-invoice or escrow flows may be valuable later, but should be
  based on observed usage and require explicit confirmation for irreversible
  payment actions.
