// The run record and the heartbeat (PRD 0019 R2, R3): a header written once
// and never again, steps that ride the OpenFleet ledger rather than a second
// store, a beat that expires instead of lying, and the retention that lets an
// immutable record be allowed to exist. Every test runs against a mkdtemp
// OPENFLEET_HOME; nothing here touches ~/.openfleet.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BEAT_TTL_MS, GC_KEEP_PER_DIR, RUN_RECORD_VERSION, beat, beatPath, clearBeat, closeRun,
  gcRuns, listRuns, liveBeats, openRun, readBeat, readRun, recordStep, replayRun, runId,
  runLines, runPath, runsDir,
} from "../src/run-record.mjs";
import { append, readLedger, findEvents, markPath } from "../src/openfleet.mjs";

const OPENFLEET_VARS = ["OPENFLEET_HOME", "OPENFLEET_RECORD", "OPENFLEET_FLEET", "OPENFLEET_MEMBER", "OPENFLEET_SWARM"];

/** Each test gets its own home; every function reads the env var on every call. */
function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-run-test-"));
  const previous = Object.fromEntries(OPENFLEET_VARS.map((k) => [k, process.env[k]]));
  for (const k of OPENFLEET_VARS) delete process.env[k];
  process.env.OPENFLEET_HOME = dir;
  try { return fn(dir); }
  finally {
    for (const k of OPENFLEET_VARS) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mode = (file) => fs.statSync(file).mode & 0o777;

// Never a real user@host. The implicit fleet is `<user>@<host>` on a real box
// and a test that compared against it would pass only on the box that wrote it.
const FLEET = "testfleet-20260925";

const aRun = (extra = {}) => ({
  run: "fix-the-thing-141500-ab12",
  fleet: FLEET,
  session: "claude1",
  engine: "moshcode/claude",
  model: "claude-opus-5",
  task: "fix the thing",
  inputs: { prompt: "fix the thing", args: ["--resume"] },
  cwd: "/src/api",
  ...extra,
});

/* ----------------------------------------------------------------- the ids */

test("a run id carries the label, the second, and a tail, so two runs a minute apart do not collide", () => {
  const at = Date.UTC(2026, 8, 25, 14, 15, 7);
  assert.equal(runId("fix the thing", { now: at, rand: () => 0.5 }), "fix-the-thing-141507-8000");
  // Same label, same second, different tail: the header is claimed with `wx`
  // and two runs of one task in one second is ordinary rather than a mistake.
  const a = runId("x", { now: at, rand: () => 0.1 });
  const b = runId("x", { now: at, rand: () => 0.9 });
  assert.notEqual(a, b);
});

test("a run id with nothing usable in it still produces a name", () => {
  assert.match(runId("", { now: 0, rand: () => 0 }), /^run-\d{6}-0000$/);
});

/* -------------------------------------------------------------- the record */

test("a run header is written once, at 0600, versioned, and never overwritten", () => {
  withHome((dir) => {
    const first = openRun(aRun(), { now: Date.UTC(2026, 8, 25, 14, 15) });
    assert.equal(first.ok, true);
    assert.equal(first.path, path.join(dir, "fleets", FLEET, "runs", "fix-the-thing-141500-ab12.json"));
    assert.equal(first.path, runPath(FLEET, "fix-the-thing-141500-ab12"));
    assert.equal(mode(first.path), 0o600);
    assert.equal(mode(runsDir(FLEET)), 0o700, "the directory is private too");

    const written = readRun(FLEET, "fix-the-thing-141500-ab12");
    assert.equal(written.record_version, RUN_RECORD_VERSION);
    assert.equal(written.engine, "moshcode/claude");
    assert.equal(written.model, "claude-opus-5");
    assert.deepEqual(written.inputs, { prompt: "fix the thing", args: ["--resume"] });
    assert.equal(written.started, "2026-09-25T14:15:00Z");

    // The second open finds the id taken and says so rather than replacing the
    // first run's inputs, which is the whole of what immutable means here.
    const second = openRun(aRun({ inputs: { prompt: "something else" } }));
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "EEXIST");
    assert.deepEqual(readRun(FLEET, "fix-the-thing-141500-ab12").inputs, { prompt: "fix the thing", args: ["--resume"] });
  });
});

