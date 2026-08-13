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
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { ENGINES, agentLaunchArgs, aiExecArgs, exitReason, isInstalled, openPassthrough, pickAiEngine, ranOk, resolveEngine, runCmd } from "../src/engines.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
// The autonomous-session bypass flags each engine declares (engine.agentArgs).
const EXPECTED_AGENT_ARGS = {
  opencode: ["--auto"],
  privacycode: ["--auto"],
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--approval-mode=yolo"],
  kimi: ["--yolo"],
  qwen: ["--approval-mode=yolo"],
  deepseek: ["--turbo"],
  openagents: [], // a launcher, not an agent: nothing of its own to auto-approve
  aider: ["--yes-always"],
};

// What an agent-mode launch actually runs (agentLaunchArgs): the engine's native
// interactive agents view where it has one, else its autonomous bypass flags.
// `opencode agent list` and `privacycode agent list` print data and exit, so
// those are not interactive views and must not be used here.
const EXPECTED_LAUNCH_ARGS = {
  opencode: ["--auto"],
  privacycode: ["--auto"],
  claude: ["agents", "--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--approval-mode=yolo"],
  kimi: ["--yolo"], // no agents view — kimi has no agent list to land on
  qwen: ["--approval-mode=yolo"],
  deepseek: ["--turbo"],
  openagents: [], // bare launch opens the dashboard, which is its agent list
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
  // The stub has to be named after the engine's *binary*, which is not always
  // the engine's name — deepseek launches `deepseek-code`. Writing a stub called
  // `deepseek` would leave nothing on PATH for moshcode to find.
  const stub = ENGINES[key].bin;

  test(`agents ${key} injects its agent-launch args before user arguments`, async () => {
    const nativeBin = tempDir();
    mkdirSync(nativeBin, { recursive: true });
    writeEngine(nativeBin, stub);

    const result = await run(["agents", key, "--user-arg", "two words"], nativeBin);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [...expected, "--user-arg", "two words"]);
    assert.match(result.stderr, /agent mode:/);
  });

  test(`start ${key} injects no arguments`, async () => {
    const nativeBin = tempDir();
    mkdirSync(nativeBin, { recursive: true });
    writeEngine(nativeBin, stub);

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

test("executable lookup searches a tool's own install dir when PATH misses it", async () => {
  // turso's installer unpacks to $HOME/.turso and only appends that dir to the
  // shell profile, so PATH alone reports it missing — and /turso fails to launch
  // it — in the session that installed it. binDirs closes that gap.
  const dir = tempDir("moshcode-bindirs-");
  const file = path.join(dir, "faketool");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);

  assert.equal(isInstalled("faketool"), false, "not on PATH");
  assert.equal(isInstalled("faketool", [dir]), true, "found in the install dir");
  // A missing/absent extra dir is inert, not a crash.
  assert.equal(isInstalled("faketool", [path.join(dir, "nope")]), false);
  assert.equal(isInstalled("faketool", []), false);

  const r = await openPassthrough({ bin: "faketool", binDirs: [dir] });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
});

test("curl-installed engines declare their installer bin directories", () => {
  assert.deepEqual(ENGINES.opencode.binDirs, [path.join(homedir(), ".opencode", "bin")]);
  assert.deepEqual(ENGINES.privacycode.binDirs, [path.join(homedir(), ".privacycode", "bin")]);
  assert.deepEqual(ENGINES.kimi.binDirs, [path.join(homedir(), ".kimi-code", "bin")]);
});

test("PATH still wins over a tool's install dir", async () => {
  // Two copies, different exit codes: whichever one runs identifies itself.
  const pathDir = tempDir("moshcode-bindirs-path-");
  const installDir = tempDir("moshcode-bindirs-home-");
  for (const [dir, code] of [[pathDir, 3], [installDir, 4]]) {
    const file = path.join(dir, "faketool2");
    writeFileSync(file, `#!/bin/sh\nexit ${code}\n`);
    chmodSync(file, 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = `${pathDir}${path.delimiter}${previous || ""}`;
  try {
    const r = await openPassthrough({ bin: "faketool2", binDirs: [installDir] });
    assert.equal(r.code, 3, "the PATH copy runs, not the install-dir fallback");
  } finally {
    process.env.PATH = previous;
  }
});
