// `moshcode omarchy` — the snapshot the bar polls, and the checks that let a
// non-Omarchy box ship the plugin (PRD 0017).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  KIND_ENTRY_POINTS, PLUGIN_ID, REQUIRED_FIELDS, SCHEMA,
  agentRows, alertsFor, burnSnapshot, countStates, omarchyCommand, pluginSource, snapshot, validatePlugin,
} from "../src/omarchy.mjs";

const tmps = [];
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omarchy-test-"));
  tmps.push(dir);
  return dir;
}
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

const ROW = {
  name: "api", engine: "claude", herd: "main", state: "working", fleet: "anthony@dev",
  swarm: null, member: "api", approvals: "bypass", cwd: "/home/a/src/thing", age: 1000, alive: true, attached: 1,
};

/** A cost report with one run, one sample, priced. */
function fakeReport(cost = true) {
  return async () => ({
    runs: [{
      engine: "claude", id: "r1",
      samples: [{ at: Date.now() - 1000, model: cost ? "claude-fable-5-1" : "mystery-model", usage: { input: 1000, output: 100 } }],
    }],
    rows: [], unattributed: [], sessions: [],
  });
}

describe("the snapshot", () => {
  it("carries the schema, so an older plugin can refuse a newer snapshot", async () => {
    const snap = await snapshot({ roster: () => [], cache: false, report: fakeReport() });
    assert.equal(snap.schema, SCHEMA);
    assert.match(snap.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the words moshcode ps already uses", async () => {
    const snap = await snapshot({ roster: () => [ROW], cache: false, report: fakeReport() });
    const [a] = snap.agents;
    assert.equal(a.name, "api");
    assert.equal(a.state, "working");
    assert.equal(a.approvals, "bypass");
    assert.equal(a.ageMs, 1000);
    assert.equal(a.fleet, "anthony@dev");
  });

  it("counts every state in the vocabulary, present or not", () => {
    const counts = countStates(agentRows([
      ROW,
      { ...ROW, name: "web", state: "blocked", alive: true },
      { ...ROW, name: "old", state: "gone", alive: false },
    ]));
    assert.equal(counts.working, 1);
    assert.equal(counts.blocked, 1);
    assert.equal(counts.gone, 1);
    assert.equal(counts.idle, 0, "a state nobody is in is 0, not missing");
    assert.equal(counts.live, 2);
  });

  it("raises an alert for a blocked agent and nothing else", () => {
    const now = Date.now();
    const alerts = alertsFor(agentRows([
      ROW,
      { ...ROW, name: "web", state: "blocked", blockedOn: "question", age: 120000 },
    ]), { now });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].subject, "web");
    assert.equal(alerts[0].kind, "blocked:question");
    assert.equal(alerts[0].ageMs, 120000);
    assert.equal(alerts[0].since, new Date(now - 120000).toISOString());
  });

  it("is a snapshot, not a failure, when the roster throws", async () => {
    const snap = await snapshot({ roster: () => { throw new Error("no tmux"); }, cache: false, report: fakeReport() });
    assert.equal(snap.partial, true);
    assert.match(snap.error, /no tmux/);
    assert.deepEqual(snap.agents, []);
    assert.equal(snap.counts.live, 0, "the bar still gets numbers it can render");
  });

  it("names the engines it could not price instead of implying they were free", async () => {
    const snap = await snapshot({ roster: () => [], cache: false, report: fakeReport(false) });
    assert.ok(snap.unpriced.includes("mystery-model"));
    const hour = snap.burn.find((b) => b.key === "1h");
    assert.equal(hour.cost, null, "unpriced tokens contribute nothing, rather than zero dollars");
    assert.equal(hour.runs, 1, "the run still counts");
  });

  it("shows the bar the three windows it has room for", async () => {
    const snap = await snapshot({ roster: () => [], cache: false, report: fakeReport() });
    assert.deepEqual(snap.burn.map((b) => b.key), ["1m", "15m", "1h"]);
  });
});

