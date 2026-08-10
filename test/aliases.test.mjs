import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { aliasValue } from "../src/tui.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

/**
 * Drive a pit, one command per prompt.
 *
 * Not `stdin.end(everything)`: readline in non-terminal mode emits every
 * buffered line at once and only the one a `question` is waiting on survives,
 * so a pasted-in script loses all but its first command. Feeding the next line
 * when the prompt comes back is what a person does anyway, and it is the only
 * way to test a command whose effect is visible in a later one.
 *
 * $HOME is a temp dir so the suite never reads or writes the aliases of whoever
 * is running it — src/aliases.mjs derives the path per call for this reason.
 */
function runTui(lines, { home } = {}) {
  const HOME = home || mkdtempSync(join(tmpdir(), "moshcode-alias-"));
  const queue = [...(Array.isArray(lines) ? lines : [lines]), "/quit"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        // No mirror and no MOTD: this must not touch the network.
        MOSHCODE_NO_MIRROR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let seen = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // One line per prompt that has appeared but not yet been answered.
      const prompts = stdout.split("mosh ▸").length - 1;
      while (seen < prompts) {
        seen += 1;
        const next = queue.shift();
        if (next === undefined) { child.stdin.end(); return; }
        child.stdin.write(`${next}\n`);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, home: HOME }));
  });
}

const aliasesOf = (home) => JSON.parse(readFileSync(join(home, ".moshcode", "aliases.json"), "utf8"));

/* --------------------------------------------------------------- the value */

test("a fully quoted alias value loses its quotes, a bare one keeps them", () => {
  assert.equal(aliasValue('/alias set gs "git status"'), "git status");
  assert.equal(aliasValue("/alias set gs 'git status'"), "git status");
  // Bare: the quotes are the shell's, so they survive verbatim.
  assert.equal(aliasValue('/alias set gc git commit -m "wip"'), 'git commit -m "wip"');
  assert.equal(aliasValue("/alias set gs"), "");
});

/* ------------------------------------------------------------- set and run */

test("/alias set defines a shell alias that /<name> then runs", async () => {
  const result = await runTui([
    '/alias set hi "echo aliased-hello"',
    "/hi",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\/hi/);
  assert.match(result.stdout, /aliased-hello/, "the aliased shell command should have run");
  assert.deepEqual(aliasesOf(result.home), { hi: "echo aliased-hello" });
});

test("an alias appends whatever else was typed, quoting intact", async () => {
  const result = await runTui([
    '/alias set say "echo"',
    '/say "two words"',
  ]);

  assert.match(result.stdout, /two words/);
  // One argument, not two: the raw remainder reaches $SHELL -c with its quotes.
  assert.doesNotMatch(result.stdout, /two\nwords/);
});

test("a value starting with / is dispatched as a pit command", async () => {
  const result = await runTui([
    '/alias set p "/pwd"',
    "/p",
  ]);

  assert.match(result.stdout, /repo|not a git repo/, "expected /pwd's output");
});

test("aliases persist into the next pit", async () => {
  const first = await runTui('/alias set hi "echo first-run"');
  const second = await runTui("/hi", { home: first.home });
  assert.match(second.stdout, /first-run/);
});

/* -------------------------------------------------------------- guardrails */

test("/alias set refuses a name the pit already owns", async () => {
  const result = await runTui([
    '/alias set agents "echo nope"',
    '/alias set claude "echo nope"',
    // An engine's alias, not its name — /cc already opens claude, so an alias
    // by that name would be dead the moment it was defined.
    '/alias set cc "echo nope"',
    '/alias set gh "echo nope"',
  ]);

  const refusals = result.stdout.match(/already a pit command, engine, or tool/g) || [];
  assert.equal(refusals.length, 4, "pit commands, engines (and their aliases), and tools are all reserved");
});

test("/alias set refuses a name that could not be typed as a command", async () => {
  const result = await runTui([
    '/alias set "two words" "echo nope"',
    '/alias set -x "echo nope"',
  ]);

  const refusals = result.stdout.match(/isn't a usable alias name/g) || [];
  assert.equal(refusals.length, 2);
});

test("a loop between two aliases stops instead of hanging the pit", async () => {
  const result = await runTui([
    '/alias set a "/b"',
    '/alias set b "/a"',
    "/a",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /keeps expanding/);
});

test("the alias file is owner-only, like the history file", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  const result = await runTui('/alias set hi "echo x"');
  const mode = statSync(join(result.home, ".moshcode", "aliases.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a corrupt alias file reads as no aliases rather than taking the pit down", async () => {
  const home = mkdtempSync(join(tmpdir(), "moshcode-alias-"));
  mkdirSync(join(home, ".moshcode"), { recursive: true });
  writeFileSync(join(home, ".moshcode", "aliases.json"), "{ not json at all");

  const result = await runTui("/alias", { home });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no aliases yet/);
});

/* ------------------------------------------------------- list, get, remove */

test("/alias list --json prints the map, /alias rm forgets one", async () => {
  const first = await runTui([
    '/alias set hi "echo hi"',
    '/alias set agentx "/agents codex"',
    "/alias list --json",
  ]);

  const json = first.stdout.match(/\{[\s\S]*?\}/);
  assert.ok(json, "expected a JSON object");
  assert.deepEqual(JSON.parse(json[0]), { agentx: "/agents codex", hi: "echo hi" });

  const second = await runTui(["/alias rm hi", "/alias get hi"], { home: first.home });
  assert.match(second.stdout, /forgot/);
  assert.match(second.stdout, /no alias named "hi"/);
  assert.deepEqual(aliasesOf(first.home), { agentx: "/agents codex" });
});

test("/alias <name> <value> defines one without the set verb", async () => {
  const result = await runTui(['/alias hi "echo shorthand"', "/hi"]);
  assert.match(result.stdout, /shorthand/);
});

test("/help alias explains the shell-versus-pit rule", async () => {
  const result = await runTui("/help alias");
  assert.match(result.stdout, /runs in \$SHELL unless it starts with \//);
});
