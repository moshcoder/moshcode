import assert from "node:assert/strict";
import test from "node:test";
import { defaultCommands } from "../src/commands.mjs";
import { compile, run, tokenize } from "../src/interpreter.mjs";

test("tokenize rejects unexpected characters between valid tokens", () => {
  assert.throws(() => tokenize("say(@);"), /unexpected character/);
  assert.throws(() => tokenize("say(\"ok\") @"), /unexpected character/);
});

test("compile preserves valid moshscript behavior", () => {
  assert.deepEqual(compile("say(\"hi\");").body[0], {
    type: "call",
    name: "say",
    args: ["hi"],
  });
});

test("negative numeric arguments reach command validation", async () => {
  const ast = compile("sleep(-1);");
  const ctx = {
    vars: { alive: true },
    iter: 0,
    maxIterations: 1,
    commands: defaultCommands(),
  };

  await assert.rejects(() => run(ast, ctx), /finite non-negative number/);
});

test("compile requires commas between call arguments", () => {
  assert.throws(() => compile("say(\"one\" \"two\");"), /expected comma/);
  assert.throws(() => compile("say(\"one\",);"), /expected argument after comma/);
  assert.throws(() => compile("say(,\"one\");"), /expected argument before comma/);

  assert.deepEqual(compile("say(\"one\", \"two\");").body[0], {
    type: "call",
    name: "say",
    args: ["one", "two"],
  });
});
