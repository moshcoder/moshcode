import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [BIN, "run", ...args], {
    encoding: "utf8",
  });
}

test("run rejects unknown options before treating them as files", () => {
  const result = run(["--dryrun"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: unknown option --dryrun/);
});

test("run rejects multiple script files", () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-run-"));
  const first = join(dir, "first.mosh");
  const second = join(dir, "second.mosh");
  writeFileSync(first, 'say("one");\n');
  writeFileSync(second, 'say("two");\n');

  const result = run([first, second, "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: expected one script file/);
});

test("run reports missing script files without a stack trace", () => {
  const missing = join(tmpdir(), "moshcode-missing-script.mosh");
  const result = run([missing, "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: cannot read script/);
  assert.doesNotMatch(result.stderr, /Error: moshcode run/);
});
