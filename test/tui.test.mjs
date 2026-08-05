import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("TUI /agents --json prints machine-readable engine status", async () => {
  const result = await runTui("/agents --json\n/quit\n");

  assert.equal(result.status, 0);
  const json = result.stdout.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  assert.ok(json, "expected a JSON status array");
  const statuses = JSON.parse(json[0]);
  assert.ok(statuses.some(({ name }) => name === "claude"));
  for (const status of statuses) {
    assert.deepEqual(Object.keys(status), ["name", "description", "binary", "installed"]);
    assert.equal(typeof status.name, "string");
    assert.equal(typeof status.description, "string");
    assert.equal(typeof status.binary, "string");
    assert.equal(typeof status.installed, "boolean");
  }
  assert.doesNotMatch(result.stdout, /unknown engine "--json"/);
});

test("TUI /run rejects unknown options before reading a script file", async () => {
  const result = await runTui("/run --dryrun\n/quit\n");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /unknown option --dryrun/);
  assert.doesNotMatch(result.stdout, /can't read --dryrun/);
});

test("TUI /run rejects unsafe iteration limits", async () => {
  const result = await runTui("/run --max=9007199254740992\n/quit\n");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--max needs a positive integer/);
  assert.doesNotMatch(result.stdout, /usage: \/run/);
});

test("TUI /run preserves option-like script args after --", () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-tui-separator-"));
  const script = join(dir, "argv.mosh");
  writeFileSync(script, "say(JSON.stringify(argv));\n");
  const scriptArg = script.replaceAll("\\", "/");

  const result = spawnSync(
    process.execPath,
    ["bin/moshcode.mjs"],
    {
      cwd: join(import.meta.dirname, ".."),
      input: `/run "${scriptArg}" -- --max 2 --dry-run -n\n/quit\n`,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /dry run .* narrating/);
  assert.match(result.stdout, /\["--max","2","--dry-run","-n"\]/);
});

test("TUI /run passes positional args through to moshscript argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "moshcode-tui-"));
  mkdirSync(join(dir, "space dir"));
  const script = join(dir, "space dir", "argv.mosh");
  writeFileSync(script, 'say(argv[0]); say(argv[1]);\n');
  const scriptArg = script.replaceAll("\\", "/");

  const result = spawnSync(
    process.execPath,
    ["bin/moshcode.mjs"],
    {
      cwd: join(import.meta.dirname, ".."),
      input: `/run "${scriptArg}" alpha "two words"\n/quit\n`,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /alpha/);
  assert.match(result.stdout, /two words/);
});

// `/shell <cmd>` and `!<cmd>` are the same feature — both hand the command to
// `$SHELL -c`, which does its own parsing. Re-joining the tokenized parts drops
// the user's quotes, so `-m "two words"` reaches the shell as two arguments.
const posixShell = process.platform === "win32" ? { skip: "needs a POSIX shell" } : {};

test("TUI /shell hands the raw command line to the shell, quoting intact", posixShell, async () => {
  const result = await runTui('/shell printf "[%s]\\n" "two words"\n/quit\n');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[two words\]/);
  assert.doesNotMatch(result.stdout, /\[two\]/);
});

test("TUI /shell and !cmd run an identical command identically", posixShell, async () => {
  const command = 'printf "[%s]\\n" "two words"';
  const bracketed = (out) => out.match(/\[[^\]\n]*\]/g) || [];

  const viaSlash = await runTui(`/shell ${command}\n/quit\n`);
  const viaBang = await runTui(`!${command}\n/quit\n`);

  assert.equal(viaSlash.status, 0);
  assert.equal(viaBang.status, 0);
  assert.deepEqual(bracketed(viaSlash.stdout), bracketed(viaBang.stdout));
});

// ENGINES/TOOLS are plain object literals, so an unknown target that happens to
// name an Object.prototype member used to resolve truthy and reach `.install`,
// killing the whole pit with a raw TypeError instead of printing the usual
// unknown-target line.
test("TUI /install rejects an Object.prototype name instead of crashing the pit", async () => {
  const result = await runTui("/install constructor\n/quit\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /unknown engine or tool "constructor"/);
  assert.doesNotMatch(result.stderr, /TypeError/);
});

test("TUI /new requires a real terminal", async () => {
  const result = await runTui("/new\n/quit\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\/new needs an interactive terminal/);
});

// The pit persists every line typed at the prompt to ~/.moshcode_history, and
// the documented flows put secrets on those lines (`/mcp install <url> -H
// "Authorization: Bearer …"`, `/secrets`, `/coinpay`, `!export TOKEN=…`). The
// file must be owner-only, the way credentials.json already is.
const posixMode = { skip: process.platform === "win32" ? "POSIX permission bits" : false };

function runTuiWithHome(home, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: home, USERPROFILE: home },
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

test("TUI writes the command history owner-only", posixMode, async () => {
  const home = mkdtempSync(join(tmpdir(), "moshcode-history-"));

  const result = await runTuiWithHome(home, "/quit\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const file = join(home, ".moshcode_history");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("TUI tightens a history file that was already world-readable", posixMode, async () => {
  const home = mkdtempSync(join(tmpdir(), "moshcode-history-"));
  const file = join(home, ".moshcode_history");
  writeFileSync(file, "/mcp install https://mcp.example.com/sse -H \"Authorization: Bearer sk-live\"\n");
  chmodSync(file, 0o644);

  const result = await runTuiWithHome(home, "/quit\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, "utf8"), /Bearer sk-live/); // history itself survives
});
