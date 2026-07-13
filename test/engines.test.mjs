import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { ENGINES, agentLaunchArgs } from "../src/engines.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
const EXPECTED_AGENT_ARGS = {
  opencode: ["--auto"],
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--approval-mode=yolo"],
  aider: ["--yes-always"],
};

function tempDir(prefix = "moshcode-engines-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeEngine(dir, name) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)));
`);
  chmodSync(file, 0o755);
}

function run(args, binDir) {
  return new Promise((resolve, reject) => {
    const ioDir = tempDir("moshcode-engine-stdio-");
    const stdinFile = path.join(ioDir, "stdin");
    const stdoutFile = path.join(ioDir, "stdout");
    const stderrFile = path.join(ioDir, "stderr");
    writeFileSync(stdinFile, "");
    const stdin = openSync(stdinFile, "r");
    const stdout = openSync(stdoutFile, "w");
    const stderr = openSync(stderrFile, "w");
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: [stdin, stdout, stderr],
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
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

test("every engine declares its reviewed autonomous-mode arguments", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ENGINES).map(([key, engine]) => [key, engine.agentArgs])),
    EXPECTED_AGENT_ARGS,
  );
  for (const [key, engine] of Object.entries(ENGINES)) {
    assert.deepEqual(agentLaunchArgs(engine, ["--user-arg", "two words"]), [
      ...EXPECTED_AGENT_ARGS[key],
      "--user-arg",
      "two words",
    ]);
  }
});

for (const [key, expected] of Object.entries(EXPECTED_AGENT_ARGS)) {
  test(`agents ${key} injects autonomous flags before user arguments`, async () => {
    const nativeBin = tempDir();
    mkdirSync(nativeBin, { recursive: true });
    writeEngine(nativeBin, key);

    const result = await run(["agents", key, "--user-arg", "two words"], nativeBin);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [...expected, "--user-arg", "two words"]);
    assert.match(result.stderr, /agent mode:/);
  });

  test(`start ${key} injects no arguments`, async () => {
    const nativeBin = tempDir();
    mkdirSync(nativeBin, { recursive: true });
    writeEngine(nativeBin, key);

    const result = await run(["start", key, "--user-arg", "two words"], nativeBin);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), ["--user-arg", "two words"]);
    assert.equal(result.stderr, "");
  });
}

test("bare engine launch remains a raw passthrough", async () => {
  const nativeBin = tempDir();
  mkdirSync(nativeBin, { recursive: true });
  writeEngine(nativeBin, "claude");

  const result = await run(["claude", "--model", "sonnet"], nativeBin);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["--model", "sonnet"]);
  assert.equal(result.stderr, "");
});
