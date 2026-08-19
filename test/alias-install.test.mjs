// `/alias install <tool>` — the pit adopting the shortcuts a workflow tool
// offers, without ever letting the tool write ~/.moshcode/aliases.json itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeAliases } from "../src/aliases.mjs";
import { TOOLS, adoptAliasLines, readToolAliases, toolsWithAliases } from "../src/tools.mjs";

const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));

/* --------------------------------------------------------- reading a tool */

/** A spawnSync stand-in that answers with whatever this test wants. */
const answers = ({ stdout = "", stderr = "", status = 0, error = null }) => () =>
  ({ stdout, stderr, status, error });

test("readToolAliases parses the tool's JSON", () => {
  const result = readToolAliases(TOOLS["cli-tools"], {
    run: answers({ stdout: '{"blog":"blog-post","free":"domainfree"}' }),
  });
  assert.deepEqual(result, { ok: true, aliases: { blog: "blog-post", free: "domainfree" } });
});

test("readToolAliases reports rather than throws when the tool misbehaves", () => {
  const cases = [
    [{ stdout: "not json" }, /didn't print JSON/],
    [{ stdout: "[1,2]" }, /not a set of aliases/],
    [{ status: 127, stderr: "command not found" }, /command not found/],
    [{ error: new Error("spawn ENOENT") }, /ENOENT/],
  ];
  for (const [reply, expected] of cases) {
    const result = readToolAliases(TOOLS["cli-tools"], { run: answers(reply) });
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
  }
});

test("a tool that declares no aliases says so instead of being probed", () => {
  let ran = false;
  const result = readToolAliases(TOOLS.railway, { run: () => { ran = true; return {}; } });
  assert.equal(result.ok, false);
  assert.equal(ran, false, "an undeclared tool must never be executed on a guess");
});

test("the --all roster is exactly the tools that declare aliases", () => {
  const keys = toolsWithAliases().map(([key]) => key);
  assert.ok(keys.includes("cli-tools"));
  assert.ok(!keys.includes("railway"));
  for (const key of keys) assert.ok(TOOLS[key].aliases, `${key} should declare an aliases spec`);
});

/* ------------------------------------------------------------ the merge */

/**
 * Run one merge against an empty, throwaway aliases file.
 *
 * src/aliases.mjs derives the path from the home directory on every call for
 * exactly this reason. Without the swap these read — and, on any name the
 * proposal adds, *write* — the aliases of whoever is running the suite.
 */
function inFreshHome(fn) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = mkdtempSync(join(tmpdir(), "moshcode-merge-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try { return fn(home); }
  finally {
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
  }
}

test("mergeAliases refuses names the pit already owns", () => {
  inFreshHome(() => {
    const result = mergeAliases(
      { blog: "blog-post", agents: "echo nope" },
      { isReserved: (name) => name === "agents" },
    );
    assert.deepEqual(result.added.map((a) => a.name), ["blog"]);
    assert.deepEqual(result.refused.map((a) => a.name), ["agents"]);
  });
});

test("mergeAliases keeps an existing line and reports which one", () => {
  inFreshHome((home) => {
    mkdirSync(join(home, ".moshcode"), { recursive: true });
    writeFileSync(join(home, ".moshcode", "aliases.json"), '{"prs":"gh-prs-all"}\n');
    const result = mergeAliases({ prs: "gh-prs", free: "domainfree" });
    assert.deepEqual(result.added.map((a) => a.name), ["free"]);
    assert.deepEqual(result.kept, [{ name: "prs", value: "gh-prs-all", proposed: "gh-prs" }]);
    assert.equal(aliasesOf(home).prs, "gh-prs-all");
  });
});

test("mergeAliases refuses a value that isn't a single usable line", () => {
  inFreshHome(() => {
    const result = mergeAliases({ a: "", b: "one\ntwo", c: 42, d: "x".repeat(5000) });
    assert.equal(result.added.length, 0);
    assert.deepEqual(result.refused.map((a) => a.name).sort(), ["a", "b", "c", "d"]);
  });
});

test("mergeAliases writes at most MAX_PROPOSED and says what it dropped", () => {
  inFreshHome(() => {
    const flood = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`n${String(i).padStart(3, "0")}`, "echo x"]),
    );
    const result = mergeAliases(flood);
    assert.equal(result.dropped, 36);
    assert.equal(result.added.length, 64);
  });
});

test("mergeAliases treats anything that isn't an object as no aliases at all", () => {
  inFreshHome(() => {
    for (const bad of [null, [1, 2], "blog", 7]) {
      const result = mergeAliases(bad);
      assert.equal(result.ok, false);
      assert.equal(result.added.length, 0);
    }
  });
});

/* -------------------------------------------------- at the end of install */

test("adoptAliasLines says what an install added, and nothing when there is nothing", () => {
  inFreshHome(() => {
    const lines = adoptAliasLines("cli-tools", TOOLS["cli-tools"], {
      read: () => ({ ok: true, aliases: { blog: "blog-post", free: "domainfree" } }),
    });
    assert.match(lines.join("\n"), /2 pit aliases/);
    assert.match(lines.join("\n"), /\/blog → blog-post/);

    // Second run: everything is already there, so an install prints nothing.
    const again = adoptAliasLines("cli-tools", TOOLS["cli-tools"], {
      read: () => ({ ok: true, aliases: { blog: "blog-post", free: "domainfree" } }),
    });
    assert.deepEqual(again, []);
  });
});

