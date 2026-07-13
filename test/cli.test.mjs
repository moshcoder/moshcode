import assert from "node:assert/strict";
import test from "node:test";

import { runMoshcode, cliVerb, runAi } from "../src/cli.mjs";
import { aiExecArgs, pickAiEngine } from "../src/engines.mjs";
import { moshVocabulary } from "../src/commands.mjs";
import { runScript } from "../src/runtime.mjs";
import { createRegistry } from "../src/registry.mjs";

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
  for (const name of ["agents", "start", "install", "upgrade", "mcp", "skill", "prd", "ugig", "coinpay", "c0mpute", "pwd", "ai"]) {
    assert.ok(reg.has(name), `expected ${name}() in the vocabulary`);
  }
});

// R12: pure unit tests for every CLI verb → argv mapping (dry-run, no real spawns).
// Each case verifies the verb narrates the correct `moshcode <cmd> ...args` argv.
const VERB_ARGV_CASES = [
  { verb: "agents",  args: ["claude"],                       expect: /moshcode agents claude/ },
  { verb: "agents",  args: ["opencode", "--model", "gpt-4"], expect: /moshcode agents opencode --model gpt-4/ },
  { verb: "start",   args: ["codex", "--sandbox"],           expect: /moshcode start codex --sandbox/ },
  { verb: "install", args: ["claude"],                       expect: /moshcode install claude/ },
  { verb: "install", args: ["ugig"],                         expect: /moshcode install ugig/ },
  { verb: "upgrade", args: ["self"],                         expect: /moshcode upgrade self/ },
  { verb: "upgrade", args: [],                               expect: /moshcode upgrade/ },
  { verb: "mcp",     args: ["install", "https://mcp.sentry.dev/mcp"], expect: /moshcode mcp install https:\/\/mcp\.sentry\.dev\/mcp/ },
  { verb: "skill",   args: ["install", "https://github.com/example/skill"], expect: /moshcode skill install/ },
  { verb: "prd",     args: ["my great idea"],                expect: /moshcode prd my great idea/ },
  { verb: "ugig",    args: ["--json", "gigs", "list"],       expect: /moshcode ugig --json gigs list/ },
  { verb: "coinpay", args: ["wallet", "balance"],            expect: /moshcode coinpay wallet balance/ },
  { verb: "c0mpute", args: ["status"],                       expect: /moshcode c0mpute status/ },
  { verb: "pwd",     args: [],                               expect: /moshcode pwd/ },
  { verb: "run",     args: ["setup.mosh"],                   expect: /moshcode run setup\.mosh/ },
];

for (const { verb, args, expect: pattern } of VERB_ARGV_CASES) {
  test(`verb→argv: ${verb}(${args.map(JSON.stringify).join(", ")}) narrates the correct argv`, () => {
    const ctx = dryCtx();
    const cmd = moshVocabulary().get(verb);
    assert.ok(cmd, `${verb}() must be in the vocabulary`);
    cmd.run(ctx, ...args);
    const output = ctx.lines.join("\n");
    assert.match(output, pattern, `expected ${verb}() to narrate ${pattern}, got: ${output}`);
  });
}

// Verify CLI verbs return { ok, dryRun } under dry-run (no real spawn).
test("all CLI verbs return { ok: true, dryRun: true } in dry-run mode", () => {
  const cliNames = ["agents", "start", "install", "upgrade", "mcp", "skill", "prd", "ugig", "coinpay", "c0mpute", "pwd", "run"];
  for (const name of cliNames) {
    const ctx = dryCtx();
    const cmd = moshVocabulary().get(name);
    const result = cmd.run(ctx, "test-arg");
    assert.equal(result.ok, true, `${name}() should return ok: true`);
    assert.equal(result.dryRun, true, `${name}() should return dryRun: true`);
  }
});

// Verify CLI verbs are callable from a real moshscript (dry-run, end-to-end through the runtime).
test("CLI verbs are callable from moshscript in dry-run mode", async () => {
  const lines = [];
  await runScript(
    `install("claude"); agents("claude"); mcp("install", "https://example.com/mcp");`,
    { commands: moshVocabulary(), dryRun: true, out: (s) => lines.push(s) }
  );
  const output = lines.join("\n");
  assert.match(output, /would run: moshcode install claude/);
  assert.match(output, /would run: moshcode agents claude/);
  assert.match(output, /would run: moshcode mcp install https:\/\/example\.com\/mcp/);
});

