import assert from "node:assert/strict";
import test from "node:test";

import { runScript } from "../src/runtime.mjs";
import { createRegistry } from "../src/registry.mjs";

// A vocabulary whose async verb only records once it has actually settled, the
// way notify()'s POST only counts once it reaches the app. `delivered` therefore
// distinguishes "queued" from "really delivered" — the whole point of the drain.
//
// The verb resolves on a macrotask (setTimeout), not a microtask: an un-drained
// promise chained purely off microtasks can still finish by accident before the
// caller observes anything, which would make these tests pass for the wrong
// reason. A timer cannot.
function slowVocab() {
  const delivered = [];
  const registry = createRegistry([
    {
      name: "notify",
      summary: "fire-and-forget async verb",
      run: (_ctx, msg) =>
        new Promise((resolve) => setTimeout(() => { delivered.push(msg); resolve({ ok: true }); }, 5)),
    },
    {
      name: "reject",
      summary: "fire-and-forget async verb that fails",
      run: () => new Promise((_res, rej) => setTimeout(() => rej(new Error("delivery refused")), 5)),
    },
    { name: "sync", summary: "blocking verb", run: () => "done" },
  ]);
  return { delivered, registry };
}

test("a fire-and-forget notify still delivers when the script throws", async () => {
  const { delivered, registry } = slowVocab();
  await assert.rejects(
    async () => runScript(`notify("build failed"); nope();`, { commands: registry }),
    /nope is not defined/
  );
  // The failure ping is the one the operator most wants; it must not be dropped.
  assert.deepEqual(delivered, ["build failed"]);
});

test("a fire-and-forget notify still delivers when a verb throws", async () => {
  const { delivered, registry } = slowVocab();
  registry.register({ name: "explode", run: () => { throw new Error("verb blew up"); } });
  await assert.rejects(
    async () => runScript(`notify("half way"); explode();`, { commands: registry }),
    /verb blew up/
  );
  assert.deepEqual(delivered, ["half way"]);
});

test("every queued notify delivers when the script throws, not just the first", async () => {
  const { delivered, registry } = slowVocab();
  await assert.rejects(
    async () => runScript(`notify("one"); notify("two"); notify("three"); nope();`, { commands: registry }),
    /nope is not defined/
  );
  assert.deepEqual(delivered.sort(), ["one", "three", "two"]);
});

test("notifies queued inside a while (alive) loop deliver when the script throws", async () => {
  const { delivered, registry } = slowVocab();
  await assert.rejects(
    async () => runScript(`while (alive) { notify("tick"); } nope();`, { commands: registry, max: 3 }),
    /nope is not defined/
  );
  assert.deepEqual(delivered, ["tick", "tick", "tick"]);
});

test("the script's own error survives the drain unchanged", async () => {
  const { registry } = slowVocab();
  // allSettled never rejects, so draining cannot replace or mask the real cause.
  await assert.rejects(
    async () => runScript(`notify("x"); throw new Error("the original cause");`, { commands: registry }),
    /the original cause/
  );
});

test("a REJECTING fire-and-forget verb does not mask the script's error", async () => {
  const { registry } = slowVocab();
  await assert.rejects(
    async () => runScript(`reject(); nope();`, { commands: registry }),
    /nope is not defined/
  );
});

// ---- controls: the pre-existing contract must be unchanged both ways ----

test("control: notify still delivers on the success path", async () => {
  const { delivered, registry } = slowVocab();
  const r = await runScript(`notify("all good");`, { commands: registry });
  assert.deepEqual(delivered, ["all good"]);
  assert.equal(r.stopped, false);
});

test("control: runScript still resolves { iterations, stopped } after draining", async () => {
  const { delivered, registry } = slowVocab();
  registry.register({ name: "halt", summary: "stop the loop", run: (ctx) => ctx.stop() });
  const r = await runScript(`while (alive) { notify("x"); halt(); }`, { commands: registry, max: 5 });
  assert.equal(r.iterations, 1);
  assert.equal(r.stopped, true);
  assert.deepEqual(delivered, ["x"]);
});

test("control: a throwing script with nothing queued still rejects", async () => {
  const { delivered, registry } = slowVocab();
  await assert.rejects(
    async () => runScript(`sync(); nope();`, { commands: registry }),
    /nope is not defined/
  );
  assert.deepEqual(delivered, []);
});

test("control: an awaited notify is unaffected and still returns its value", async () => {
  const { delivered, registry } = slowVocab();
  await runScript(`const r = await notify("awaited"); if (!r.ok) throw new Error("lost the return value");`, {
    commands: registry,
  });
  assert.deepEqual(delivered, ["awaited"]);
});
