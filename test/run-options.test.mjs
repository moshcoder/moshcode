import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

function run(args) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "moshcode-run-stdio-"));
    const stdinFile = join(dir, "stdin");
    const stdoutFile = join(dir, "stdout");
    const stderrFile = join(dir, "stderr");
    writeFileSync(stdinFile, "");
    const stdin = openSync(stdinFile, "r");
    const stdout = openSync(stdoutFile, "w");
    const stderr = openSync(stderrFile, "w");
    const child = spawn(process.execPath, [BIN, "run", ...args], {
      stdio: [stdin, stdout, stderr],
    });
    let failed = false;
    child.on("error", (error) => { failed = true; reject(error); });
    child.on("close", (status, signal) => {
      for (const fd of [stdin, stdout, stderr]) closeSync(fd);
      if (!failed) resolve({
        status,
        signal,
        stdout: readFileSync(stdoutFile, "utf8"),
        stderr: readFileSync(stderrFile, "utf8"),
      });
    });
  });
}

test("run rejects unknown options before treating them as files", async () => {
  const result = await run(["--dryrun"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: unknown option --dryrun/);
});

test("run rejects multiple script files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-run-"));
  const first = join(dir, "first.mosh");
  const second = join(dir, "second.mosh");
  writeFileSync(first, 'say("one");\n');
  writeFileSync(second, 'say("two");\n');

  const result = await run([first, second, "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: expected one script file/);
});

test("run reports missing script files without a stack trace", async () => {
  const missing = join(tmpdir(), "moshcode-missing-script.mosh");
  const result = await run([missing, "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: cannot read script/);
  assert.doesNotMatch(result.stderr, /Error: moshcode run/);
});
