---
openprd: "0.2"
id: "0003"
title: Install MCP servers and skills across every engine at once
status: Accepted
authors:
  - anthony@chovy.com
created: 2026-07-13
updated: 2026-07-13
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/mcp.mjs, src/skills.mjs, src/integrations.mjs
tags:
  - cli
  - mcp
  - skills
  - integrations
  - orchestration
supersedes:
superseded-by:
---

## Problem

Every coding engine MoshCode conducts (Claude, Gemini, Codex, OpenCode, Aider)
maintains its own registry of MCP (Model Context Protocol) servers, each with a
different config location, format, and `mcp add` flag surface. A user who wants
the same MCP server available in all of their agents has to run four different
commands and remember four different flag dialects. The same fragmentation is
starting to appear for Agent Skills. MoshCode already conducts these CLIs' native
command lines (see [[0001-wrap-ugig-and-coinpay-clis]]); it is the natural place
to register a server or skill *once* and fan it out to every engine that can use
it.

## Goals

- Register an MCP server across every installed MCP-capable engine with one
  command, defaulting to global (user) scope.
- Translate a single canonical server definition into each engine's native
  `mcp add` invocation, rather than hand-writing four config formats.
- Report per engine what happened: added, skipped (can't express it), failed, or
  not installed — and flag servers that still need per-engine authentication.
- Offer the equivalent one-shot install for Agent Skills to the engines that have
  a skills primitive.
- Never silently drop an engine: an engine that cannot express a requested server
  MUST be reported, not omitted.

## Non-Goals

- Implementing MCP or skills for engines that lack the primitive (Aider has
  neither; Codex/OpenCode have no skills concept).
- Performing per-engine OAuth/login flows on the user's behalf (MoshCode registers
  the server; the user authenticates in each engine).
- Editing engine config files directly — MoshCode drives each engine's own
  `mcp add` / `skills install` so the engine owns its config format.
- Managing MCP server processes/runtime, health, or tool routing.
- Reconciling or de-duplicating servers an engine already has.

## Users

- Developers who run more than one coding agent and want the same MCP tools
  (Sentry, GitHub, a company internal server) available in all of them.
- Teams standardizing a set of skills/servers across engines.
- Scripts that need the same fan-out outside the MoshCode TUI.

## Requirements

- R1 [P0] A new command MUST register an MCP server across every installed
  MCP-capable engine: `/mcp install <commandOrUrl>` and
  `/mcp add <name> <commandOrUrl> [args…]` in the TUI, and `moshcode mcp …`
  outside it.
- R2 [P0] The MCP-capable engine set MUST be Claude, Gemini, Codex, and OpenCode.
  Aider MUST be treated as having no MCP support.
- R3 [P0] A canonical server definition — name, target (URL or stdio command +
  args), transport, env vars, and headers — MUST be translated per engine into
  its native `mcp add` argv:
  - Claude: `claude mcp add -s user [-t <transport>] [-e K=V…] [-H "K: V"…] <name> <commandOrUrl> [args…]`
  - Gemini: `gemini mcp add -s user [-t <transport>] [-e K=V…] [-H "K: V"…] <name> <commandOrUrl> [args…]`
  - Codex: `codex mcp add <name> (--url <url> | -- <command> [args…]) [--env K=V…]`
  - OpenCode: `opencode mcp add <name> --url <url> [--env K=V…] [--header K=V…]`
- R4 [P0] Registration MUST default to global/user scope on every engine
  (`-s user` where the engine offers it; the engine's user-level config
  otherwise).
- R5 [P0] `/mcp install <url>` MUST accept a bare remote URL, derive a sane
  default server name from its host, and default the transport to `http`.
  An explicit `--name` MUST override the derived name.
- R6 [P0] When an engine cannot express the requested server (e.g. OpenCode with
  a stdio command, or Codex with literal headers), MoshCode MUST skip that engine
  with a stated reason and still register the others.
- R7 [P0] Header syntax MUST be normalized per engine: Claude/Gemini `"Key: Value"`,
  OpenCode `Key=Value`. Codex, which supports only a bearer-token env var, MUST be
  skipped-with-reason when literal headers are supplied.
- R8 [P1] A `/skill install <git-url|path>` command MUST fan a skill out to every
  installed engine that has a skills primitive: Gemini via
  `gemini skills install <source> --scope user`, and Claude by cloning the source
  into `~/.claude/skills/<name>`. Engines without a skills primitive MUST be
  reported as skipped.
- R9 [P1] Every fan-out MUST print a per-engine summary (added / skipped+reason /
  failed / not-installed) and MUST call out any server that still requires
  authentication in a given engine.
- R10 [P1] A removal path (`/mcp remove <name>`, `moshcode mcp remove <name>`)
  MUST fan the corresponding native `mcp remove` out to the same engines.
- R11 [P1] `/mcp` and `/skill` with no arguments MUST list the target engines and
  their MCP/skills support + install status.
- R12 [P1] The registration plan (engine → argv or skip-reason) MUST be a pure,
  unit-tested function, mirroring the existing upgrade-plan tests, so adapters are
  verified without spawning real engines.

## UX Notes

```sh
# Remote HTTP server, global, everywhere that supports MCP:
moshcode mcp install https://mcp.sentry.dev/mcp
#   ✓ claude    added (-s user -t http)
#   ✓ gemini    added
#   ✓ codex     added (--url)
#   ✓ opencode  added (--url)
#   · aider      skipped — no MCP support

# Explicit name + stdio command server:
moshcode mcp add my-tools -- npx -y my-mcp-server
#   ✓ claude    added
#   ✓ gemini    added
#   ✓ codex     added
#   · opencode  skipped — CLI adds only remote (--url) servers non-interactively

# A skill, to the engines that have skills:
moshcode skill install https://github.com/acme/some-skill
#   ✓ claude    cloned into ~/.claude/skills/some-skill
#   ✓ gemini    installed (--scope user)
#   · codex/opencode/aider  skipped — no skills primitive
```

TUI equivalents are `/mcp install …`, `/mcp add …`, `/mcp remove …`, and
`/skill install …`. Bare `/mcp` and `/skill` print the support matrix.

The per-engine translation is intentionally not uniform: Claude and Gemini share
a `mcp add <name> <commandOrUrl>` shape with `-t`/`-H`; Codex distinguishes
remote from stdio with `--url` vs `-- command` and only carries a bearer-token env
var; OpenCode registers remote servers by `--url` and uses `Key=Value` headers.

## Success Metrics

- One `moshcode mcp install <url>` registers the server, at user scope, in every
  installed MCP-capable engine, with a per-engine result line.
- No engine is silently omitted: unsupported combinations are reported with a
  reason.
- The plan function returns the correct native argv (or skip reason) for each
  engine and combination, verified by tests without spawning engines.
- The full MoshCode test suite passes.

## Risks & Open Questions

- Engine `mcp add` flags can change between releases; their own `--help` remains
  authoritative and the adapters need maintenance when a CLI renames a flag.
- Secrets (env values, `Authorization` headers, bearer env-var names) flow through
  MoshCode into each engine's config; MoshCode MUST NOT log their values.
- Claude skill install by `git clone` assumes the source repo is a skill (a
  `SKILL.md` at the root or a known sub-path); non-skill repos are out of scope
  for v1.
- Should MoshCode detect and skip servers an engine already has, or let the native
  `mcp add` error surface? v1 surfaces the native result; de-dup is deferred.
- OAuth-gated servers register but remain unauthenticated until the user runs the
  engine's own auth (`opencode mcp auth`, `codex mcp login`); MoshCode only points
  this out.