test("a run needs a run id and a fleet, and says which is missing rather than writing half a record", () => {
  withHome(() => {
    assert.equal(openRun({ fleet: FLEET }).ok, false);
    assert.equal(openRun({ run: "r" }).ok, false);
    assert.equal(listRuns(FLEET).length, 0);
  });
});

test("a run's start, steps and end are lines on the fleet's own ledger, not a second store", () => {
  withHome((dir) => {
    openRun(aRun(), { now: 1000 });
    recordStep(FLEET, "fix-the-thing-141500-ab12", { kind: "tool", name: "edit", summary: "src/api.mjs" }, { now: 2000 });
    recordStep(FLEET, "fix-the-thing-141500-ab12", { kind: "tool", name: "test", ok: true }, { now: 3000 });
    closeRun(FLEET, "fix-the-thing-141500-ab12", { state: "done", summary: "fixed", outputs: { files: ["src/api.mjs"] } }, { now: 4000 });

    // One ledger file, the one PRD 0016 already wrote to.
    const fleetDir = path.join(dir, "fleets", FLEET);
    assert.deepEqual(fs.readdirSync(fleetDir).filter((n) => n.endsWith(".jsonl")), ["ledger.jsonl"]);

    const lines = readLedger(FLEET);
    assert.deepEqual(lines.map((l) => l.event), ["run.start", "run.step", "run.step", "run.end"]);
    assert.equal(lines[0].fleet, FLEET, "every line carries the fleet, like the spec's do");
    assert.equal(lines[0].engine, "moshcode/claude");
    assert.equal(lines.at(-1).state, "done");
    assert.deepEqual(lines.at(-1).outputs, { files: ["src/api.mjs"] });
  });
});

test("a run is reconstructable from its record and the ledger, with no transcript anywhere", () => {
  withHome(() => {
    openRun(aRun(), { now: 1000 });
    recordStep(FLEET, "fix-the-thing-141500-ab12", { kind: "tool", name: "edit" }, { now: 2000 });
    closeRun(FLEET, "fix-the-thing-141500-ab12", { state: "done", summary: "fixed" }, { now: 3000 });

    const replayed = replayRun(FLEET, "fix-the-thing-141500-ab12", readLedger(FLEET));
    assert.equal(replayed.record.model, "claude-opus-5");
    assert.deepEqual(replayed.record.inputs, { prompt: "fix the thing", args: ["--resume"] });
    assert.equal(replayed.steps.length, 1);
    assert.equal(replayed.ended, "done");
    assert.equal(replayed.summary, "fixed");
  });
});

test("run.start and run.end each land once, however many writers try", () => {
  withHome(() => {
    openRun(aRun(), { now: 1000 });
    // A second opener loses on the header and must not append a second start.
    openRun(aRun(), { now: 1500 });
    closeRun(FLEET, "fix-the-thing-141500-ab12", { state: "done" }, { now: 2000 });
    const second = closeRun(FLEET, "fix-the-thing-141500-ab12", { state: "failed" }, { now: 2500 });
    assert.equal(second.already, true, "the second close hears that it lost");

    const lines = readLedger(FLEET);
    assert.equal(findEvents(lines, "run.start", { run: "fix-the-thing-141500-ab12" }).length, 1);
    const ends = findEvents(lines, "run.end", { run: "fix-the-thing-141500-ab12" });
    assert.equal(ends.length, 1);
    assert.equal(ends[0].state, "done", "the first end is the one that counts");
    assert.equal(fs.existsSync(markPath(FLEET, "run.end.fix-the-thing-141500-ab12")), true);
  });
});

test("an end state outside the vocabulary is recorded as failed rather than passed through", () => {
  withHome(() => {
    openRun(aRun(), { now: 1000 });
    closeRun(FLEET, "fix-the-thing-141500-ab12", { state: "exploded" }, { now: 2000 });
    assert.equal(findEvents(readLedger(FLEET), "run.end", {})[0].state, "failed");
  });
});

test("runLines picks out one run's lines and leaves the spec's events alone", () => {
  const lines = [
    { event: "member.start", member: "m1" },
    { event: "run.step", run: "a" },
    { event: "run.step", run: "b" },
    { event: "run.end", run: "a" },
  ];
  assert.deepEqual(runLines(lines, "a").map((l) => l.event), ["run.step", "run.end"]);
});

