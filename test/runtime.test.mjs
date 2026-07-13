import assert from "node:assert/strict";
import test from "node:test";

import { runScript, stripShebang, DEFAULT_MAX } from "../src/runtime.mjs";
import { createRegistry } from "../src/registry.mjs";

// A tiny recording vocabulary so tests observe what a script did without spawning
// anything. `push(x)` records, `boom()` throws.
function recorder() {
  const calls = [];
  const registry = createRegistry([
    { name: "push", summary: "record", run: (_ctx, x) => calls.push(x) },
    { name: "boom", summary: "throw", run: () => { throw new Error("boom"); } },
  ]);
  return { calls, registry };
}

test("runs a .mosh file as real JavaScript (const/for/template literals)", async () => {
  const { calls, registry } = recorder();
  await runScript(
    `const parts = ["a", "b", "c"];
     for (const p of parts) push(p.toUpperCase());`,
    { commands: registry }
  );
  assert.deepEqual(calls, ["A", "B", "C"]);
});

test("the classic while (alive) loop runs, bounded by --max", async () => {
  const { calls, registry } = recorder();
  const { iterations } = await runScript(
    `while (alive) { push("mosh"); }`,
    { commands: registry, max: 4 }
  );
  assert.equal(calls.length, 4);
  assert.equal(iterations, 4);
});

test("stop() ends the loop early", async () => {
  const { calls, registry } = recorder();
  // count() is a host verb that stops after 2 pushes
  registry.register({
    name: "maybeStop",
    run: (ctx) => { if (ctx.iter >= 2) ctx.stop(); },
  });
  await runScript(
    `while (alive) { push("x"); maybeStop(); }`,
    { commands: registry, max: 100 }
  );
  assert.equal(calls.length, 2);
});

test("assigning alive = false also ends the loop", async () => {
  const { calls, registry } = recorder();
  await runScript(
    `let n = 0;
     while (alive) { push(n); n++; if (n === 3) alive = false; }`,
    { commands: registry, max: 100 }
  );
  assert.deepEqual(calls, [0, 1, 2]);
});

test("a plain for-loop is NOT bounded by --max (only alive reads are)", async () => {
  const { calls, registry } = recorder();
  const { iterations } = await runScript(
    `for (let i = 0; i < 10; i++) push(i);`,
    { commands: registry, max: 3 }
  );
  assert.equal(calls.length, 10);
  assert.equal(iterations, 0); // alive never read
});

test("script argv is exposed to the script", async () => {
  const { calls, registry } = recorder();
  await runScript(`push(argv[0]); push(argv[1]);`, {
    commands: registry,
    argv: ["staging", "--fast"],
  });
  assert.deepEqual(calls, ["staging", "--fast"]);
});

test("a leading shebang line is stripped, not executed", async () => {
  const { calls, registry } = recorder();
  await runScript(`#!/usr/bin/env moshscript\npush("ran");`, { commands: registry });
  assert.deepEqual(calls, ["ran"]);
});

test("stripShebang leaves shebang-less source untouched", () => {
  assert.equal(stripShebang('push("x");'), 'push("x");');
  assert.equal(stripShebang("#!/usr/bin/env moshscript\npush();"), "push();");
});

test("an unknown verb is a normal JS ReferenceError", async () => {
  const { registry } = recorder();
  await assert.rejects(
    async () => runScript(`frobnicate();`, { commands: registry }),
    /frobnicate is not defined/
  );
});

test("a throwing command propagates out of runScript", async () => {
  const { registry } = recorder();
  await assert.rejects(async () => runScript(`boom();`, { commands: registry }), /boom/);
});

test("runScript requires a commands registry", async () => {
  await assert.rejects(async () => runScript(`push();`, {}), /needs a \{ commands \} registry/);
});

test("DEFAULT_MAX bounds an unbounded while when no max is passed", async () => {
  const { calls, registry } = recorder();
  await runScript(`while (alive) { push(1); }`, { commands: registry });
  assert.equal(calls.length, DEFAULT_MAX);
});
