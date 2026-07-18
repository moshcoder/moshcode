import assert from "node:assert/strict";
import test from "node:test";

import { splitCommandLine } from "../src/tui.mjs";

test("TUI command parsing preserves quoted native CLI arguments", () => {
  assert.deepEqual(
    splitCommandLine('/coinpay card pay --description "Fix the build" --note \'ship it\''),
    ["/coinpay", "card", "pay", "--description", "Fix the build", "--note", "ship it"],
  );
});

test("TUI command parsing supports escaped whitespace and empty arguments", () => {
  assert.deepEqual(splitCommandLine("/ugig search two\\ words \"\""), [
    "/ugig",
    "search",
    "two words",
    "",
  ]);
});

test("TUI command parsing preserves Windows paths inside double quotes", () => {
  assert.deepEqual(splitCommandLine('/run "C:\\Users\\mosh\\script.mosh"'), [
    "/run",
    "C:\\Users\\mosh\\script.mosh",
  ]);
});

test("TUI command parsing rejects incomplete quoting", () => {
  assert.throws(() => splitCommandLine('/coinpay --description "unfinished'), /unterminated/);
  assert.throws(() => splitCommandLine("/ugig trailing\\"), /trailing escape/);
});