/* ----------------------------------------------------------- the heartbeat */

test("a beat is a small mutable file, rewritten in place at 0600", () => {
  withHome(() => {
    const first = beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    assert.equal(first.ok, true);
    assert.equal(first.path, beatPath(FLEET, "r1"));
    assert.equal(mode(first.path), 0o600);

    beat(FLEET, "r1", { session: "claude1", state: "blocked", kind: "permission" }, { now: 2000 });
    const now = readBeat(FLEET, "r1", { now: 2000 });
    assert.equal(now.state, "blocked");
    assert.equal(now.kind, "permission");
    assert.equal(now.at, 2000);
    // One file, not a growing log: only the last beat ever answered anything.
    assert.deepEqual(fs.readdirSync(path.dirname(first.path)), ["r1.json"]);
  });
});

test("a beat past its ttl is an absence rather than a stale claim", () => {
  withHome(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    assert.equal(readBeat(FLEET, "r1", { now: 1000 + BEAT_TTL_MS })?.state, "working");
    assert.equal(readBeat(FLEET, "r1", { now: 1000 + BEAT_TTL_MS + 1 }), null);
  });
});

test("a beat cannot claim authority for longer than the ceiling allows", () => {
  withHome(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working", ttl: 99 * 60 * 60 * 1000 }, { now: 0 });
    assert.equal(readBeat(FLEET, "r1", { now: 0 }).ttl, BEAT_TTL_MS);
    assert.equal(readBeat(FLEET, "r1", { now: BEAT_TTL_MS + 1 }), null);
  });
});

test("liveBeats is keyed by session, skips the expired, and never throws on a missing home", () => {
  withHome(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    beat(FLEET, "r2", { session: "codex1", state: "blocked" }, { now: 1000 });
    beat(FLEET, "r3", { session: "old1", state: "working" }, { now: 0 });
    // A beat with no session cannot be matched to a roster row and is skipped.
    beat(FLEET, "r4", { state: "working" }, { now: 1000 });

    const beats = liveBeats({ now: 1000 + BEAT_TTL_MS });
    assert.deepEqual([...beats.keys()].sort(), ["claude1", "codex1"]);
    assert.equal(beats.get("claude1").run, "r1");
  });

  const previous = process.env.OPENFLEET_HOME;
  process.env.OPENFLEET_HOME = path.join(os.tmpdir(), "moshcode-no-such-home-ever");
  try { assert.equal(liveBeats().size, 0, "a home that does not exist is an empty map, not a throw"); }
  finally {
    if (previous === undefined) delete process.env.OPENFLEET_HOME;
    else process.env.OPENFLEET_HOME = previous;
  }
});

test("closing a run takes its beat with it, so an ended run cannot read as alive", () => {
  withHome(() => {
    openRun(aRun(), { now: 1000 });
    beat(FLEET, "fix-the-thing-141500-ab12", { session: "claude1", state: "working" }, { now: 1000 });
    assert.equal(liveBeats({ now: 1000 }).size, 1);
    closeRun(FLEET, "fix-the-thing-141500-ab12", { state: "done" }, { now: 2000 });
    assert.equal(liveBeats({ now: 2000 }).size, 0);
  });
});

test("clearBeat on a beat that was never written is not an error", () => {
  withHome(() => {
    assert.equal(clearBeat(FLEET, "never"), true);
  });
});

/* ------------------------------------------------------------- the retention */

/** n ended runs in one directory, oldest first, each one second apart. */
function seedRuns(count, { cwd = "/src/api", from = 1000, ended = true, prefix = "r" } = {}) {
  for (let i = 0; i < count; i++) {
    const run = `${prefix}${String(i).padStart(3, "0")}`;
    openRun(aRun({ run, cwd, session: `s${i}` }), { now: from + i * 1000 });
    recordStep(FLEET, run, { kind: "tool", name: "edit" }, { now: from + i * 1000 + 1 });
    if (ended) closeRun(FLEET, run, { state: "done" }, { now: from + i * 1000 + 2 });
  }
}

