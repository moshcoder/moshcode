// `mcp add` and `skill install` fan out over the engines, print a per-engine
// summary, and then returned 0 no matter what came back — including the case
// where every engine that ran failed. bin/moshcode.mjs makes that return value
// the process exit code (`process.exitCode = (await mcpCommand(rest)) || 0`),
// so `moshcode mcp add … && deploy` ran the deploy after registering the server
// precisely nowhere, and CI could not tell the difference.
//
// `upgrade` is the same fan-out shape and already gets this right — it counts
// `!r.ok` over the engines it ran and exits 1 if any failed
// (bin/moshcode.mjs: `const failed = results.filter((r) => !r.ok).length`).
// These two commands now apply that same rule.
import assert from "node:assert/strict";
import test from "node:test";

import { ENGINES } from "../src/engines.mjs";
import { MCP_ENGINES } from "../src/mcp.mjs";
import { SKILL_ENGINES } from "../src/skills.mjs";
import { mcpCommand, skillCommand } from "../src/integrations.mjs";

const ALL = new Set(Object.keys(ENGINES));
const ADD = ["add", "demo", "https://example.com/mcp"];
const INSTALL = ["install", "https://github.com/example/skill.git"];

const OK = async () => ({ ok: true, code: 0 });
const BOOM = async () => ({ ok: false, code: 3 });
// Fail exactly one engine, succeed everywhere else.
const failOnly = (bin) => async (cmd) => (cmd === bin ? { ok: false, code: 3 } : { ok: true, code: 0 });

/** Run `fn` with console.log muted — these commands print a summary we don't assert on. */
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = log; }
}

// --- the bug -----------------------------------------------------------------

test("mcp add exits non-zero when every engine that ran failed", async () => {
  const code = await quietly(() => mcpCommand(ADD, { run: BOOM, installedSet: ALL }));
  assert.equal(code, 1, "every engine failed but the command reported success");
});

test("mcp add exits non-zero when a single engine failed", async () => {
  const code = await quietly(() => mcpCommand(ADD, { run: failOnly(ENGINES.codex.bin), installedSet: ALL }));
  assert.equal(code, 1, "codex failed but the command reported success");
});

test("skill install exits non-zero when every engine that ran failed", async () => {
  const code = await quietly(() => skillCommand(INSTALL, { run: BOOM, installedSet: ALL }));
  assert.equal(code, 1, "every engine failed but the command reported success");
});

test("skill install exits non-zero when a single engine failed", async () => {
  const code = await quietly(() => skillCommand(INSTALL, { run: failOnly(ENGINES.gemini.bin), installedSet: ALL }));
  assert.equal(code, 1, "gemini failed but the command reported success");
});

// --- the opposite direction: exit 0 must still mean exit 0 -------------------

test("mcp add still exits 0 when every engine registered the server", async () => {
  const code = await quietly(() => mcpCommand(ADD, { run: OK, installedSet: ALL }));
  assert.equal(code, 0);
});

test("skill install still exits 0 when every engine installed the skill", async () => {
  // `run` is stubbed, so no clone lands and the real settle would correctly
  // report an empty directory. This test is about the exit code, not about
  // what the clone contained.
  const settle = () => ({ kind: "single", installed: ["some-skill"], kept: [] });
  const code = await quietly(() => skillCommand(INSTALL, { run: OK, installedSet: ALL, settle }));
  assert.equal(code, 0);
});

// A box that simply does not have all six engines is not a failing box. Only an
// engine we ran and that came back non-zero counts.
test("mcp add exits 0 when no engine is installed, so none was attempted", async () => {
  const code = await quietly(() => mcpCommand(ADD, {
    run: async () => assert.fail("no engine is installed — nothing should have run"),
    installedSet: new Set(),
  }));
  assert.equal(code, 0);
});

test("skill install exits 0 when no engine is installed, so none was attempted", async () => {
  const code = await quietly(() => skillCommand(INSTALL, {
    run: async () => assert.fail("no engine is installed — nothing should have run"),
    installedSet: new Set(),
  }));
  assert.equal(code, 0);
});

test("mcp add exits 0 when the only engines present cannot express the server", async () => {
  const noMcp = Object.keys(ENGINES).filter((key) => !MCP_ENGINES.includes(key));
  assert.ok(noMcp.length, "expected at least one engine with no MCP support");
  const code = await quietly(() => mcpCommand(ADD, {
    run: async () => assert.fail("an engine with no MCP support must not be run"),
    installedSet: new Set(noMcp),
  }));
  assert.equal(code, 0, "skipped is not failed");
});

test("skill install exits 0 when the only engines present have no skills primitive", async () => {
  const noSkills = Object.keys(ENGINES).filter((key) => !SKILL_ENGINES.includes(key));
  assert.ok(noSkills.length, "expected at least one engine with no skills primitive");
  const code = await quietly(() => skillCommand(INSTALL, {
    run: async () => assert.fail("an engine with no skills primitive must not be run"),
    installedSet: new Set(noSkills),
  }));
  assert.equal(code, 0, "skipped is not failed");
});

// --- the exit codes the commands already got right --------------------------

test("mcp list still exits 0 and skill list still exits 0", async () => {
  assert.equal(await quietly(() => mcpCommand(["list"])), 0);
  assert.equal(await quietly(() => skillCommand(["list"])), 0);
});

test("a bad skill verb still exits 1", async () => {
  assert.equal(await quietly(() => skillCommand(["frobnicate"])), 1);
});
