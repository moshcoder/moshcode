import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { splitCommandLine } from "../src/tui.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function runTui(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

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

test("TUI /run rejects unknown options before reading a script file", async () => {
  const result = await runTui("/run --dryrun\n/quit\n");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /unknown option --dryrun/);
  assert.doesNotMatch(result.stdout, /can't read --dryrun/);
});
