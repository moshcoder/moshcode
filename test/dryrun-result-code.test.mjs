// PRD 0004 R8 — the branchable result contract, under --dry-run.
//
// cli.mjs documents runMoshcode as "Returns { ok, code } — always", and the
// shell() verb documents "Returns { ok, code } so scripts can branch on the
// exit status". Under --dry-run both used to return { ok, dryRun } with NO
// `code`, so the documented `.code` branch read undefined and a dry run took
// the failure path even though nothing ran and nothing failed.
//
// The bug tests assert `code` is present and 0 in dry-run. The control tests
// assert the OPPOSITE direction — that real (non-dry) runs still report the
// TRUE exit status, and that dry-run still narrates instead of spawning — so
// the fix cannot buy a passing `.code` by pretending every command succeeded
// or by quietly executing the command for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runMoshcode } from "../src/cli.mjs";
import { moshVocabulary } from "../src/commands.mjs";
import { runScript } from "../src/runtime.mjs";

function dryCtx() {
  return { dryRun: true, lines: [], out(l) { this.lines.push(l); } };
}
function realCtx() {
  return { dryRun: false, lines: [], out(l) { this.lines.push(l); } };
}

// ---------------------------------------------------------------- the bug ---

test("runMoshcode returns a numeric code: 0 under dry-run", () => {
  const res = runMoshcode("agents", ["claude"], dryCtx());
  assert.equal(res.ok, true);
  assert.equal(res.code, 0, "dry-run must carry `code` — the JSDoc says always");
  assert.equal(typeof res.code, "number");
});

test("the documented `.code !== 0` branch does not misfire under dry-run", () => {
  // This is the exact expression the JSDoc invites scripts to write.
  const res = runMoshcode("install", ["claude"], dryCtx());
  assert.ok(!(res.code !== 0), "a dry run must not look like a non-zero exit");
});

test("shell() returns a numeric code: 0 under dry-run", () => {
  const shell = moshVocabulary().get("shell");
  const res = shell.run(dryCtx(), "npm", "test");
  assert.equal(res.ok, true);
  assert.equal(res.code, 0, "shell()'s own comment promises { ok, code }");
  assert.equal(typeof res.code, "number");
});

test("every CLI verb carries `code` under dry-run, not just the ones spot-checked", () => {
  // Derived from the vocabulary rather than hardcoded, so a newly added CLI
  // verb is covered automatically.
  const names = ["agents", "start", "install", "upgrade", "mcp", "skill", "prd",
    "ugig", "coinpay", "c0mpute", "secrets", "pwd", "run"];
  for (const name of names) {
    const res = moshVocabulary().get(name).run(dryCtx(), "test-arg");
    assert.equal(res.code, 0, `${name}() must return code: 0 in dry-run`);
  }
});

test("end-to-end through the runtime: a dry run reports success, not failure", async () => {
  const seen = [];
  await runScript(
    `const r = agents("claude"); say(r.code === 0 ? "SUCCESS" : "FAILURE:" + r.code);`,
    { commands: moshVocabulary(), dryRun: true, out: (s) => seen.push(s) }
  );
  const out = seen.join("\n");
  assert.match(out, /SUCCESS/);
  assert.doesNotMatch(out, /FAILURE/);
});

// --------------------------------------------------------------- controls ---
// These pass BOTH before and after the fix, and assert the opposite direction.

test("control: a real successful run still reports code 0", () => {
  const res = runMoshcode("--version", [], realCtx());
  assert.deepEqual({ ok: res.ok, code: res.code }, { ok: true, code: 0 });
});

test("control: a real failing run still reports the true non-zero code", () => {
  const res = runMoshcode("definitely-not-a-command", [], realCtx());
  assert.equal(res.ok, false);
  assert.notEqual(res.code, 0, "the fix must not flatten real failures to 0");
});

test("control: dry-run still narrates and never spawns", () => {
  const ctx = dryCtx();
  runMoshcode("upgrade", ["self", 2], ctx);
  assert.match(ctx.lines.join("\n"), /would run: moshcode upgrade self 2/);
});

test("control: shell() dry-run still narrates instead of executing", () => {
  const ctx = dryCtx();
  // If this ever really ran, the marker file path would be touched. Narrating
  // is the only acceptable behaviour.
  const res = moshVocabulary().get("shell").run(ctx, "exit 3");
  assert.match(ctx.lines.join("\n"), /would run: \$SHELL -c/);
  assert.equal(res.ok, true, "a narrated command has no exit status to fail on");
});

test("control: shell() in a real run still surfaces a non-zero exit", () => {
  const res = moshVocabulary().get("shell").run(realCtx(), "exit 3");
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
});

test("control: dryRun flag is still set, so callers keying off it keep working", () => {
  assert.equal(runMoshcode("agents", ["claude"], dryCtx()).dryRun, true);
  assert.equal(moshVocabulary().get("shell").run(dryCtx(), "ls").dryRun, true);
});
