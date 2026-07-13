import assert from "node:assert/strict";
import test from "node:test";

import { runMoshcode, cliVerb } from "../src/cli.mjs";
import { moshVocabulary } from "../src/commands.mjs";

function dryCtx() {
  return { dryRun: true, lines: [], out(l) { this.lines.push(l); } };
}

test("cliVerb maps name(...args) → `moshcode name ...args` (narrated in dry-run)", async () => {
  const ctx = dryCtx();
  const agents = cliVerb("agents", "launch");
  const res = await agents.run(ctx, "claude");

  assert.equal(res.dryRun, true);
  assert.match(ctx.lines.join("\n"), /would run: moshcode agents claude/);
});

test("runMoshcode stringifies args and never spawns under dry-run", async () => {
  const ctx = dryCtx();
  await runMoshcode("upgrade", ["self", 2], ctx);
  assert.match(ctx.lines.join("\n"), /would run: moshcode upgrade self 2/);
});

test("the CLI capabilities are all registered as verbs", () => {
  const reg = moshVocabulary();
  for (const name of ["agents", "start", "install", "upgrade", "mcp", "skill", "prd", "ugig", "coinpay", "c0mpute", "pwd"]) {
    assert.ok(reg.has(name), `expected ${name}() in the vocabulary`);
  }
});
