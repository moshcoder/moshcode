import assert from "node:assert/strict";
import test from "node:test";
import { compile, tokenize } from "../src/interpreter.mjs";

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
