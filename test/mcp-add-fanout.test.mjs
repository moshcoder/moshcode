// prd/0003 R6: an engine that cannot express the requested server MUST be
// skipped *with a stated reason*, and the others still registered. The PRD's
// own UX example ends on `· aider  skipped — no MCP support`. The plan is what
// the summary prints, so an engine the plan omits is an engine the user never
// hears about — `/mcp list` shows six engines while the fan-out showed five.
import assert from "node:assert/strict";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import { MCP_ENGINES, alreadyRegistered, mcpAddArgs, planMcpAdd, runMcpAdd } from "../src/mcp.mjs";
import { mcpTargetStatus } from "../src/integrations.mjs";

const REMOTE = { name: "sentry", target: "https://mcp.sentry.dev/mcp", args: [], env: [], headers: [] };
const NO_MCP = Object.keys(ENGINES).filter((key) => !MCP_ENGINES.includes(key));
const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));

// --- the bug -----------------------------------------------------------------

test("the plan covers every engine, not just the ones with MCP support", () => {
  const keys = planMcpAdd(REMOTE, { installedSet: new Set() }).map((p) => p.key);
  assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
});

test("every engine without MCP support carries a skip reason", () => {
  // R6 asks for a *stated reason*, not one shared string: "no MCP support" fits
  // aider, which has none, but not kimi, which runs servers and only lacks a way
  // to register one from a script. What must hold for all of them is that the
  // row says why.
  const plan = byKey(planMcpAdd(REMOTE, { installedSet: new Set() }));
  assert.ok(NO_MCP.length, "expected at least one engine with no MCP support");
  for (const key of NO_MCP) {
    assert.equal(typeof plan[key]?.skip, "string", `${key} has no skip reason`);
    assert.ok(plan[key].skip.length, `${key}'s skip reason is empty`);
  }
});

test("aider specifically reaches the plan and is skipped with a reason", () => {
  const aider = byKey(planMcpAdd(REMOTE, { installedSet: new Set() })).aider;
  assert.equal(aider?.skip, "no MCP support");
  assert.equal(aider?.argv, undefined, "a skipped engine must not carry an argv");
});

test("the fan-out reports the no-MCP engines as skipped", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set() });
  const results = byKey(await runMcpAdd(plan, { run: async () => ({ ok: true, code: 0 }) }));
  for (const key of NO_MCP) {
    assert.equal(results[key]?.status, "skipped", `${key} missing from the summary`);
    assert.ok(results[key]?.reason, `${key} was skipped without saying why`);
  }
});

test("skipped beats not-installed: a missing no-MCP engine still states its reason", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude"]) }); // aider NOT installed
  const results = byKey(await runMcpAdd(plan, { run: async () => ({ ok: true, code: 0 }) }));
  assert.equal(results.aider?.status, "skipped");
  assert.equal(results.aider?.reason, "no MCP support");
});

test("an INSTALLED no-MCP engine is skipped and never spawned", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set([...MCP_ENGINES, ...NO_MCP]) });
  const spawned = [];
  const results = byKey(await runMcpAdd(plan, {
    run: async (bin, argv) => { spawned.push(bin); return { ok: true, code: 0 }; },
  }));
  for (const key of NO_MCP) {
    assert.equal(results[key]?.status, "skipped", `${key} should skip even when installed`);
    assert.ok(!spawned.includes(ENGINES[key].bin), `${ENGINES[key].bin} must never be spawned`);
  }
  assert.equal(spawned.length, MCP_ENGINES.length, "only the MCP-capable engines run");
});

test("the fan-out and the /mcp list matrix name the same engines", () => {
  const planned = planMcpAdd(REMOTE, { installedSet: new Set() }).map((p) => p.key).sort();
  const matrix = mcpTargetStatus({ installedSet: new Set() }).map((t) => t.name).sort();
  assert.deepEqual(planned, matrix);
});

// --- controls: the fix must not over-report ----------------------------------

