import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
const ESC = String.fromCharCode(27);

/** Drop SGR colour codes so assertions match the words, not the styling. */
const strip = (s) => s.split(new RegExp(ESC + "\\[[0-9;]*m", "g")).join("");

/** Everything the REPL printed after the banner, i.e. in response to commands. */
const replied = (out) => strip(out).split("to leave")[1] || "";

// An empty directory to hand the child as its whole PATH.
//
// /prd hands the published PRD to an installed engine to author, and
// engineStatus() decides "installed" purely by walking PATH. So on a developer's
// machine — where `claude` is on PATH — the healthy-cwd control below really did
// launch Claude and block until it finished authoring: one test, seven minutes,
// real tokens, a different result on every run. On CI, where no engine is
// installed, the same test took under a second. A test whose behaviour flips on
// whether the person running it happens to have Claude installed is not a test.
//
// node itself is spawned via process.execPath (absolute), so an empty PATH costs
// the child nothing else.
const NO_ENGINES = mkdtempSync(join(tmpdir(), "moshcode-no-engines-"));

function runTui(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env, PATH: NO_ENGINES },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** A cwd where prd/ cannot be created: the name is taken by a regular file. */
function cwdWithPrdBlocked() {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-prd-blocked-"));
  writeFileSync(join(dir, "prd"), "a regular file, not the PRD directory\n");
  return dir;
}

test("TUI /prd reports a filesystem failure instead of crashing the session", async () => {
  const result = await runTui("/prd ship a better cli\n/quit\n", cwdWithPrdBlocked());
  assert.equal(result.status, 0, "the REPL should exit normally, not die on the throw");
  assert.equal(result.signal, null);
  assert.match(replied(result.stdout), /can't publish the PRD/);
});

test("TUI /prd does not leak a raw filesystem stack trace", async () => {
  const result = await runTui("/prd ship a better cli\n/quit\n", cwdWithPrdBlocked());
  assert.doesNotMatch(result.stderr, /\n\s+at /, "a stack trace means the throw went unhandled");
  assert.doesNotMatch(result.stderr, /node:fs/);
});

test("TUI /prd surfaces the underlying reason for the failure", async () => {
  const result = await runTui("/prd ship a better cli\n/quit\n", cwdWithPrdBlocked());
  // Keep the OS error in the message so the user can tell a taken path from a
  // read-only checkout, matching how /run reports an unreadable script.
  assert.match(replied(result.stdout), /EEXIST|ENOTDIR|EACCES/);
});

test("TUI /prd fails the same shape as the guarded /run sibling", async () => {
  const bad = cwdWithPrdBlocked();
  const prd = await runTui("/prd ship a better cli\n/quit\n", bad);
  const run = await runTui("/run /nonexistent/missing.mosh\n/quit\n", bad);
  // /run already reports and returns to the prompt; /prd should be no different.
  assert.equal(run.status, 0);
  assert.equal(prd.status, run.status);
  assert.match(replied(run.stdout), /can't read/);
  assert.match(replied(prd.stdout), /can't publish/);
});

// --- controls: these hold both before and after the fix ---

test("TUI /prd still publishes a PRD in a healthy cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-prd-ok-"));
  const result = await runTui("/prd ship a better cli\n/quit\n", dir);
  assert.equal(result.status, 0);
  const out = replied(result.stdout);
  assert.match(out, /bootstrapped/);
  assert.match(out, /published prd\/0001-ship-a-better-cli\.md/);
  assert.doesNotMatch(out, /can't publish/);
  assert.deepEqual(
    readdirSync(join(dir, "prd")).sort(),
    ["0000-template.md", "0001-ship-a-better-cli.md", "README.md"],
  );
  // Publishing is what this control covers, and publishing is done by here. With
  // no engine on PATH the session says so and returns to the prompt instead of
  // handing off — the assertion that keeps this test from quietly going back to
  // spawning a real engine for seven minutes.
  assert.match(out, /open an engine to fill it in/);
  assert.doesNotMatch(out, /handing .* to .* to author/);
});

test("TUI /prd with no argument lists PRDs and survives a blocked prd path", async () => {
  // listPrds() already swallows the readdir failure, so the read-only path was
  // never the broken one. Asserting it keeps the fix scoped to the write path.
  const result = await runTui("/prd\n/quit\n", cwdWithPrdBlocked());
  assert.equal(result.status, 0);
  assert.match(replied(result.stdout), /no PRDs yet/);
});

test("TUI startup is unaffected by a blocked prd path", async () => {
  const result = await runTui("/quit\n", cwdWithPrdBlocked());
  assert.equal(result.status, 0);
  assert.match(strip(result.stdout), /moshcode v/);
  assert.match(strip(result.stdout), /to leave/);
});
