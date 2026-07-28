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

import { ENGINES, agentLaunchArgs, aiExecArgs, exitReason, pickAiEngine, ranOk, resolveEngine, runCmd } from "../src/engines.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
// The autonomous-session bypass flags each engine declares (engine.agentArgs).
const EXPECTED_AGENT_ARGS = {
  opencode: ["--auto"],
  privacycode: ["--auto"],
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--approval-mode=yolo"],
  aider: ["--yes-always"],
};

// What an agent-mode launch actually runs (agentLaunchArgs): the engine's native
// agents-view invocation where it has one, else its autonomous bypass flags.
const EXPECTED_LAUNCH_ARGS = {
  opencode: ["agent", "list"],
  privacycode: ["agent", "list"],
  claude: ["agents", "--dangerously-skip-permissions"],
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
      ...EXPECTED_LAUNCH_ARGS[key],
      "--user-arg",
      "two words",
    ]);
  }
});

for (const [key, expected] of Object.entries(EXPECTED_LAUNCH_ARGS)) {
  test(`agents ${key} injects its agent-launch args before user arguments`, async () => {
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

test("a signal-killed child is a failure, not a codeless success", async () => {
  const r = await runCmd("bash", ["-c", "kill -9 $$"]);

  // Node reports a signal death with code === null — the old `code == null`
  // success check read that as "exited cleanly".
  assert.equal(r.ok, true);
  assert.equal(r.code, null);
  assert.equal(r.signal, "SIGKILL");

  assert.equal(ranOk(r), false);
  assert.equal(exitReason(r), "SIGKILL");
});

test("ranOk and exitReason cover clean exits, bad codes, and spawn errors", async () => {
  const clean = await runCmd("bash", ["-c", "exit 0"]);
  assert.equal(ranOk(clean), true);
  assert.equal(exitReason(clean), null);

  const bad = await runCmd("bash", ["-c", "exit 128"]);
  assert.equal(ranOk(bad), false);
  assert.equal(exitReason(bad), "code 128");

  const missing = await runCmd("moshcode-does-not-exist-xyz", []);
  assert.equal(ranOk(missing), false);
  assert.match(exitReason(missing), /ENOENT|not found|spawn/i);
});

test("pickAiEngine resolves an engine alias, like every other engine surface", () => {
  // `/agents cc`, `moshcode start cc` and `moshcode upgrade cc` all resolve the
  // alias, so an ai() preference must too — otherwise `ai(p, { engine: "cc" })`
  // reports "needs an installed engine" with Claude sitting right there on PATH.
  const dir = tempDir("moshcode-ai-alias-");
  writeEngine(dir, "claude");
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous || ""}`;
  try {
    assert.equal(pickAiEngine("claude"), "claude");
    assert.equal(pickAiEngine("cc"), "claude");
    assert.equal(pickAiEngine("claude-code"), "claude");
    // an unknown preference is still no engine at all
    assert.equal(pickAiEngine("definitely-not-an-engine"), null);
  } finally {
    process.env.PATH = previous;
  }
});

test("engine lookup ignores inherited Object.prototype members", () => {
  // ENGINES/ALIASES/AI_EXEC are plain object literals, so an unknown name that
  // matches an Object.prototype member must not resolve as a real engine.
  assert.equal(resolveEngine("constructor"), null);
  assert.equal(resolveEngine("__proto__"), null);
  assert.equal(pickAiEngine("constructor"), null);
  assert.throws(() => aiExecArgs("constructor", "hi"), /no headless mode for "constructor"/);
});
