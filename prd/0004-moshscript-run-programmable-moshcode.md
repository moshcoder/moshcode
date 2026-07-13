---
openprd: "0.2"
id: "0004"
title: moshscript — a scriptable /run for driving all of moshcode programmatically
status: Accepted
authors:
  - anthony@chovy.com
created: 2026-07-13
updated: 2026-07-13
repo: https://github.com/moshcoder/moshcode
discussion:
implementation: src/runtime.mjs, src/registry.mjs, src/commands.mjs, src/cli.mjs, src/tui.mjs, bin/moshcode.mjs
tags:
  - moshscript
  - cli
  - scripting
  - automation
  - dsl
supersedes:
superseded-by:
---

## Problem

moshcode already ships a `/run <file.mosh>` command and a tiny moshscript
runner (`src/interpreter.mjs` + `src/commands.mjs`), but the language is a toy.
Its grammar is one construct — `while (alive) { … }` — and its vocabulary is
seven cosmetic builtins (`code()`, `mosh()`, `notify()`, `repeat()`, `say()`,
`sleep()`, `stop()`). None of them actually *do* anything moshcode does: a
script cannot launch an engine, install a tool, publish a PRD, or fan an MCP
server across engines. Everything moshcode is good at — conducting Claude,
Codex, Gemini, OpenCode and Aider, and the ugig/coinpay/c0mpute workflow CLIs
(see [[0001-wrap-ugig-and-coinpay-clis]], [[0002-separate-agent-and-raw-engine-launches]],
[[0003-cross-engine-mcp-and-skill-installation]]) — is only reachable by a human
typing at the mosh pit prompt.

The pitch, in the user's words: *"very simple scripting language (although
secretly all js is legal), but very basic commands like `code(); mosh();
notify(); repeat();` — we can basically do everything moshcode cli supports but
programmatically."* Two things have to become true that aren't today:

1. **moshscript must be able to drive moshcode's real capabilities**, not just
   print flavor text.
2. **moshscript must accept real JavaScript** so that "very simple" scripts keep
   working while power users can reach for loops, conditionals, variables, and
   expressions without hitting a wall in the hand-rolled tokenizer
   (`interpreter.mjs` throws on any character outside `(){};,` + string/number/
   ident).

## Goals

- Evolve `/run <file.mosh>` from a cosmetic loop into a programmable interface to
  the whole moshcode CLI: any verb reachable from the pit or `bin/moshcode.mjs`
  is callable as a moshscript function.
- Keep the "no bugs, only features" starter script — `while (alive) { code();
  mosh(); notify(); repeat(); }` — running unchanged. The simple surface is the
  brand; it must not regress.
- Make "secretly all JS is legal" real: a `.mosh` file is executed as JavaScript
  with the moshscript command vocabulary injected as globals, so `if`, `for`,
  `const`, template strings, `await`, and arithmetic all Just Work.
- Give scripts programmatic access to engines (`agents`, `start`, `install`),
  workflow tools (`ugig`, `coinpay`, `c0mpute`), cross-engine fan-out (`mcp`,
  `skill`), publishing (`prd`), and system verbs (`upgrade`, `shell`, `pwd`).
- Preserve `--dry-run` as a first-class, honored mode: a dry run narrates every
  action (spawn argv, network target) without executing it.
- Keep it lean: zero new runtime dependencies, still Node 18+ ESM.

## Non-Goals

- Sandboxing untrusted scripts. A `.mosh` file runs with the user's full
  privileges by design (it can spawn engines and shell out); moshscript is an
  automation tool for its author, not a safe host for third-party code.
- A bespoke parser/type-checker for the "simple" dialect. We reach JS-legality by
  executing as JS, not by growing the custom tokenizer into a language.
- Reimplementing engine/tool behavior. moshscript verbs call the *same* exported
  functions the TUI and CLI call; it adds no new capability, only a new caller.
- A package/module system, imports between `.mosh` files, or a stdlib beyond the
  moshcode command vocabulary. (Deferred; see Open Questions.)
- Long-lived daemon/scheduler semantics. `/loop`-style scheduling stays a harness
  concern; moshscript runs to completion.

## Users