describe("the cost cache", () => {
  it("serves a reading inside its ttl without asking again", async () => {
    const file = path.join(tmpdir(), "cache.json");
    let calls = 0;
    const report = async () => { calls += 1; return (await fakeReport()()); };
    const first = await burnSnapshot({ file, report, ttl: 60_000 });
    const second = await burnSnapshot({ file, report, ttl: 60_000 });
    assert.equal(calls, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.burn.map((b) => b.key), first.burn.map((b) => b.key));
  });

  it("asks again once the reading is stale", async () => {
    const file = path.join(tmpdir(), "cache.json");
    let calls = 0;
    const report = async () => { calls += 1; return (await fakeReport()()); };
    await burnSnapshot({ file, report, ttl: 5_000, now: Date.now() - 10_000 });
    await burnSnapshot({ file, report, ttl: 5_000 });
    assert.equal(calls, 2);
  });

  it("holds a slow reading longer than a fast one, and says it was slow", async () => {
    const file = path.join(tmpdir(), "cache.json");
    let calls = 0;
    const report = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return (await fakeReport()());
    };
    // budget 0 makes every reading "slow", which is the condition under test.
    const first = await burnSnapshot({ file, report, budget: 0, ttl: 1 });
    assert.equal(first.slow, true);
    // Well past the 1ms ttl, still inside the slow ttl: held, not recomputed.
    const second = await burnSnapshot({ file, report, budget: 0, ttl: 1, now: Date.now() + 2_000 });
    assert.equal(calls, 1);
    assert.equal(second.cached, true);
    assert.equal(second.slow, true);
  });

  it("serves the last reading it had when cost throws, and marks the snapshot partial", async () => {
    const file = path.join(tmpdir(), "cache.json");
    await burnSnapshot({ file, report: fakeReport(), ttl: 60_000 });
    const after = await burnSnapshot({
      file, ttl: 0,
      report: async () => { throw new Error("transcripts unreadable"); },
    });
    assert.equal(after.partial, true);
    assert.match(after.error, /transcripts unreadable/);
    assert.ok(Array.isArray(after.burn), "the last good reading is still what the bar shows");
  });

  it("writes the cache 0600, because it names every session you are running", async () => {
    const file = path.join(tmpdir(), "cache.json");
    await burnSnapshot({ file, report: fakeReport() });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe("the plugin this package ships", () => {
  it("validates", () => {
    const result = validatePlugin(pluginSource());
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it("is the id the CLI installs, and is not in the reserved namespace", () => {
    const { manifest } = validatePlugin(pluginSource());
    assert.equal(manifest.id, PLUGIN_ID);
    assert.ok(!manifest.id.startsWith("omarchy."));
    assert.equal(manifest.schemaVersion, 1);
  });

  it("declares an entry point for every kind, and a file for every entry point", () => {
    const { manifest } = validatePlugin(pluginSource());
    for (const kind of manifest.kinds) {
      const key = KIND_ENTRY_POINTS[kind];
      assert.ok(manifest.entryPoints[key], `${kind} needs entryPoints.${key}`);
      assert.ok(fs.existsSync(path.join(pluginSource(), manifest.entryPoints[key])));
    }
  });
});

describe("validate", () => {
  function plugin(manifest, files = { "BarWidget.qml": "Item {}" }) {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  }
  const good = {
    schemaVersion: 1, id: "io.github.someone.thing", name: "Thing", version: "1.0.0",
    author: "Someone", license: "MIT", description: "A thing.",
    kinds: ["bar-widget"], entryPoints: { barWidget: "BarWidget.qml" },
  };

  it("passes a manifest that has everything", () => {
    assert.deepEqual(validatePlugin(plugin(good)).errors, []);
  });

  it("names every missing required field", () => {
    const { errors } = validatePlugin(plugin({ schemaVersion: 1, id: "a.b" }));
    for (const field of REQUIRED_FIELDS.filter((f) => !["schemaVersion", "id"].includes(f))) {
      assert.ok(errors.some((e) => e.includes(`"${field}"`)), `expected an error about ${field}`);
    }
  });

  it("rejects the reserved namespace", () => {
    const { errors, ok } = validatePlugin(plugin({ ...good, id: "omarchy.clock" }));
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /reserved omarchy\./.test(e)));
  });

  it("rejects a kind with no entry point, and an entry point with no kind", () => {
    const missing = validatePlugin(plugin({ ...good, kinds: ["bar-widget", "panel"] }));
    assert.ok(missing.errors.some((e) => /entryPoints\.panel/.test(e)));
    const orphan = validatePlugin(plugin({ ...good, entryPoints: { barWidget: "BarWidget.qml", panel: "Panel.qml" } }));
    assert.ok(orphan.errors.some((e) => /entryPoints\.panel is declared but kind "panel" is not/.test(e)));
  });

  it("rejects a referenced file that is not there", () => {
    const { errors } = validatePlugin(plugin({ ...good, entryPoints: { barWidget: "Missing.qml" } }));
    assert.ok(errors.some((e) => /"Missing.qml" does not exist/.test(e)));
  });

  it("rejects a path that climbs out of the plugin", () => {
    const { errors } = validatePlugin(plugin({ ...good, entryPoints: { barWidget: "../BarWidget.qml" } }));
    assert.ok(errors.some((e) => /safe relative path/.test(e)));
  });

  it("rejects a symlink anywhere under the plugin", () => {
    const dir = plugin(good);
    fs.symlinkSync("/etc/passwd", path.join(dir, "sneaky.qml"));
    const { errors, ok } = validatePlugin(dir);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /symlink in plugin directory: sneaky\.qml/.test(e)));
  });

  it("is an error, not a crash, when the manifest is not JSON", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "manifest.json"), "{ not json");
    const { ok, errors } = validatePlugin(dir);
    assert.equal(ok, false);
    assert.ok(errors[0].includes("not valid JSON"));
  });

  it("warns about the things the marketplace asks for but does not require", () => {
    const { warnings } = validatePlugin(plugin(good));
    assert.ok(warnings.some((w) => /README\.md/.test(w)));
    assert.ok(warnings.some((w) => /preview\.png/.test(w)));
  });
});

describe("the CLI surface", () => {
  it("lists its verbs when asked for nothing", async () => {
    const lines = [];
    const code = await omarchyCommand([], { write: (l) => lines.push(l) });
    assert.equal(code, 1, "a bare namespace is a usage error, like the other namespaces");
    assert.match(lines.join("\n"), /status/);
    assert.match(lines.join("\n"), /doctor/);
  });

  it("refuses a verb it does not have", async () => {
    const lines = [];
    const code = await omarchyCommand(["rescan"], { write: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /unknown verb "rescan"/);
  });

  it("prints the shipped plugin as valid JSON under --json", async () => {
    const lines = [];
    const code = await omarchyCommand(["validate", "--json"], { write: (l) => lines.push(l) });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join("\n"));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.manifest.id, PLUGIN_ID);
  });

  it("says what is missing rather than pretending a non-Omarchy box is one", async () => {
    const lines = [];
    const code = await omarchyCommand(["doctor", "--json"], { write: (l) => lines.push(l) });
    assert.equal(code, 0);
    const d = JSON.parse(lines.join("\n"));
    assert.equal(d.sourceValid, true);
    assert.ok("omarchy" in d && "qmllint" in d);
  });
});