test("gc keeps the newest runs per directory and drops the rest, with their ledger lines", () => {
  withHome(() => {
    seedRuns(5, { cwd: "/src/api" });
    seedRuns(5, { cwd: "/src/web", from: 100000, prefix: "w" });
    const report = gcRuns({ now: 200000, keep: 2, maxAgeMs: Number.MAX_SAFE_INTEGER });

    // Two kept per directory, not two overall: one busy checkout must not be
    // able to evict every other one.
    assert.equal(report.removed.length, 6);
    assert.equal(report.kept, 4);
    assert.equal(listRuns(FLEET).length, 4);
    assert.equal(report.removed.every((r) => r.why === "count"), true);

    const survivors = new Set(listRuns(FLEET).map((r) => r.run));
    const lines = readLedger(FLEET);
    for (const l of lines.filter((x) => String(x.event).startsWith("run."))) {
      assert.equal(survivors.has(l.run), true, `a pruned run left ${l.event} behind`);
    }
    assert.equal(report.lines, 18, "three lines per pruned run went with it");
  });
});

test("gc drops an ended run past the age cap however few there are", () => {
  withHome(() => {
    seedRuns(1, { cwd: "/src/api", from: 1000 });
    const report = gcRuns({ now: 1000 + 40 * 24 * 60 * 60 * 1000, keep: 100 });
    assert.equal(report.removed.length, 1);
    assert.equal(report.removed[0].why, "age");
    assert.equal(listRuns(FLEET).length, 0);
  });
});

test("gc never touches a run that has not ended, at any age", () => {
  withHome(() => {
    seedRuns(3, { cwd: "/src/api", from: 1000, ended: false });
    const report = gcRuns({ now: 1000 + 400 * 24 * 60 * 60 * 1000, keep: 0, maxAgeMs: 1 });
    assert.equal(report.removed.length, 0);
    assert.equal(report.kept, 3);
    assert.equal(listRuns(FLEET).length, 3);
  });
});

test("gc removes only run lines: the spec's record of what agents were allowed to do stays", () => {
  withHome(() => {
    seedRuns(3, { cwd: "/src/api" });
    // The lines PRD 0016 writes, in the same ledger.
    append(FLEET, { event: "member.start", by: "sysop", member: "m1" }, { now: 5000 });
    append(FLEET, { event: "ceiling.refuse", by: "sysop", action: "spawn", key: "depth" }, { now: 5001 });

    gcRuns({ now: 200000, keep: 0, maxAgeMs: Number.MAX_SAFE_INTEGER });
    const events = readLedger(FLEET).map((l) => l.event).sort();
    assert.deepEqual(events, ["ceiling.refuse", "member.start"]);
    assert.equal(listRuns(FLEET).length, 0);
  });
});

test("gc --dry-run reports exactly what it would take and removes nothing", () => {
  withHome(() => {
    seedRuns(5, { cwd: "/src/api" });
    const dry = gcRuns({ now: 200000, keep: 1, maxAgeMs: Number.MAX_SAFE_INTEGER, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.removed.length, 4);
    assert.equal(dry.lines, 12);
    assert.equal(listRuns(FLEET).length, 5, "nothing went");
    assert.equal(readLedger(FLEET).length, 15);

    const wet = gcRuns({ now: 200000, keep: 1, maxAgeMs: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(wet.removed.map((r) => r.run).sort(), dry.removed.map((r) => r.run).sort());
    assert.equal(listRuns(FLEET).length, 1);
  });
});

test("gc takes a pruned run's once-markers too, so its id can never be revived half-claimed", () => {
  withHome(() => {
    seedRuns(1, { cwd: "/src/api" });
    assert.equal(fs.existsSync(markPath(FLEET, "run.end.r000")), true);
    gcRuns({ now: 200000, keep: 0, maxAgeMs: Number.MAX_SAFE_INTEGER });
    assert.equal(fs.existsSync(markPath(FLEET, "run.start.r000")), false);
    assert.equal(fs.existsSync(markPath(FLEET, "run.end.r000")), false);
  });
});

test("the default retention is a count per directory and an age, both stated rather than implied", () => {
  assert.equal(GC_KEEP_PER_DIR, 20);
  withHome(() => {
    seedRuns(2, { cwd: "/src/api" });
    assert.deepEqual(gcRuns({ now: 200000 }).removed, [], "two runs are well inside the defaults");
  });
});