- **The starter user** who copies the `while (alive) { … }` snippet from the
  README, runs `/run alive.mosh`, and gets the metal feedback loop. They never
  learn it's JavaScript.
- **The automator** who scripts a real chore: "install claude + codex, register
  our Sentry MCP server across both, then open an agent session" as a handful of
  `.mosh` lines committed to a repo.
- **CI / cron** invoking `moshcode run pipeline.mosh --dry-run` in a check, and
  `moshcode run pipeline.mosh` on the runner, with the same file.
- **Skill/PRD authors** who want `prd("idea")` or a fan-out callable from a
  script rather than retyped interactively.

## Requirements

- R1 [P0] A `.mosh` file MUST execute as JavaScript. The existing starter script
  (`while (alive) { code(); mosh(); notify(); repeat(); }`) MUST run unchanged
  and produce equivalent output. The custom `interpreter.mjs` grammar is retired
  as the execution path (kept only if needed as a compatibility shim; see R11).
- R2 [P0] The moshscript command vocabulary MUST be injected as callable globals
  into the script scope, so `code()`, `mosh()`, `notify(...)`, etc. resolve
  without imports. `alive` MUST be a mutable global initialized to `true`, and
  `stop()` MUST set it `false` so `while (alive)` terminates.
- R3 [P0] Execution MUST be bounded. A `--max <n>` iteration/step budget MUST be
  honored to prevent a runaway `while (alive)` from hanging, and the two
  entrypoints MUST agree on the default (today CLI `run` defaults `max=3` while
  TUI `runFile` hard-codes `100000` — this inconsistency MUST be resolved to a
  single documented default).
- R4 [P0] CLI verbs MUST be implemented by shelling out to the moshcode CLI
  itself — `agents("claude")` runs `moshcode agents claude`, `install("codex")`
  runs `moshcode install codex` — NOT by reaching into `src/engines.mjs` /
  internals. There is one implementation of every capability (the CLI) and
  moshscript is a second caller of it. This shell-out MUST be synchronous and
  blocking (spawnSync with inherited stdio) so that (a) the simple no-`await`
  style runs verbs in order — `install("claude"); agents("claude");` — and
  (b) interactive engine sessions own the real terminal and hand control back to
  the script on exit. The engine/agent verbs are: `agents(engine, ...args)`,
  `start(engine, ...args)`, `install(target)`.
- R5 [P0] The workflow-tool verbs MUST likewise shell out: `ugig(...args)`,
  `coinpay(...args)`, `c0mpute(...args)` → `moshcode ugig …` etc., with
  byte-transparent stdio so JSON pipelines survive.
- R6 [P0] The fan-out, publishing, and system verbs MUST also shell out:
  `mcp(...args)`, `skill(...args)`, `prd(idea?)`, `upgrade(...targets)`,
  `pwd()`. Local moshscript-only verbs with no CLI equivalent
  (`mosh`, `code`, `say`, `notify`, `sleep`, `stop`, `repeat`) are implemented
  in-process; `mosh()` is the reference example of a local verb.
- R7 [P0] `--dry-run` MUST be honored by every side-effecting verb: no engine
  spawns, no installs, no network POSTs, no PRD writes. Each MUST instead narrate
  what it *would* do (the resolved argv or request target). `notify()` and
  `mosh()`'s browser-open already gate on `ctx.dryRun`; all new verbs MUST too.
- R8 [P0] A verb that fails (missing engine, non-zero child exit, network error)
  MUST surface a clear, metal-toned error and MUST NOT crash the interpreter mid
  script unless the script chose to let it throw; a documented convention (e.g.
  verbs resolve to a `{ ok, ... }`-style result and only throw on truly fatal
  misuse) MUST be specified so scripts can branch on outcomes.
- R9 [P1] The command vocabulary MUST remain open for extension: a script (or a
  host embedding moshscript) MUST be able to register additional verbs, matching
  today's documented `ctx.commands[name] = fn` seam.
- R10 [P1] `moshcode commands` MUST list the full, current vocabulary (engine,
  tool, fan-out, system, and flavor verbs) with one-line descriptions, and the
  README + `/help` MUST reflect that `.mosh` is JS-legal.
