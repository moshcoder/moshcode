// `moshcode plugin` — the same fan-out contract as prd/0003 R8 for skills: the
// plan covers every engine, and an engine with no plugin primitive is reported
// as skipped rather than silently omitted.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ENGINES } from "../src/engines.mjs";
import {
  MARKETPLACE_NAME, PLUGINS, PLUGIN_ENGINES, RETIRED_PLUGINS, marketplaceSource,
  planPluginCommand, pluginCommandName, pluginId, resolvePlugin, resolveRetiredPlugin,
  runPluginCommand,
} from "../src/plugins.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NO_PRIMITIVE = Object.keys(ENGINES).filter((key) => !PLUGIN_ENGINES.includes(key));
const SPEC = { plugin: PLUGINS[0], source: "moshcoder/moshcode" };
const byKey = (results) => Object.fromEntries(results.map((r) => [r.key, r]));

// --- the fan-out contract ----------------------------------------------------

test("the plan covers every engine, not just the ones with a primitive", () => {
  const keys = planPluginCommand(SPEC, { installedSet: new Set() }).map((p) => p.key);
  assert.deepEqual([...keys].sort(), Object.keys(ENGINES).sort());
});

test("every engine without a primitive carries the skip reason", () => {
  const plan = byKey(planPluginCommand(SPEC, { installedSet: new Set() }));
  for (const key of NO_PRIMITIVE) {
    assert.equal(plan[key]?.skip, "no plugin primitive", `${key} has no skip reason`);
  }
});

test("an engine that is not installed is reported, not attempted", async () => {
  const results = byKey(await runPluginCommand(
    planPluginCommand(SPEC, { installedSet: new Set() }),
    { run: async () => assert.fail("ran a command for an absent engine") },
  ));
  assert.equal(results.claude.status, "not-installed");
});

// --- what actually runs ------------------------------------------------------

test("install adds *and refreshes* the marketplace before installing, every time", () => {
  // `add` alone is not enough and this is the regression that proves it: it is
  // a no-op for a marketplace already on disk, so a machine that installed from
  // this marketplace before a plugin existed reads a stale local copy and fails
  // with "not found in any marketplace". That shipped twice — `crypto` in
  // v0.27.0, `stocks` in v0.29.0 — before anything caught it.
  const plan = byKey(planPluginCommand(SPEC, { installedSet: new Set(["claude"]) }));
  assert.deepEqual(plan.claude.actions.map((a) => a.args), [
    ["plugin", "marketplace", "add", "moshcoder/moshcode"],
    ["plugin", "marketplace", "update", "moshcode"],
    ["plugin", "install", "stocks@moshcode"],
  ]);
});

test("the refresh names the marketplace, not the source, and carries no scope", () => {
  // `claude plugin marketplace update` takes a marketplace name and rejects
  // --scope; passing the source here would update nothing and report success.
  const plan = byKey(planPluginCommand(
    { ...SPEC, scope: "project" },
    { installedSet: new Set(["claude"]) },
  ));
  const update = plan.claude.actions.find((a) => a.args[2] === "update");
  assert.deepEqual(update.args, ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
});

test("a failing step stops the chain rather than installing from nothing", async () => {
  const ran = [];
  const results = byKey(await runPluginCommand(
    planPluginCommand(SPEC, { installedSet: new Set(["claude"]) }),
    {
      run: async (cmd, args) => { ran.push(args[1]); return { ok: true, code: 1 }; },
    },
  ));
  assert.equal(results.claude.status, "failed");
  assert.deepEqual(ran, ["marketplace"], "it kept going after the marketplace failed");
});

test("remove uninstalls the qualified id, and touches no marketplace", () => {
  const plan = byKey(planPluginCommand(SPEC, { installedSet: new Set(["claude"]), verb: "remove" }));
  assert.deepEqual(plan.claude.actions.map((a) => a.args), [["plugin", "uninstall", "stocks@moshcode"]]);
});

test("a successful run reports installed / removed, matching the verb", async () => {
  const ok = async () => ({ ok: true, code: 0 });
  const installed = byKey(await runPluginCommand(planPluginCommand(SPEC, { installedSet: new Set(["claude"]) }), { run: ok }));
  assert.equal(installed.claude.status, "installed");
  const removed = byKey(await runPluginCommand(
    planPluginCommand(SPEC, { installedSet: new Set(["claude"]), verb: "remove" }),
    { run: ok, verb: "remove" },
  ));
  assert.equal(removed.claude.status, "removed");
});

// --- names -------------------------------------------------------------------

test("the default plugin resolves from nothing, and an unknown one does not", () => {
  assert.equal(resolvePlugin()?.name, "stocks");
  assert.equal(resolvePlugin("stocks@moshcode")?.name, "stocks", "a qualified id should resolve");
  assert.equal(resolvePlugin("nonsense"), null);
});

test("a retired plugin stays removable, and stays uninstallable", () => {
  // The asymmetry is the whole point. The old plugin is still sitting installed
  // in someone's engine serving the same slash commands, and installing the new
  // one puts a second copy beside it rather than replacing it — so `remove` has
  // to reach a name `install` refuses, or the rename strands people.
  for (const retired of RETIRED_PLUGINS) {
    assert.equal(resolvePlugin(retired.name), null, `${retired.name} must not install`);
    assert.equal(resolveRetiredPlugin(retired.name)?.renamedTo, retired.renamedTo);
    assert.equal(resolveRetiredPlugin(`${retired.name}@moshcode`)?.name, retired.name, "a qualified id should resolve");
    assert.ok(
      PLUGINS.some((p) => p.name === retired.renamedTo),
      `${retired.name} points at ${retired.renamedTo}, which must be a plugin this marketplace ships`,
    );
  }
  assert.equal(resolveRetiredPlugin("nonsense"), null);
  assert.equal(resolveRetiredPlugin(), null);
});

test("the source is overridable, so an unreleased plugin is installable", () => {
  assert.equal(marketplaceSource({}), "moshcoder/moshcode");
  assert.equal(marketplaceSource({ MOSHCODE_PLUGIN_SOURCE: "/tmp/checkout" }), "/tmp/checkout");
});

// --- the manifests on disk ---------------------------------------------------

test("the shipped marketplace manifest matches the catalog this module fans out", () => {
  // These two drift apart silently: the manifest is what Claude Code reads, the
  // catalog is what `/plugin list` prints and what `install` names.
  const manifest = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, MARKETPLACE_NAME);
  assert.deepEqual(manifest.plugins.map((p) => p.name).sort(), PLUGINS.map((p) => p.name).sort());
});