// ai() verb — headless, non-interactive engine invocation.
test("aiExecArgs maps each engine to its headless invocation", () => {
  assert.deepEqual(aiExecArgs("claude", "hi"), ["-p", "hi"]);
  assert.deepEqual(aiExecArgs("codex", "hi"), ["exec", "hi"]);
  assert.deepEqual(aiExecArgs("gemini", "hi"), ["-p", "hi"]);
  assert.deepEqual(aiExecArgs("opencode", "hi"), ["run", "hi"]);
  assert.deepEqual(aiExecArgs("aider", "hi").slice(0, 2), ["--message", "hi"]);
  assert.throws(() => aiExecArgs("nope", "hi"), /no headless mode/);
});

test("pickAiEngine honors an explicit preference only if installed", () => {
  // nothing is guaranteed installed in CI → null, and an unknown pref → null
  assert.equal(pickAiEngine("definitely-not-an-engine"), null);
});

test("ai() in dry-run narrates the engine invocation and returns empty string", () => {
  const ctx = { dryRun: true, lines: [], out(l) { this.lines.push(l); } };
  const out = runAi(ctx, "summarize the diff", { engine: "codex" });
  assert.equal(out, "");
  assert.match(ctx.lines.join("\n"), /would run: codex exec/);
});

// R8: non-zero exits return { ok: false } instead of throwing, so scripts can
// branch on outcomes without a try/catch.
test("R8: a non-zero CLI exit returns { ok: false } instead of throwing", async () => {
  // Run a real `moshcode` command that will fail (unknown engine).
  // We use the actual moshcode binary via runMoshcode with a non-dry context.
  const lines = [];
  const ctx = { dryRun: false, out: (l) => lines.push(l) };
  // `moshcode agents nonexistent-engine-xyz` should exit non-zero.
  const result = runMoshcode("agents", ["nonexistent-engine-xyz-99"], ctx);
  assert.equal(result.ok, false, "non-zero exit should return ok: false");
  assert.ok(result.code !== 0, "should have a non-zero exit code");
  assert.equal(typeof result.code, "number");
});

test("R8: a non-zero exit does NOT crash a moshscript — script continues", async () => {
  const lines = [];
  // The script calls a failing CLI verb then continues to the next line.
  // Under the old throwing behavior, the second say() would never run.
  const result = await runScript(
    `const r = agents("nonexistent-engine-xyz-99");
     say("still alive after fail, ok=" + r.ok);`,
    { commands: moshVocabulary(), out: (s) => lines.push(s) }
  );
  const output = lines.join("\n");
  assert.match(output, /still alive after fail, ok=false/,
    "script should continue after a non-zero CLI exit");
});

// shell() verb — the system verb for arbitrary shell commands.
test("shell() is in the vocabulary", () => {
  assert.ok(moshVocabulary().has("shell"), "expected shell() in the vocabulary");
});

test("shell() in dry-run narrates the command without running it", () => {
  const ctx = dryCtx();
  const cmd = moshVocabulary().get("shell");
  const result = cmd.run(ctx, "echo hello");
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.match(ctx.lines.join("\n"), /would run:.*echo hello/);
});

test("shell() throws when called without arguments", () => {
  const ctx = dryCtx();
  const cmd = moshVocabulary().get("shell");
  assert.throws(() => cmd.run(ctx), /shell\(\) requires a command string/);
});

test("shell() runs a real command and returns { ok, code }", () => {
  const lines = [];
  const ctx = { dryRun: false, out: (l) => lines.push(l) };
  const cmd = moshVocabulary().get("shell");
  const result = cmd.run(ctx, "true");
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
});

test("shell() returns { ok: false } on non-zero exit without throwing", () => {
  const lines = [];
  const ctx = { dryRun: false, out: (l) => lines.push(l) };
  const cmd = moshVocabulary().get("shell");
  const result = cmd.run(ctx, "false");
  assert.equal(result.ok, false);
  assert.ok(result.code !== 0);
});

test("shell() is callable from moshscript and the script continues on failure", async () => {
  const lines = [];
  await runScript(
    `const r = shell("false"); say("continued, ok=" + r.ok);`,
    { commands: moshVocabulary(), out: (s) => lines.push(s) }
  );
  assert.match(lines.join("\n"), /continued, ok=false/);
});
