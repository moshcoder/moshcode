// `--help` at every level, and the promise that it changes nothing.
//
// The failure this file exists to prevent is not a typo in a usage string. It
// is `moshcode prd --help` *publishing a document* — `--help` was read as the
// PRD's idea, so asking how the command worked ran it. That is why the
// no-side-effect tests spawn the real binary against a real temp directory
// rather than importing and asserting on a return value: the bug was in
// dispatch, and dispatch is what has to be exercised.
//
// The rest is the uniformity the PRD asks for (0006): one stream, one exit
// code, one shape, at every depth.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  CORE_CLI_COMMANDS, MCP_VERBS, SKILL_VERBS, UPGRADE_TARGETS, DNS_VERBS,
} from "../src/cli-schema.mjs";
import {
  WIDTH, findCommand, findPitCommand, helpModel, pitHelpModel, renderCommand, renderOverview,
  renderPitCommand, suggest, wantsHelp, wrap,
} from "../src/help.mjs";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Run the real CLI and hand back both streams and the code, never throwing. */
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { cwd: ROOT, ...options });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/* ------------------------------------------------------------------ R1: total */

test("help is recognised at the top level, in every spelling", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const { code, stdout, stderr } = await cli([flag]);
    assert.equal(code, 0, `${flag} exited ${code}`);
    assert.equal(stderr, "", `${flag} wrote to stderr`);
    assert.match(stdout, /usage: moshcode/, flag);
  }
});

test("every dispatched command answers --help on stdout with exit 0", async () => {
  // The uniformity claim. Before this, 5 of 9 sampled commands exited 1 and two
  // more wrote to stderr.
  const names = CORE_CLI_COMMANDS.filter((c) => !c.aliasOf && c.group).map((c) => c.name);
  assert.ok(names.length >= 20, "the schema lost commands");
  for (const name of names) {
    const { code, stdout, stderr } = await cli([name, "--help"]);
    assert.equal(code, 0, `${name} --help exited ${code}: ${stderr}`);
    assert.equal(stderr, "", `${name} --help wrote to stderr`);
    assert.match(stdout, new RegExp(`^moshcode ${name} —`), `${name} --help printed the wrong block`);
  }
});

test("help reaches sub-verbs, and does not care where the flag sits", async () => {
  const after = await cli(["mcp", "install", "--help"]);
  const before = await cli(["mcp", "--help", "install"]);
  assert.equal(after.code, 0);
  assert.match(after.stdout, /^moshcode mcp install —/);
  // R1 is explicit that recognition must not depend on flag position.
  assert.equal(before.stdout, after.stdout);
});

test("aliases resolve to what they alias, and say so", async () => {
  const { stdout } = await cli(["where", "--help"]);
  assert.match(stdout, /^moshcode pwd —/, "an alias should answer as its target");
  assert.match(stdout, /aliases: where/, "and name itself as an alias");
});

/* ---------------------------------------------------- R2: no side effects */

