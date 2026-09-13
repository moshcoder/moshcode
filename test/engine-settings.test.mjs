// Engine settings defaults: the merge that only ever fills a hole, the remove
// that only takes back what is still ours, and the file it refuses to touch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyAfterInstall, applyEngineSettings, defaultEntries, defaultableEngines, enginesDefaults,
  removeEngineSettings, settingsStatus,
} from "../src/engine-settings.mjs";
import { ENGINES } from "../src/engines.mjs";

function withSettings(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-defaults-test-"));
  const file = path.join(dir, "settings.json");
  if (initial !== undefined) fs.writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial, null, 2));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  // The command tests are async: clean up after the promise, not before it.
  let result;
  try { result = fn(file); }
  catch (error) { cleanup(); throw error; }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/* ---------------------------------------------------------------- the spec */

test("claude ships ultracode off, no keyword trigger, small workflows, and a hard cap of four agents", () => {
  // The four values this feature exists to carry. Change them here and in
  // the README together — the numbers in the prose are these.
  assert.deepEqual(ENGINES.claude.settings.defaults, {
    ultracode: false,
    workflowKeywordTriggerEnabled: false,
    workflowSizeGuideline: "small",
    env: { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: "4" },
  });
  assert.deepEqual(defaultableEngines(), ["claude"]);
});

test("the spec points at Claude Code's own settings file", () => {
  assert.equal(ENGINES.claude.settings.file(), path.join(os.homedir(), ".claude", "settings.json"));
  // Same file the hooks write, so both installers are guests in one config.
  assert.equal(ENGINES.claude.settings.file(), ENGINES.claude.hooks.file());
});

test("nested defaults flatten to one leaf per key", () => {
  const keys = defaultEntries("claude").map((e) => e.key);
  assert.deepEqual(keys, ["ultracode", "workflowKeywordTriggerEnabled", "workflowSizeGuideline", "env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS"]);
  assert.ok(defaultEntries("claude").every((e) => e.label && e.label !== e.key), "every default carries a human label");
  assert.deepEqual(defaultEntries("codex"), []);
});

/* ------------------------------------------------------------- apply/merge */

test("applying fills holes and leaves everything else alone", () => {
  withSettings({
    model: "opus",
    env: { FOO: "bar" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo theirs" }] }] },
  }, (file) => {
    const result = applyEngineSettings("claude", { file });
    assert.equal(result.ok, true);
    assert.equal(result.written, 4);
    const after = read(file);
    assert.equal(after.model, "opus", "an unrelated setting was lost");
    assert.equal(after.env.FOO, "bar", "a sibling env var was lost");
    assert.equal(after.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS, "4");
    assert.equal(after.ultracode, false);
    assert.equal(after.workflowKeywordTriggerEnabled, false);
    assert.equal(after.workflowSizeGuideline, "small");
    assert.equal(after.hooks.Stop[0].hooks[0].command, "echo theirs", "the user's hook was clobbered");
  });
});

test("a key the operator set is never touched, even to the opposite value", () => {
  // The whole reason "theirs" is a state and not a fault: a floor under a
  // fresh install, not a policy over an old one.
  withSettings({ ultracode: true, workflowSizeGuideline: "large" }, (file) => {
    const result = applyEngineSettings("claude", { file });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changes.map((c) => c.change), ["kept", "added", "kept", "added"]);
    const after = read(file);
    assert.equal(after.ultracode, true, "the operator turned it on; that is theirs to keep");
    assert.equal(after.workflowSizeGuideline, "large");
    assert.equal(after.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS, "4");
  });
});

test("applying twice changes nothing the second time", () => {
  withSettings({}, (file) => {
    applyEngineSettings("claude", { file });
    const second = applyEngineSettings("claude", { file });
    assert.equal(second.written, 0);
    assert.ok(second.changes.every((c) => c.change === "unchanged"));
  });
});

test("applying creates the file when the engine has never been configured", () => {
  withSettings(undefined, (file) => {
    assert.equal(applyEngineSettings("claude", { file }).ok, true);
    assert.deepEqual(read(file), ENGINES.claude.settings.defaults);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "a fresh settings file should be private");
  });
});