- R11 [P1] Backward compatibility: any `.mosh` that ran under the old
  tokenizer MUST still run (the old grammar is a strict subset of JS, so
  executing as JS should suffice; if any construct differs, a shim MUST cover
  it). Existing tests (`interpreter.test.mjs`, `commands.test.mjs`,
  `run-options.test.mjs`) MUST pass or be migrated with equivalent coverage.
- R12 [P1] The verb→argv mapping for each engine/tool MUST be a pure, unit-tested
  function (mirroring the MCP plan tests from
  [[0003-cross-engine-mcp-and-skill-installation]]), so `agents("claude")` and
  friends are verified without spawning real engines.
- R13 [P2] Ergonomics: a `.mosh` file MAY use `await` at top level (the runner
  executes in an async context) and MAY read `argv`/env for parameterization, so
  the same script can be reused across targets.
- R14 [P1] moshscript files MUST be directly executable like shell scripts. A
  leading shebang line (`#!…`) MUST be ignored by the runner (stripped before
  execution, exactly as `sh`/`node` ignore their own shebang), so a file starting
  with `#!/usr/bin/env moshscript` still parses. moshcode MUST provide a
  `moshscript` executable on PATH — a thin alias for `moshcode run` — so that
  `#!/usr/bin/env moshscript` resolves, a `chmod +x script.mosh` file runs as
  `./script.mosh`, and any positional args after the file reach the script (see
  R13's `argv`). The `moshscript` bin and its install/PATH wiring MUST match how
  the `moshcode` bin is already published (`bin` map in `package.json` +
  `install.sh`).
- R15 [P1] Human-in-the-loop, two verbs:
  - `notify(msg)` — fire-and-forget. Pings the operator across their configured
    channels (email / SMS / Telegram / Slack / any webhook, fanned out by
    moshcoding.com) and surfaces an approval link `app.moshcode.sh/approve/:id`.
    Returns `{ id, url }` so the script can hand the link off. Non-blocking.
  - `ask(prompt)` — the blocking gate. Delivers the same ping + link, then
    BLOCKS until the operator opens `app.moshcode.sh/approve/:id`, reads the context,
    types instructions, and hits submit; resolves with their text (or null on
    timeout). This is what lets an unattended `while (alive)` loop pause for a
    human and resume from the reply. `ask()` awaits a network long-poll, so it
    is used with `await`.
  Client contract (in this repo): create id → deliver `{ message, approval:{id,url} }`
  → long-poll `GET {API}/api/approvals/:id` until `{ status:"submitted", response }`.
  The `app.moshcode.sh/approve/:id` page, the approvals inbox it submits to,
  channel fan-out, auth, and billing are a SEPARATE approvals web app
  (app.moshcode.sh) — OUT OF SCOPE for this PRD. The client degrades gracefully
  (prints the link; the poll simply never resolves) until that server ships.
- R16 [P1] `run(file, ...args)` MUST compose scripts: a `.mosh` file can include
  another by calling `run("other.mosh")`, which is exactly `moshcode run other.mosh`.
  Because CLI verbs block (spawnSync), includes execute in order and finish before
  the caller continues. This gives moshscript an include/compose system for free —
  developers factor setup/teardown into reusable `.mosh` files. (Recursion/cycle
  protection is a developer concern for v1; `--max` does not bound include depth.)

## UX Notes

The simple surface — unchanged, still the README hero:

```js
// moshscript toolkit
while (alive) {
  code();
  mosh();
  notify();
  repeat();
} // no bugs, only features
```

The secret that it's all JS — now legal, no new syntax to learn:

```js
// deploy-agents.mosh — real work, still reads like the toy
const engines = ["claude", "codex"];
for (const e of engines) {
  install(e);                 // idempotent: installs if missing
}
mcp("install", "https://mcp.sentry.dev/mcp");   // fan out across engines
say(`ready to mosh with ${engines.length} engines 🤘`);
agents("claude");             // drop into an autonomous session
```

Invocation — unchanged, plus a shebang path so `.mosh` files run themselves:

```sh
moshcode run deploy-agents.mosh            # do it
moshcode run deploy-agents.mosh --dry-run  # narrate the argv, touch nothing
moshcode run alive.mosh --max 3            # bounded metal loop
```

```js
#!/usr/bin/env moshscript
// deploy-agents.mosh — chmod +x it and run it like any shell script
install("claude");
agents("claude");
```

```sh
chmod +x deploy-agents.mosh
./deploy-agents.mosh                        # shebang → `moshscript` → `moshcode run`
./deploy-agents.mosh --dry-run staging      # args after the file reach the script
```

The leading `#!…` line is stripped before execution (like `sh`/`node`), so it
never confuses the parser.

Dry-run output narrates instead of acting:

```
🎸 moshcode — running moshscript (dry run)
  ⌨  install(claude)  → would run: npm i -g @anthropic-ai/claude-code
  🤘 mcp(install …)    → would fan out to claude, codex (2 engines)
  💬 ready to mosh with 2 engines 🤘
  🎤 agents(claude)    → would launch: claude --dangerously-skip-permissions
✓ no bugs, only features. 🤘
```

Voice stays irreverent-metal throughout (`the pit`, `no bugs only features`,
🤘). `mosh()` already blasts the moshcoding Spotify playlist and opens it in a
desktop browser — scripts inherit that.

## Success Metrics

- The unchanged starter `while (alive) { code(); mosh(); notify(); repeat(); }`
  runs under the new engine with equivalent output.
- A single `.mosh` file can install an engine, register an MCP server across
  engines, and launch an agent session — actions that previously required typing
  three separate pit commands.
- `--dry-run` performs zero side effects (verified by tests: no spawns, no
  network) while narrating every intended action.
- Engine/tool argv mappings are covered by pure unit tests with no real spawns.
- The full moshcode test suite passes; the two entrypoints share one default
  iteration budget.

## Risks & Open Questions

Several early questions were settled while building the base architecture
(`src/runtime.mjs`, `src/registry.mjs`, `src/cli.mjs`); recorded here as
decisions:

- **RESOLVED — execution model.** JS runs via `new AsyncFunction(...)` with the
  vocabulary injected through a `with (proxy)` scope. The proxy owns only the
  vocabulary + `alive`/`argv`/`env`; everything else (locals, `console`, `Math`)
  falls through to normal scoping, so full JS works with zero dependencies and no
  sandbox promised.
- **RESOLVED — one registry, and verbs shell out to the CLI.** Rather than share
  the two dispatch ladders, CLI verbs simply run `moshcode <cmd> …` (spawnSync).
  The CLI stays the single implementation; the moshscript vocabulary is a
  `createRegistry()` of `{name, run}` commands, so it can't silently diverge from
  the capability it wraps.
- **RESOLVED — blocking semantics.** CLI verbs and `sleep()` are synchronous and
  blocking, so the simple no-`await` style (`install(…); agents(…);`) runs in
  order; fire-and-forget async verbs (`notify`) are drained before the runner
  returns, so a bare `notify()` still delivers.
- **RESOLVED — iteration budget.** `--max` counts reads of `alive`, so a
  `while (alive)` loop runs at most `--max` times (shared default **3** across
  both entrypoints); straight-line scripts and plain `for` loops are unbounded.
- **Error convention** (R8): CLI verbs currently throw on a non-zero exit (fail
  loud). Whether a non-zero passthrough should instead return a result the script
  can branch on is still open; a throwing model can make `while (alive)` loops
  brittle.
- **Interactive verbs in non-interactive runs** (R15): with spawnSync+inherited
  stdio, `agents()`/`start()` are fully interactive in a real terminal, but in
  CI/cron (no TTY) they can hang or error. The intended answer is R15's
  `notify()` bridge — a headless script pings the operator and waits on a
  moshcode.sh reply instead of blocking on a dead TTY. The reply-inbox endpoint
  that feeds a response back into a waiting script is not yet built.
- **`--dry-run` for the shell-out.** Under dry-run, CLI verbs narrate
  `would run: moshcode …` and never spawn; the parent CLI they'd invoke doesn't
  re-parse `--dry-run`, so nested dry-run is a runtime concern, handled in
  `src/cli.mjs`, not passed through.
- Should `.mosh` files support `import`/module reuse later? Deferred; the
  AsyncFunction model doesn't foreclose it.