test("MCP_ENGINES is the reviewed list — an engine only joins on purpose", () => {
  // qwen joined deliberately: Qwen Code is a Gemini CLI fork and shipped the
  // whole `qwen mcp add` surface, verified against its own --help. Everything
  // else here is unchanged. This stays a pinned list rather than something
  // derived from ENGINES, because "can moshcode register a server here" is a
  // claim someone has to check against a real CLI, not infer from a roster.
  assert.deepEqual(MCP_ENGINES, ["claude", "gemini", "qwen", "codex", "opencode", "privacycode"]);
});

test("kimi is skipped for the reason that actually applies to it", () => {
  // Kimi Code runs MCP servers; it just has no command to register one from a
  // script (config file, or the /mcp-config picker inside a session). Reporting
  // that as the blanket "no MCP support" would send someone off to look for an
  // MCP-capable engine they already have installed.
  const { skip, argv } = mcpAddArgs("kimi", REMOTE);
  assert.equal(argv, undefined, "a skipped engine must not carry an argv");
  assert.match(skip, /no scriptable `mcp add`/);
  assert.match(skip, /mcp-config|mcp\.json/);
  assert.notEqual(skip, "no MCP support");
});

test("the MCP-capable engines still come first, in their original order", () => {
  const keys = planMcpAdd(REMOTE, { installedSet: new Set() }).map((p) => p.key);
  assert.deepEqual(keys.slice(0, MCP_ENGINES.length), MCP_ENGINES);
});