test("a settings file that cannot be parsed is refused, not overwritten", () => {
  withSettings("{ not json", (file) => {
    const result = applyEngineSettings("claude", { file });
    assert.equal(result.ok, false);
    assert.match(String(result.error.message), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  });
});

test("--dry-run writes nothing and can still show the change", () => {
  withSettings({ model: "opus" }, (file) => {
    const result = applyEngineSettings("claude", { file, dryRun: true });
    assert.equal(result.ok, true);
    assert.deepEqual(read(file), { model: "opus" }, "a dry run touched the file");
    assert.match(result.after, /"ultracode": false/);
  });
});

test("an engine without a spec is refused with a reason", () => {
  const result = applyEngineSettings("codex", { file: "/nonexistent/never-written.json" });
  assert.equal(result.ok, false);
  assert.equal(result.supported, false);
  assert.ok(!fs.existsSync("/nonexistent/never-written.json"));
});

/* ------------------------------------------------------------------ status */

test("status tells set from missing from theirs", () => {
  withSettings({ ultracode: false, workflowSizeGuideline: "large" }, (file) => {
    const status = settingsStatus("claude", { file });
    assert.equal(status.readable, true);
    assert.deepEqual(status.entries.map((e) => e.state), ["set", "missing", "theirs", "missing"]);
    assert.equal(status.entries[2].have, "large");
    assert.equal(status.applied, false, "two are still missing");
    applyEngineSettings("claude", { file });
    const after = settingsStatus("claude", { file });
    assert.deepEqual(after.entries.map((e) => e.state), ["set", "set", "theirs", "set"]);
    assert.equal(after.applied, true, "an override is an answer, not a hole");
  });
});

test("status on a missing file is every default missing, not an error", () => {
  withSettings(undefined, (file) => {
    const status = settingsStatus("claude", { file });
    assert.equal(status.readable, true);
    assert.equal(status.present, false);
    assert.ok(status.entries.every((e) => e.state === "missing"));
  });
});

/* ------------------------------------------------------------------ remove */

test("remove takes out only what is still ours", () => {
  withSettings({ model: "opus", env: { FOO: "bar" } }, (file) => {
    applyEngineSettings("claude", { file });
    // The operator has since changed one of them: it is theirs now.
    const edited = read(file);
    edited.workflowSizeGuideline = "large";
    fs.writeFileSync(file, JSON.stringify(edited, null, 2));

    const result = removeEngineSettings("claude", { file });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 3);
    const after = read(file);
    assert.equal(after.model, "opus");
    assert.equal(after.env.FOO, "bar", "a sibling env var went with ours");
    assert.equal("ultracode" in after, false);
    assert.equal("workflowKeywordTriggerEnabled" in after, false);
    assert.equal("CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS" in after.env, false);
    assert.equal(after.workflowSizeGuideline, "large", "the operator's edit was removed");
  });
});

test("remove drops an env object it emptied and keeps one it did not", () => {
  withSettings({}, (file) => {
    applyEngineSettings("claude", { file });
    removeEngineSettings("claude", { file });
    assert.deepEqual(read(file), {}, "an empty env we created should go with our key");
  });
  withSettings({ env: { FOO: "bar" } }, (file) => {
    applyEngineSettings("claude", { file });
    removeEngineSettings("claude", { file });
    assert.deepEqual(read(file), { env: { FOO: "bar" } });
  });
});

test("remove on a file that was never there is a no-op", () => {
  withSettings(undefined, (file) => {
    const result = removeEngineSettings("claude", { file });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 0);
    assert.ok(!fs.existsSync(file));
  });
});

/* --------------------------------------------------------- after an install */

test("after an install, an engine with no spec says nothing at all", () => {
  const lines = [];
  assert.equal(applyAfterInstall("codex", { write: (l) => lines.push(l) }), null);
  assert.deepEqual(lines, []);
});

/* -------------------------------------------------------------- the command */

async function run(argv, file) {
  const lines = [];
  // The command resolves the file from the spec; point it at the temp file.
  const spec = ENGINES.claude.settings;
  const original = spec.file;
  spec.file = () => file;
  try { return { code: await enginesDefaults(argv, { write: (l) => lines.push(l) }), lines }; }
  finally { spec.file = original; }
}

test("`engines defaults claude` is status for claude, not a usage error", async () => {
  await withSettings({}, async (file) => {
    const { code, lines } = await run(["claude"], file);
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /4 of 4 not set/);
  });
});

test("`engines defaults apply claude --json` is machine-readable and reports every change", async () => {
  await withSettings({ ultracode: true }, async (file) => {
    const { code, lines } = await run(["apply", "claude", "--json"], file);
    assert.equal(code, 0);
    const [result] = JSON.parse(lines.join("\n"));
    assert.equal(result.engine, "claude");
    assert.deepEqual(result.changes.map((c) => c.change), ["kept", "added", "added", "added"]);
    assert.equal(read(file).ultracode, true);
  });
});

test("a verb nobody knows is a usage error", async () => {
  await withSettings({}, async (file) => {
    const { code, lines } = await run(["frobnicate", "claude"], file);
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /usage: moshcode engines defaults/);
  });
});

test("an engine nobody knows names the ones that have defaults", async () => {
  await withSettings({}, async (file) => {
    const { code, lines } = await run(["apply", "nope"], file);
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /no engine named "nope"/);
    assert.match(lines.join("\n"), /engines with defaults: claude/);
  });
});
