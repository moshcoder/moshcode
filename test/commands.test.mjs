import assert from "node:assert/strict";
import test from "node:test";

import { defaultCommands } from "../src/commands.mjs";

function createCtx() {
  return {
    dryRun: true,
    iter: 0,
    vars: { alive: true },
    lines: [],
    out(line) {
      this.lines.push(line);
    },
  };
}

for (const name of ["code", "mosh", "repeat", "stop"]) {
  test(`${name}() rejects unexpected arguments`, async () => {
    const commands = defaultCommands();
    await assert.rejects(
      async () => commands[name](createCtx(), ["extra"]),
      new RegExp(`moshscript: ${name}\\(\\) does not take arguments`)
    );
  });
}

test("notify() still accepts message arguments", async () => {
  const commands = defaultCommands();
  const ctx = createCtx();

  await commands.notify(ctx, ["hello", "there"]);

  assert.equal(ctx.lines.length, 1);
  assert.match(ctx.lines[0], /hello there/);
});