test("adoptAliasLines stays silent for a tool that offers none, and never runs it", () => {
  inFreshHome(() => {
    let ran = false;
    assert.deepEqual(adoptAliasLines("railway", TOOLS.railway, { read: () => { ran = true; return {}; } }), []);
    assert.equal(ran, false);
  });
});

test("a failing tool never turns a successful install into an error", () => {
  inFreshHome(() => {
    for (const answer of [{ ok: false, error: "not installed" }, { ok: true, aliases: {} }]) {
      assert.deepEqual(adoptAliasLines("cli-tools", TOOLS["cli-tools"], { read: () => answer }), []);
    }
  });
});

test("adoptAliasLines reaches a real tool on PATH, and keeps your own line", () => {
  inFreshHome((home) => {
    const previousPath = process.env.PATH;
    const binDir = join(home, "fakebin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, "cli-tools");
    writeFileSync(fake, '#!/bin/sh\necho \'{"blog":"blog-post","prs":"gh-prs"}\'\n');
    chmodSync(fake, 0o755);
    mkdirSync(join(home, ".moshcode"), { recursive: true });
    writeFileSync(join(home, ".moshcode", "aliases.json"), '{"prs":"gh-prs-all"}\n');
    process.env.PATH = `${binDir}:${previousPath}`;
    try {
      const lines = adoptAliasLines("cli-tools", TOOLS["cli-tools"]).join("\n");
      assert.match(lines, /1 pit alias:/);
      assert.match(lines, /\/blog → blog-post/);
      assert.match(lines, /kept 1 you had already bound/);
      assert.equal(aliasesOf(home).prs, "gh-prs-all");
    } finally { process.env.PATH = previousPath; }
  });
});

/* ------------------------------------------------------------ in the pit */

/**
 * Drive a pit with a fake `cli-tools` first on PATH.
 *
 * A fake rather than the real one because the assertion is about what the pit
 * does with a tool's answer, and a suite that only passes on a machine where
 * profullstack/cli-tools happens to be installed is a suite that reports the
 * wrong thing on CI.
 *
 * One line per prompt: readline in non-terminal mode drops every buffered line
 * but the one a `question` is waiting on. Same reason as test/aliases.test.mjs.
 */
function runTui(lines, { home, toolStdout = '{"blog":"blog-post","free":"domainfree"}', toolStatus = 0 } = {}) {
  const HOME = home || mkdtempSync(join(tmpdir(), "moshcode-alias-install-"));
  const binDir = join(HOME, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "cli-tools");
  writeFileSync(fake, `#!/bin/sh\ncat <<'JSON'\n${toolStdout}\nJSON\nexit ${toolStatus}\n`);
  chmodSync(fake, 0o755);

  const queue = [...(Array.isArray(lines) ? lines : [lines]), "/quit"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        PATH: `${binDir}:${process.env.PATH}`,
        MOSHCODE_NO_MIRROR: "1",
      },
    });
    let stdout = "";
    let seen = 0;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const prompts = stdout.split("mosh ▸").length - 1;
      while (seen < prompts) {
        seen += 1;
        const next = queue.shift();
        if (next === undefined) { child.stdin.end(); return; }
        child.stdin.write(`${next}\n`);
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, home: HOME }));
  });
}

const aliasesOf = (home) => JSON.parse(readFileSync(join(home, ".moshcode", "aliases.json"), "utf8"));

test("/alias install adopts a tool's aliases, and /<name> then runs one", async () => {
  const result = await runTui([
    "/alias install cli-tools",
    "/alias get blog",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\/blog/);
  assert.match(result.stdout, /blog-post/);
  assert.deepEqual(aliasesOf(result.home), { blog: "blog-post", free: "domainfree" });
});

test("/alias install never overwrites a name you bound yourself", async () => {
  const first = await runTui('/alias set blog "blog-post --mine"');
  const second = await runTui("/alias install cli-tools", { home: first.home });

  assert.match(second.stdout, /kept your own/);
  assert.equal(aliasesOf(second.home).blog, "blog-post --mine", "the operator's line must survive");
  assert.equal(aliasesOf(second.home).free, "domainfree", "the rest should still be adopted");
});

test("/alias install is idempotent", async () => {
  const first = await runTui("/alias install cli-tools");
  const second = await runTui("/alias install cli-tools", { home: first.home });
  assert.deepEqual(aliasesOf(second.home), aliasesOf(first.home));
});

test("/alias install reports a tool that fails instead of writing anything", async () => {
  const result = await runTui("/alias install cli-tools", { toolStdout: "boom", toolStatus: 1 });
  assert.match(result.stdout, /cli-tools/);
  assert.doesNotMatch(result.stdout, /✓ \/blog/);
});

test("/alias install names an unknown tool rather than defining an alias for it", async () => {
  const result = await runTui("/alias install nosuchtool");
  assert.match(result.stdout, /no tool named/);
});

test("/tools install <name> routes to the installer, not to a tool called install", async () => {
  // An unknown target, so nothing is ever downloaded: the assertion is only
  // that the words reached installTarget, whose refusal names engines *and*
  // tools — where resolveTool's would have been `unknown tool "install"`,
  // pointing at the wrong word entirely.
  const result = await runTui("/tools install nosuchtool");
  assert.match(result.stdout, /unknown engine or tool/);
  assert.doesNotMatch(result.stdout, /unknown tool "install"/);
});

test('"install" is a verb, so it never becomes an alias called install', async () => {
  const result = await runTui(["/alias install cli-tools", "/alias list"]);
  assert.ok(!Object.hasOwn(aliasesOf(result.home), "install"));
});
