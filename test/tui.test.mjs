import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("TUI /run rejects unknown options before reading a script file", async () => {
  const result = await runTui("/run --dryrun\n/quit\n");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /unknown option --dryrun/);
  assert.doesNotMatch(result.stdout, /can't read --dryrun/);
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

// Piped stdin is delivered in chunks and readline emits every line of a chunk
// at once, so a one-shot `rl.question` used to see the first line and drop the
// rest — the loop then waited forever on input that had already gone by. Every
// command after the first was silently skipped, /quit included, and the process
// still exited 0.
test("TUI runs every command from piped stdin, not just the first", async () => {
  const result = await runTui("/run --dryrun\n/run --nope\n/pwd\n/quit\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /unknown option --dryrun/);
  assert.match(result.stdout, /unknown option --nope/);
  assert.match(result.stdout, /code hard, mosh harder/); // /quit was reached
});

test("TUI leaves cleanly when piped input ends without /quit", async () => {
  const result = await runTui("/run --dryrun\n");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /unknown option --dryrun/);
  assert.match(result.stdout, /code hard, mosh harder/);
});
