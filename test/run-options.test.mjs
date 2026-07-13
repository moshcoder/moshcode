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

test("run accepts equals-form max option", async () => {
  const result = await run(["--max=1", "--dry-run"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 loop\(s\)/);
});

test("run() includes another .mosh file, in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-include-"));
  const child = join(dir, "child.mosh");
  const parent = join(dir, "parent.mosh");
  writeFileSync(child, 'say("from the child 🤘");\n');
  writeFileSync(parent, `say("parent before");\nrun(${JSON.stringify(child)});\nsay("parent after");\n`);

  const result = await run([parent]);

  assert.equal(result.status, 0);
  // ordering: parent before → child → parent after
  const before = result.stdout.indexOf("parent before");
  const inChild = result.stdout.indexOf("from the child");
  const after = result.stdout.indexOf("parent after");
  assert.ok(before >= 0 && inChild > before && after > inChild, result.stdout);
});

test("positional args after the script file reach the script as argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-run-"));
  const script = join(dir, "argv.mosh");
  // secretly all JS is legal — read argv straight off the injected global
  writeFileSync(script, 'say(argv[0]); say(argv[1]);\n');

  const result = await run([script, "staging", "--fast"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /staging/);
  assert.match(result.stdout, /--fast/);
});

test("run reports missing script files without a stack trace", async () => {
  const missing = join(tmpdir(), "moshcode-missing-script.mosh");
  const result = await run([missing, "--dry-run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /moshcode run: cannot read script/);
  assert.doesNotMatch(result.stderr, /Error: moshcode run/);
});