test("every plugin the marketplace lists exists, with a manifest and its commands", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  for (const entry of manifest.plugins) {
    const dir = new URL(`../${String(entry.source).replace(/^\.\//, "")}/`, import.meta.url);
    const plugin = JSON.parse(fs.readFileSync(new URL(".claude-plugin/plugin.json", dir), "utf8"));
    assert.equal(plugin.name, entry.name, `${entry.name}'s manifest disagrees with the marketplace`);

    // An engine only pulls a new copy of a plugin when its own version moves —
    // a moshcode release does not carry plugin edits to existing installs on its
    // own. Both plugins sat at 0.1.0 through v0.29.2, which rewrote every
    // command file, so this pins the catalog to the manifest that ships.
    assert.match(plugin.version ?? "", /^\d+\.\d+\.\d+$/, `${entry.name} has no usable plugin.json version`);
    assert.equal(
      PLUGINS.find((p) => p.name === entry.name)?.version,
      plugin.version,
      `${entry.name}: the catalog and plugin.json disagree on the version`,
    );

    const catalog = PLUGINS.find((p) => p.name === entry.name);
    const files = fs.readdirSync(new URL("commands/", dir)).filter((f) => f.endsWith(".md"));
    // Namespaced, because that is how Claude Code invokes them. Comparing bare
    // filenames is what let the catalog advertise `/crypto` for two releases —
    // a name that matched the file on disk and did not exist as a command.
    assert.deepEqual(
      files.map((f) => pluginCommandName(entry.name, f)).sort(),
      [...catalog.commands].sort(),
      `${entry.name} advertises commands it does not ship`,
    );
    assert.ok(
      catalog.example?.startsWith(`/${entry.name}:`),
      `${entry.name}'s example must invoke one of its own namespaced commands`,
    );
    assert.ok(
      catalog.commands.includes(catalog.example.split(" ")[0]),
      `${entry.name}'s example invokes a command it does not ship`,
    );
  }
});

test("every shipped command declares a description and parseable frontmatter", () => {
  // Unparseable frontmatter loads the command with empty metadata — no
  // description, no allowed-tools — and nothing at runtime says so. Driven from
  // the manifest rather than one hard-coded directory, so a plugin added later
  // cannot ship unchecked.
  const manifest = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  let checked = 0;
  for (const entry of manifest.plugins) {
    const dir = new URL(`../${String(entry.source).replace(/^\.\//, "")}/commands/`, import.meta.url);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const id = `${entry.name}/${file}`;
      const text = fs.readFileSync(new URL(file, dir), "utf8");
      const match = text.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(match, `${id} has no frontmatter block`);
      assert.match(match[1], /^description: \S/m, `${id} has no description`);
      // A value opening with `[` is a YAML flow sequence, and `[--limit n]` in one
      // is a parse error that silently drops every field in the block.
      for (const line of match[1].split("\n")) {
        const value = line.match(/^[a-z-]+: (.*)$/)?.[1];
        if (value?.startsWith("[")) assert.fail(`${id}: unquoted "[" in frontmatter — ${line}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 6, "found no commands to check");
});

test("pluginId is the form the engine disambiguates with", () => {
  assert.equal(pluginId("stocks"), "stocks@moshcode");
});

test("the README documents the install command it actually ships", () => {
  const readme = fs.readFileSync(`${ROOT}README.md`, "utf8");
  assert.match(readme, /moshcode plugin install/);
});