test("prd --help prints usage and publishes nothing", async () => {
  // The bug that motivated the PRD: `--help` was the idea, so asking for help
  // wrote prd/NNNN---help.md, committed it, and handed it to an engine.
  const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-help-prd-"));
  try {
    for (const flag of ["--help", "-h", "help"]) {
      const before = fs.readdirSync(workdir);
      const { code, stdout } = await cli(["prd", flag], { cwd: workdir });
      assert.equal(code, 0, `prd ${flag} exited ${code}`);
      assert.match(stdout, /^moshcode prd —/);
      assert.deepEqual(fs.readdirSync(workdir), before, `prd ${flag} touched the directory`);
    }
    assert.equal(fs.existsSync(path.join(workdir, "prd")), false, "a prd/ directory was created");
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

test("no command writes anything to disk when asked for help", async () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-help-clean-"));
  try {
    for (const name of ["install", "uninstall", "upgrade", "mcp", "skill", "console", "dns", "run", "site", "template"]) {
      const { code } = await cli([name, "--help"], { cwd: workdir });
      assert.equal(code, 0, `${name} --help exited ${code}`);
      assert.deepEqual(fs.readdirSync(workdir), [], `${name} --help wrote into the cwd`);
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- R3 / R11: failure shape */

test("an unknown command is one line on stderr, with a suggestion", async () => {
  const { code, stdout, stderr } = await cli(["instal", "claude"]);
  assert.equal(code, 1);
  assert.equal(stdout, "", "the wall went to stdout and polluted the pipe");
  assert.match(stderr, /unknown command "instal"/);
  assert.match(stderr, /did you mean install\?/);
  // Short: the old behaviour was 127 lines.
  assert.ok(stderr.split("\n").filter(Boolean).length <= 3, `stderr was ${stderr.split("\n").length} lines`);
});

test("a bad sub-verb prints that command's usage, not the whole wall", async () => {
  const { code, stdout, stderr } = await cli(["help", "mcp", "nonsense"]);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /has no verb "nonsense"/);
  assert.ok(stderr.split("\n").length <= 24, "usage block should be the command's own, and short");
});

test("an unknown help topic suggests rather than dumping", async () => {
  const { code, stderr } = await cli(["help", "instal"]);
  assert.equal(code, 1);
  assert.match(stderr, /did you mean install\?/);
});

/* ------------------------------------------------------------- R9: --json */

test("help --json is a parseable model of the whole CLI", async () => {
  const { code, stdout, stderr } = await cli(["help", "--json"]);
  assert.equal(code, 0);
  assert.equal(stderr, "", "decoration on stderr would still break a naive consumer");
  const model = JSON.parse(stdout);

  assert.equal(model.name, "moshcode");
  assert.ok(Array.isArray(model.commands) && model.commands.length >= 20);
  // Round trip: everything in the model is dispatchable, and the dispatched
  // commands are all in the model.
  const inModel = new Set(model.commands.map((c) => c.name));
  for (const c of CORE_CLI_COMMANDS.filter((x) => !x.aliasOf && x.group)) {
    assert.ok(inModel.has(c.name), `${c.name} missing from --json`);
  }
  const mcp = model.commands.find((c) => c.name === "mcp");
  assert.ok(mcp.verbs.some((v) => v.name === "install"), "sub-verbs must be in the model");
});

test("a single command answers --json too", async () => {
  const { code, stdout } = await cli(["run", "--help", "--json"]);
  assert.equal(code, 0);
  const model = JSON.parse(stdout);
  assert.equal(model.name, "run");
  assert.ok(model.flags.some((f) => f.flags.includes("--max")), "run's --max is undocumented");
  assert.equal(model.flags.find((f) => f.flags.includes("--max")).default, "3");
});

/* --------------------------------------------------------- R10: fits a screen */

test("the overview fits one screen and wraps at 80 columns", async () => {
  const { stdout } = await cli(["--help"]);
  const lines = stdout.split("\n");
  assert.ok(lines.length <= 40, `overview is ${lines.length} lines`);
  for (const line of lines) {
    assert.ok(line.length <= WIDTH, `over ${WIDTH} columns: ${JSON.stringify(line)}`);
  }
});

test("--all is still the whole wall, for the people who grep", async () => {
  const overview = await cli(["--help"]);
  const all = await cli(["help", "--all"]);
  assert.equal(all.code, 0);
  assert.ok(all.stdout.length > overview.stdout.length * 3, "--all should be substantially longer");
  assert.match(all.stdout, /moshcode console —/, "every command appears in --all");
});

test("wrap() never exceeds the width it was given", () => {
  const long = "word ".repeat(60).trim();
  for (const indent of [0, 10, 24, 44]) {
    for (const line of wrap(long, indent).split("\n")) {
      assert.ok(line.length <= WIDTH, `indent ${indent} produced ${line.length} columns`);
    }
  }
});

/* ------------------------------------------------------------ R6: no drift */

test("every dispatched command has a schema entry with a description", async () => {
  // Mirrors the completion drift test: the dispatcher is the source of truth
  // for what exists, so a verb added there without help fails the build.
  const source = fs.readFileSync(path.join(ROOT, "bin/moshcode.mjs"), "utf8");
  const dispatched = new Set([...source.matchAll(/cmd === "([^"]+)"/g)].map((m) => m[1]));
  assert.ok(dispatched.size >= 20, "the dispatch scrape found nothing — did the shape change?");

  const known = new Map(CORE_CLI_COMMANDS.map((c) => [c.name, c]));
  for (const name of dispatched) {
    const entry = known.get(name);
    assert.ok(entry, `dispatched command "${name}" has no schema entry`);
    assert.ok(entry.description?.length, `"${name}" has no description`);
  }
});

test("every sub-verb has a description", () => {
  for (const [label, table] of [["mcp", MCP_VERBS], ["skill", SKILL_VERBS], ["upgrade", UPGRADE_TARGETS], ["dns", DNS_VERBS]]) {
    for (const verb of table) {
      assert.ok(verb.description?.length, `${label} ${verb.name} has no description`);
    }
  }
});

test("every non-alias command renders a synopsis and a see-also", () => {
  for (const command of CORE_CLI_COMMANDS.filter((c) => !c.aliasOf && c.group)) {
    const text = renderCommand(command);
    assert.match(text, /usage:/, `${command.name} has no synopsis`);
    assert.ok(text.includes("see also:") || command.name === "help", `${command.name} has no see-also`);
  }
});

test("flags that the dispatcher parses are documented", () => {
  // The discoverability claim from the PRD's success metrics. Scoped to the
  // flags it names, because a blanket grep of every string starting with `--`
  // also finds the ones being *passed through* to other tools.
  const model = helpModel({});
  const documented = new Set();
  for (const command of model.commands) {
    for (const flag of command.flags) for (const f of flag.flags.split(/[ ,]+/)) documented.add(f.replace(/[<>].*$/, "").trim());
    for (const verb of command.verbs) {
      for (const flag of verb.flags) for (const f of flag.flags.split(/[ ,]+/)) documented.add(f.replace(/[<>].*$/, "").trim());
    }
  }
  for (const flag of ["--json", "--max", "-n", "--dry-run", "--yes", "-y", "--device", "-d",
    "--browser", "-b", "--port", "--bind", "--ttyd", "--url", "--name", "-t", "-e", "-H",
    "--registry", "--check", "--nginx", "--all"]) {
    assert.ok(documented.has(flag), `${flag} is parsed somewhere but documented nowhere`);
  }
});

/* -------------------------------------------------------------- pure units */

test("wantsHelp stops at the moshscript filename", () => {
  // `moshcode run --help` is the runner's question; after the file it is the
  // script's argv and the runner must not claim it.
  assert.equal(wantsHelp(["--help"], { stopAt: true }), true);
  assert.equal(wantsHelp(["--dry-run", "--help"], { stopAt: true }), true);
  assert.equal(wantsHelp(["script.mosh", "--help"], { stopAt: true }), false);
  assert.equal(wantsHelp(["script.mosh", "--help"]), true, "without the boundary it is just a flag");
});

test("suggest is tight enough to stay useful", () => {
  assert.equal(suggest("instal"), "install");
  assert.equal(suggest("upgrad"), "upgrade");
  assert.equal(suggest("agent"), "agents");
  // A wrong suggestion is worse than none — it sends people to a second wrong
  // command.
  assert.equal(suggest("xyzzy"), null);
  assert.equal(suggest(""), null);
});

test("findCommand resolves aliases and rejects strangers", () => {
  assert.equal(findCommand("where").name, "pwd");
  assert.equal(findCommand("update").name, "upgrade");
  assert.equal(findCommand("PWD").name, "pwd");
  assert.equal(findCommand("nope"), null);
});

test("the overview names every group that has commands", () => {
  const text = renderOverview({ engines: ["claude"], tools: ["gh"] });
  for (const group of ["engines", "tools", "extend", "script", "account", "hosting", "system"]) {
    assert.match(text, new RegExp(`\\b${group}\\b`), `group ${group} missing from the overview`);
  }
});

/* -------------------------------------------------------------- R12: the pit */

test("the pit's help lists every command the pit dispatches", () => {
  // Same drift guard as the CLI's, against the pit's own loop: a `/verb` added
  // there without a schema entry fails here rather than going undocumented.
  const source = fs.readFileSync(path.join(ROOT, "src/tui.mjs"), "utf8");
  const dispatched = new Set([...source.matchAll(/cmd === "([^"]+)"/g)].map((m) => m[1]));
  assert.ok(dispatched.size >= 10, "the pit dispatch scrape found nothing — did the shape change?");

  for (const name of dispatched) {
    assert.ok(findPitCommand(name), `the pit dispatches "/${name}" and has no help for it`);
  }
});

test("/logout is in the pit's help, having been dispatched and undocumented", () => {
  const model = pitHelpModel({});
  assert.ok(model.commands.some((c) => c.name === "logout"), "the omission this PRD names");
});

test("the pit's help hardcodes no roster", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/tui.mjs"), "utf8");
  const help = source.slice(source.indexOf("function printHelp"), source.indexOf("function printPwd"));
  // The nine tool names that used to be typed out beneath a printTools() whose
  // comment explains why doing that goes stale.
  for (const tool of ["railway", "supabase", "doppler", "doctl", "turso", "tailscale"]) {
    assert.ok(!help.includes(`/${tool}`), `printHelp still hardcodes /${tool}`);
  }
  // And the moshscript verbs, which had already drifted: ai() and shell() were
  // in the vocabulary and missing from the hand-typed list.
  assert.ok(!help.includes("notify() ask()"), "printHelp still hardcodes the vocabulary");
});

test("the pit says which CLI commands it does not have", () => {
  const model = pitHelpModel({});
  const absent = model.notInPit.map((c) => c.name);
  for (const name of ["dns", "console", "completion", "uninstall"]) {
    assert.ok(absent.includes(name), `${name} has no pit equivalent and should say so`);
  }
  // And nothing may be in both lists — that would be the confusion R12 exists
  // to remove.
  for (const name of absent) {
    assert.equal(findPitCommand(name), null, `${name} is listed as absent but is dispatched`);
  }
});

test("a pit command renders detail, delegating to the CLI block", () => {
  const block = renderPitCommand("prd");
  assert.match(block, /^moshcode prd —/);
  assert.match(block, /in the pit: \/prd/);
  // Pit-only verbs answer for themselves.
  assert.match(renderPitCommand("quit"), /^\/quit —/);
  assert.equal(renderPitCommand("nonsense"), null);
});

test("pit aliases resolve", () => {
  for (const [alias, target] of [["agent", "agents"], ["engines", "agents"], ["where", "pwd"], ["q", "quit"], ["sh", "shell"]]) {
    assert.equal(findPitCommand(alias)?.name, target, `/${alias} should resolve to /${target}`);
  }
});
