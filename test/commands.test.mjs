import assert from "node:assert/strict";
import test from "node:test";

import { moshVocabulary } from "../src/commands.mjs";

function createCtx() {
  return {
    dryRun: true,
    iter: 0,
    stopped: false,
    lines: [],
    out(line) {
      this.lines.push(line);
    },
    stop() {
      this.stopped = true;
    },
  };
}

// The verb helper: pull one command's run() out of a fresh vocabulary.
function verb(name) {
  const cmd = moshVocabulary().get(name);
  assert.ok(cmd, `expected a ${name}() command in the vocabulary`);
  return cmd.run;
}

for (const name of ["code", "mosh", "repeat", "stop"]) {
  test(`${name}() rejects unexpected arguments`, async () => {
    await assert.rejects(
      async () => verb(name)(createCtx(), "extra"),
      new RegExp(`moshscript: ${name}\\(\\) does not take arguments`)
    );
  });
}

test("mosh() blasts the moshcoding playlist url", async () => {
  const ctx = createCtx();
  await verb("mosh")(ctx);

  assert.match(ctx.lines.join("\n"), /open\.spotify\.com\/playlist\//);
  // dryRun ctx must not attempt to launch a browser (no launch line)
  assert.ok(!ctx.lines.some((l) => /launched in your browser/.test(l)));
});

test("notify() in dry-run prints the message and doesn't hit the network", async () => {
  const ctx = createCtx(); // dryRun: true
  const res = await verb("notify")(ctx, "hello", "there");

  assert.match(ctx.lines.join("\n"), /hello there/);
  assert.deepEqual(res, { dryRun: true });
});

test("ask() in dry-run announces it would block, returns null", async () => {
  const ctx = createCtx();
  const reply = await verb("ask")(ctx, "what next?");

  assert.equal(reply, null);
  assert.match(ctx.lines.join("\n"), /would block/);
});

test("stop() flips the ctx alive flag off", async () => {
  const ctx = createCtx();
  await verb("stop")(ctx);
  assert.equal(ctx.stopped, true);
});

test("sleep accepts zero milliseconds (no-op, synchronous)", () => {
  assert.equal(verb("sleep")({}, 0), undefined);
});

test("sleep throws synchronously on a negative duration", () => {
  assert.throws(
    () => verb("sleep")({}, -1),
    /sleep\(ms\) requires a finite non-negative number/
  );
});

test("the vocabulary exposes summaries for `moshcode commands`", () => {
  for (const cmd of moshVocabulary().all()) {
    assert.equal(typeof cmd.name, "string");
    assert.equal(typeof cmd.summary, "string");
    assert.ok(cmd.summary.length > 0, `${cmd.name}() needs a summary`);
  }
});