test("claude's argv is byte-identical", () => {
  const plan = byKey(planMcpAdd(REMOTE, { installedSet: new Set() }));
  assert.deepEqual(plan.claude.argv, ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
});

test("gemini's argv is byte-identical", () => {
  const plan = byKey(planMcpAdd(REMOTE, { installedSet: new Set() }));
  assert.deepEqual(plan.gemini.argv, ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
});

test("qwen's argv matches gemini's — it is the same CLI surface", () => {
  const plan = byKey(planMcpAdd(REMOTE, { installedSet: new Set() }));
  assert.deepEqual(plan.qwen.argv, ["mcp", "add", "-s", "user", "-t", "http", "sentry", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(plan.qwen.argv, plan.gemini.argv);
  assert.equal(plan.qwen.skip, undefined, "qwen registers servers; it must not be skipped");
});

test("qwen carries env and headers through, like gemini", () => {
  const spec = { ...REMOTE, env: [["TOKEN", "z"]], headers: ["X-Api-Key: abc"] };
  const plan = byKey(planMcpAdd(spec, { installedSet: new Set() }));
  assert.deepEqual(plan.qwen.argv, [
    "mcp", "add", "-s", "user", "-t", "http",
    "-e", "TOKEN=z", "-H", "X-Api-Key: abc",
    "sentry", "https://mcp.sentry.dev/mcp",
  ]);
});

test("qwen takes a stdio command server too", () => {
  const stdio = { name: "my-tools", target: "npx", args: ["-y", "my-mcp-server"], env: [], headers: [] };
  const plan = byKey(planMcpAdd(stdio, { installedSet: new Set() }));
  assert.deepEqual(plan.qwen.argv, ["mcp", "add", "-s", "user", "my-tools", "npx", "-y", "my-mcp-server"]);
});

test("codex's and opencode's argv are byte-identical", () => {
  const plan = byKey(planMcpAdd(REMOTE, { installedSet: new Set() }));
  assert.deepEqual(plan.codex.argv, ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
  assert.deepEqual(plan.opencode.argv, ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
});

test("R7 still holds: codex skips on literal headers, opencode normalizes them", () => {
  const withHeaders = { ...REMOTE, headers: ["Authorization: Bearer z"] };
  const plan = byKey(planMcpAdd(withHeaders, { installedSet: new Set() }));
  assert.match(plan.codex.skip, /bearer-token env var/);
  assert.deepEqual(plan.opencode.argv.slice(-2), ["--header", "Authorization=Bearer z"]);
});

test("R6 still holds: opencode and privacycode skip a stdio command server", () => {
  const stdio = { name: "my-tools", target: "npx", args: ["-y", "my-mcp-server"], env: [], headers: [] };
  const plan = byKey(planMcpAdd(stdio, { installedSet: new Set() }));
  assert.match(plan.opencode.skip, /only remote \(--url\) servers/);
  assert.match(plan.privacycode.skip, /only remote \(--url\) servers/);
  assert.deepEqual(plan.claude.argv, ["mcp", "add", "-s", "user", "my-tools", "--", "npx", "-y", "my-mcp-server"]);
});

test("no engine is planned twice", () => {
  const keys = planMcpAdd(REMOTE, { installedSet: new Set() }).map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("every planned entry carries its real bin", () => {
  for (const item of planMcpAdd(REMOTE, { installedSet: new Set() })) {
    assert.equal(item.bin, ENGINES[item.key].bin);
  }
});

test("installedSet still decides a real target's status", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude"]) });
  const results = byKey(await runMcpAdd(plan, { run: async () => ({ ok: true, code: 0 }) }));
  assert.equal(results.claude.status, "added");
  assert.equal(results.gemini.status, "not-installed");
});

test("a signal or non-zero exit still reports failed, not skipped", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude", "gemini"]) });
  const results = byKey(await runMcpAdd(plan, {
    run: async (bin) => (bin === "claude"
      ? { ok: true, code: null, signal: "SIGTERM" }
      : { ok: true, code: 1 }),
  }));
  assert.equal(results.claude.status, "failed");
  assert.equal(results.claude.signal, "SIGTERM");
  assert.equal(results.gemini.status, "failed");
});

// --- re-running an install is not a failure ----------------------------------

test("an engine that says the server already exists reports `already`, not failed", async () => {
  // Claude Code exits 1 with "MCP server X already exists in user config". Read
  // as a failure, that row said moshcode could not register with Claude Code —
  // when in fact it already had.
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude"]) });
  const results = byKey(await runMcpAdd(plan, {
    run: async () => ({ ok: true, code: 1, output: "MCP server sentry already exists in user config\n" }),
  }));
  assert.equal(results.claude.status, "already");
});

test("the same wording is recognised from each engine that uses it", () => {
  for (const words of [
    "MCP server sentry already exists in user config", // claude
    "Server \"sentry\" is already configured",          // gemini / qwen
    "server already registered",
    "sentry already added",
  ]) {
    assert.equal(alreadyRegistered({ code: 1, output: words }), true, words);
  }
});

test("a failure for any other reason is still a failure", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude"]) });
  const results = byKey(await runMcpAdd(plan, {
    run: async () => ({ ok: true, code: 1, output: "error: connection refused\n" }),
  }));
  assert.equal(results.claude.status, "failed");
  assert.equal(results.claude.code, 1);
  // and no output at all must never be read as "already there"
  assert.equal(alreadyRegistered({ code: 1 }), false);
  assert.equal(alreadyRegistered({ code: 1, output: "" }), false);
});

test("a zero exit is `added` even if the word `already` appears in the noise", async () => {
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude"]) });
  const results = byKey(await runMcpAdd(plan, {
    run: async () => ({ ok: true, code: 0, output: "note: sentry already exists upstream\n" }),
  }));
  assert.equal(results.claude.status, "added", "a successful add is an add");
});

test("runMcpAdd asks for captured output — it cannot classify what it cannot read", async () => {
  const seen = [];
  const plan = planMcpAdd(REMOTE, { installedSet: new Set(["claude"]) });
  await runMcpAdd(plan, {
    run: async (bin, argv, opts) => { seen.push(opts); return { ok: true, code: 0 }; },
  });
  assert.deepEqual(seen, [{ capture: true }]);
});

test("mcpAddArgs itself is untouched for a supported and an unsupported key", () => {
  assert.equal(mcpAddArgs("aider", REMOTE).skip, "no MCP support");
  assert.deepEqual(mcpAddArgs("codex", REMOTE).argv, ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
});

