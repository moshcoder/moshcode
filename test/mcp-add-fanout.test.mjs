// prd/0003 R6: an engine that cannot express the requested server MUST be
// skipped *with a stated reason*, and the others still registered. The PRD's
// own UX example ends on `· aider  skipped — no MCP support`. The plan is what
// the summary prints, so an engine the plan omits is an engine the user never
// hears about — `/mcp list` shows six engines while the fan-out showed five.
import assert from "node:assert/strict";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import { MCP_ENGINES, mcpAddArgs, planMcpAdd, runMcpAdd } from "../src/mcp.mjs";
import { mcpTargetStatus } from "../src/integrations.mjs";

const REMOTE = { name: "sentry", target: "https://mcp.sentry.dev/mcp", args: [], env: [], headers: [] };
const NO_MCP = Object.keys(ENGINES).filter((key) => !MCP_ENGINES.includes(key));
const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));

// --- the bug -----------------------------------------------------------------

test("the plan covers every engine, not just the ones with MCP support", () => {
  const keys = planMcpAdd(REMOTE, { installedSet: new Set() }).map((p) => p.key);
  assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
});

test("every engine without MCP support carries the skip reason", () => {
  const plan = byKey(planMcpAdd(REMOTE, { installedSet: new Set() }));
  assert.ok(NO_MCP.length, "expected at least one engine with no MCP support");
  for (const key of NO_MCP) {
    assert.equal(plan[key]?.skip, "no MCP support", `${key} has no skip reason`);
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
    assert.equal(results[key]?.reason, "no MCP support");
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

test("MCP_ENGINES is unchanged — no engine gained MCP support", () => {
  assert.deepEqual(MCP_ENGINES, ["claude", "gemini", "codex", "opencode", "privacycode"]);
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

test("mcpAddArgs itself is untouched for a supported and an unsupported key", () => {
  assert.equal(mcpAddArgs("aider", REMOTE).skip, "no MCP support");
  assert.deepEqual(mcpAddArgs("codex", REMOTE).argv, ["mcp", "add", "sentry", "--url", "https://mcp.sentry.dev/mcp"]);
});
