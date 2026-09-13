// OpenFleet IO (PRD 0016): the record that is written once, the ledger that is
// only appended to and merged across hosts, the ceiling that only narrows, and
// the fold that turns both into the tree. Every test runs against a mkdtemp
// OPENFLEET_HOME; nothing here touches ~/.openfleet.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CEILING_KEYS, append, checkCeiling, claimedBy, context, currentFleet, effectiveCeiling, endOf, findEvents, fleetCeiling, fold,
  hasEvent, implicitFleet, isNarrower, iso, ledgerPaths, listFleets, listRecords, mergeCeiling, narrowingOf, parseBudget, readLedger,
  readMember, readRecord, recordPath, renderTree, sumSpend, swarmChain, swarmEndState, swarmId, writeCurrent, writeRecord,
} from "../src/openfleet.mjs";
import { NAME_RE } from "../src/herd.mjs";

const OPENFLEET_VARS = ["OPENFLEET_HOME", "OPENFLEET_RECORD", "OPENFLEET_FLEET", "OPENFLEET_MEMBER", "OPENFLEET_SWARM"];

/** Each test gets its own home; the module reads the env var on every call. */
function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-openfleet-test-"));
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

/* ------------------------------------------------------------- the record */

test("a record is written once, at 0600, and never overwritten", () => {
  withHome((dir) => {
    const record = { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "create-two-0541-1", extra: "kept" };
    const first = writeRecord(record);
    assert.equal(first.ok, true);
    assert.equal(first.path, path.join(dir, "fleets", "anthony@dev", "members", "create-two-0541-1.json"));
    assert.equal(first.path, recordPath("anthony@dev", "create-two-0541-1"));
    assert.equal(mode(first.path), 0o600);
    assert.equal(mode(path.dirname(first.path)), 0o700, "the directory is private too");
    assert.deepEqual(readRecord(first.path), record, "unknown keys are kept");
    assert.deepEqual(readMember("anthony@dev", "create-two-0541-1"), record);
    const second = writeRecord({ ...record, member: "create-two-0541-1", sysop: "impostor" });
    assert.equal(second.ok, false, "the record never changes after it is written");
    assert.equal(readRecord(first.path).sysop, "anthony@dev");
    assert.deepEqual(listFleets(), ["anthony@dev"]);
    assert.deepEqual(listRecords("anthony@dev").map((r) => r.member), ["create-two-0541-1"]);
  });
});

test("a missing or torn record reads as null rather than a throw", () => {
  withHome((dir) => {
    assert.equal(readRecord(path.join(dir, "nope.json")), null);
    fs.mkdirSync(path.join(dir, "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "x", "torn.json"), "{ not json");
    assert.equal(readRecord(path.join(dir, "x", "torn.json")), null);
    assert.deepEqual(listRecords("nobody"), []);
  });
});

test("current names the fleet new roots join, and absent means the implicit fleet", () => {
  withHome(() => {
    assert.equal(currentFleet(), null);
    assert.equal(writeCurrent("fleet-20260913"), true);
    assert.equal(currentFleet(), "fleet-20260913");
    assert.match(implicitFleet(), /^[^@]+@[^@]+$/);
  });
});

/* ------------------------------------------------------------- the ledger */

test("append adds at, fleet and host, keeps by and the event's keys, at 0600", () => {
  withHome((dir) => {
    const line = append("anthony@dev", { event: "swarm.spawn", by: "460a4502", swarm: "create-two-0541", task: "create two" }, { now: Date.UTC(2026, 8, 13, 5, 41, 1), host: "dev" });
    assert.deepEqual(Object.keys(line), ["at", "event", "fleet", "host", "by", "swarm", "task"], "the five common keys come first, in the spec's order");
    assert.equal(line.at, "2026-09-13T05:41:01Z");
    assert.equal(line.fleet, "anthony@dev");
    assert.equal(line.host, "dev");
    const file = path.join(dir, "fleets", "anthony@dev", "ledger.jsonl");
    assert.equal(mode(file), 0o600);
    assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify(line)}\n`);
    // A caller that knows the real time of the event keeps it: member.start at the submit moment.
    const kept = append("anthony@dev", { at: "2026-09-13T05:41:12Z", event: "member.start", by: "create-two-0541-1", member: "create-two-0541-1" }, { host: "dev" });
    assert.equal(kept.at, "2026-09-13T05:41:12Z");
    assert.equal(readLedger("anthony@dev").length, 2);
  });
});

test("append never throws: an unwritable home is a null line, not a failed swarm", () => {
  withHome((dir) => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "a file where the home should be");
    process.env.OPENFLEET_HOME = blocked;
    assert.equal(append("f", { event: "x", by: "sysop" }), null);
  });
});

test("readLedger merges every ledger*.jsonl under a fleet by at, and skips torn lines", () => {
  withHome((dir) => {
    const fleetDir = path.join(dir, "fleets", "team-20260913");
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.writeFileSync(path.join(fleetDir, "ledger.jsonl"), [
      JSON.stringify({ at: "2026-09-13T05:41:01Z", event: "swarm.spawn", fleet: "team-20260913", host: "dev", by: "a", swarm: "s" }),
      JSON.stringify({ at: "2026-09-13T05:43:00Z", event: "member.end", fleet: "team-20260913", host: "dev", by: "a", member: "s-1", state: "done" }),
      "{ torn",
    ].join("\n"));
    fs.writeFileSync(path.join(fleetDir, "ledger.netcup.jsonl"), [
      JSON.stringify({ at: "2026-09-13T05:42:00Z", event: "member.start", fleet: "team-20260913", host: "netcup", by: "s-2", member: "s-2" }),
      "",
    ].join("\n"));
    assert.equal(ledgerPaths("team-20260913").length, 2);
    const lines = readLedger("team-20260913");
    assert.deepEqual(lines.map((l) => l.event), ["swarm.spawn", "member.start", "member.end"]);
    assert.deepEqual(lines.map((l) => l.host), ["dev", "netcup", "dev"]);
    assert.deepEqual(readLedger("nobody"), []);
  });
});

test("a record with no member.start is unclaimed; the first start claims it", () => {
  withHome(() => {
    writeRecord({ openfleet: "0.1", fleet: "f", sysop: "s", member: "m-1" });
    assert.equal(claimedBy(readLedger("f"), "m-1"), null);
    assert.equal(hasEvent("f", "member.start", { member: "m-1" }), false);
    append("f", { event: "member.start", by: "m-1", member: "m-1", session: "172ffd83" });
    append("f", { event: "member.start", by: "m-1", member: "m-1", session: "second" });
    assert.equal(claimedBy(readLedger("f"), "m-1").session, "172ffd83", "the first claim counts");
    assert.equal(hasEvent("f", "member.start", { member: "m-1" }), true);
    assert.equal(hasEvent("f", "member.start", { member: "m-2" }), false);
  });
});

test("one end line counts: the first written, except lost, which a real end supersedes", () => {
  const lines = [
    { event: "member.end", member: "a", state: "lost" },
    { event: "member.end", member: "a", state: "done" },
    { event: "member.end", member: "b", state: "failed" },
    { event: "member.end", member: "b", state: "done" },
    { event: "member.end", member: "c", state: "lost" },
  ];
  assert.equal(endOf(lines, "a").state, "done", "lost gives way to the engine's own end");
  assert.equal(endOf(lines, "b").state, "failed", "otherwise the first line counts");
  assert.equal(endOf(lines, "c").state, "lost", "lost stands until something real arrives");
  assert.equal(endOf(lines, "d"), null);
  assert.equal(findEvents(lines, "member.end", { member: "b" }).length, 2);
});

test("a swarm ends done only when every member did, else the first failure state seen", () => {
  assert.equal(swarmEndState(["done", "done"]), "done");
  assert.equal(swarmEndState([{ state: "done" }, { state: "timeout" }, { state: "failed" }]), "timeout");
  assert.equal(swarmEndState(["stopped", "done"]), "stopped");
  assert.equal(swarmEndState(["done", "lost"]), "failed", "a lost member is not a finished swarm");
  assert.equal(swarmEndState([]), "failed", "nothing ended means nothing was done");
});

/* ------------------------------------------------------------ the ceiling */

test("a ceiling merges key by key, and unknown keys ride along", () => {
  const fleet = { approvals: "bypass", depth: 2, hosts: ["dev"], budget: "20 USD" };
  assert.deepEqual(mergeCeiling(fleet, { fan_out: 4, until: "2026-09-13T06:11:01Z" }), { ...fleet, fan_out: 4, until: "2026-09-13T06:11:01Z" });
  assert.deepEqual(mergeCeiling(fleet, {}), fleet);
  assert.deepEqual(mergeCeiling(fleet, { depth: null, approvals: undefined }), fleet, "null and undefined are not narrowings");
  assert.deepEqual(CEILING_KEYS, ["approvals", "budget", "depth", "fan_out", "hosts", "until"]);
});

test("narrower means: native under bypass, smaller numbers in the same unit, a subset of hosts, an earlier until", () => {
  const base = { approvals: "bypass", budget: "20 USD", depth: 2, fan_out: 4, hosts: ["dev", "netcup"], until: "2026-09-13T06:11:01Z" };
  assert.equal(isNarrower({ approvals: "native" }, base), true);
  assert.equal(isNarrower({ approvals: "bypass" }, base), true, "equal is within");
  assert.equal(isNarrower({ approvals: "bypass" }, { ...base, approvals: "native" }), false);
  assert.equal(isNarrower({ approvals: "bypass" }, {}), false, "absent means native");
  assert.equal(isNarrower({ budget: "10 USD" }, base), true);
  assert.equal(isNarrower({ budget: "30 USD" }, base), false);
  assert.equal(isNarrower({ budget: "10 EUR" }, base), false, "a different unit is not comparable");
  assert.equal(isNarrower({ budget: "1000 tokens" }, {}), true, "absent means uncapped");
  assert.equal(isNarrower({ depth: 1 }, base), true);
  assert.equal(isNarrower({ depth: 3 }, base), false);
  assert.equal(isNarrower({ depth: 2 }, {}), false, "absent depth means 1");
  assert.equal(isNarrower({ fan_out: 2 }, base), true);
  assert.equal(isNarrower({ fan_out: 8 }, base), false);
  assert.equal(isNarrower({ fan_out: 8 }, {}), true);
  assert.equal(isNarrower({ hosts: ["dev"] }, base), true);
  assert.equal(isNarrower({ hosts: ["dev", "mars"] }, base), false);
  assert.equal(isNarrower({ hosts: ["mars"] }, {}), true);
  assert.equal(isNarrower({ until: "2026-09-13T06:00:00Z" }, base), true);
  assert.equal(isNarrower({ until: "2026-09-13T07:00:00Z" }, base), false);
  assert.equal(isNarrower({ until: "not a time" }, base), false);
});

test("narrowingOf keeps only the keys that actually narrow, so a spawner never writes a widening", () => {
  const base = { approvals: "bypass", depth: 1, hosts: ["dev"], fan_out: 2 };
  assert.deepEqual(narrowingOf({ fan_out: 4, until: "2026-09-13T06:11:01Z" }, base), { until: "2026-09-13T06:11:01Z" }, "fan_out 4 under 2 is dropped");
  assert.deepEqual(narrowingOf({ fan_out: 4, until: "2026-09-13T06:11:01Z" }, { depth: 1, hosts: ["dev"] }), { fan_out: 4, until: "2026-09-13T06:11:01Z" });
  assert.deepEqual(narrowingOf({ hosts: ["dev"], depth: 1 }, base), {}, "what is inherited is not written twice");
});

test("checkCeiling names the first key that would be exceeded, with both values", () => {
  const allowed = { approvals: "native", depth: 1, fan_out: 4, hosts: ["dev"], until: "2026-09-13T06:11:01Z", budget: "20 USD" };
  const now = Date.UTC(2026, 8, 13, 5, 41, 0);
  assert.deepEqual(checkCeiling({ approvals: "bypass" }, allowed, { now }), { key: "approvals", wanted: "bypass", allowed: "native" });
  assert.equal(checkCeiling({ approvals: "bypass" }, { depth: 1, hosts: ["dev"] }, { now }), null, "no approvals key in the implicit fleet: the root supplies its own");
  assert.equal(checkCeiling({ approvals: "native" }, allowed, { now }), null);
  assert.deepEqual(checkCeiling({ depth: 2 }, allowed, { now }), { key: "depth", wanted: 2, allowed: 1 });
  assert.deepEqual(checkCeiling({ depth: 2 }, {}, { now }), { key: "depth", wanted: 2, allowed: 1 }, "absent depth means 1");
  assert.equal(checkCeiling({ depth: 1 }, allowed, { now }), null);
  assert.deepEqual(checkCeiling({ fan_out: 5 }, allowed, { now }), { key: "fan_out", wanted: 5, allowed: 4 });
  assert.equal(checkCeiling({ fan_out: 50 }, { depth: 1 }, { now }), null, "absent fan_out is the engine's default");
  assert.deepEqual(checkCeiling({ hosts: ["netcup"] }, allowed, { now }), { key: "hosts", wanted: ["netcup"], allowed: ["dev"] });
  assert.deepEqual(checkCeiling({ host: "netcup" }, allowed, { now }), { key: "hosts", wanted: ["netcup"], allowed: ["dev"] });
  assert.deepEqual(checkCeiling({}, allowed, { now: Date.UTC(2026, 8, 13, 6, 12, 0) }), { key: "until", wanted: "2026-09-13T06:12:00Z", allowed: "2026-09-13T06:11:01Z" });
  assert.deepEqual(checkCeiling({ until: "2026-09-13T07:00:00Z" }, allowed, { now }), { key: "until", wanted: "2026-09-13T07:00:00Z", allowed: "2026-09-13T06:11:01Z" });
  assert.deepEqual(checkCeiling({ budget: "25 USD" }, allowed, { now }), { key: "budget", wanted: "25 USD", allowed: "20 USD" });
  assert.equal(checkCeiling({ depth: 1, fan_out: 2, hosts: ["dev"], budget: "5 USD" }, allowed, { now }), null);
  assert.deepEqual(parseBudget("20 USD"), { amount: 20, unit: "USD" });
  assert.deepEqual(parseBudget("5000 tokens"), { amount: 5000, unit: "tokens" });
  assert.equal(parseBudget("lots"), null);
});

test("a fleet's ceiling is the latest cap on it, else fleet.open, else the implicit fleet's", () => {
  const implicit = fleetCeiling([], "anthony@dev", { host: "dev" });
  assert.deepEqual(implicit, { ceiling: { depth: 1, hosts: ["dev"] }, opened: false, line: null });
  const open = { at: "2026-09-13T05:00:00Z", event: "fleet.open", fleet: "f", host: "dev", by: "sysop", sysop: "anthony@dev", ceiling: { approvals: "bypass", depth: 2 } };
  const opened = fleetCeiling([open], "f", { host: "netcup" });
  assert.equal(opened.opened, true);
  assert.deepEqual(opened.ceiling, { approvals: "bypass", depth: 2, hosts: ["dev"] }, "absent hosts means the host the line was written on");
  const bare = fleetCeiling([{ ...open, ceiling: {} }], "f", { host: "dev" });
  assert.deepEqual(bare.ceiling, { approvals: "native", depth: 1, hosts: ["dev"] }, "an opened fleet with no approvals means native");
  const cap = { at: "2026-09-13T05:30:00Z", event: "fleet.cap", fleet: "f", host: "dev", by: "sysop", target: "f", ceiling: { approvals: "native", depth: 3 } };
  const other = { ...cap, at: "2026-09-13T05:20:00Z", target: "some-swarm", ceiling: { depth: 0 } };
  assert.deepEqual(fleetCeiling([open, other, cap], "f", { host: "dev" }).ceiling, { approvals: "native", depth: 3, hosts: ["dev"] }, "the latest cap on the fleet wins whole");
});

test("the effective ceiling merges the fleet's with every spawn on the path, a cap on a swarm applied last", () => {
  const lines = [
    { at: "2026-09-13T05:00:00Z", event: "fleet.open", fleet: "f", host: "dev", by: "sysop", sysop: "s", ceiling: { approvals: "bypass", depth: 3, hosts: ["dev", "netcup"] } },
    { at: "2026-09-13T05:41:01Z", event: "swarm.spawn", fleet: "f", host: "dev", by: "root", swarm: "outer-0541", task: "t", ceiling: { fan_out: 4, until: "2026-09-13T06:11:01Z" }, pieces: [] },
    { at: "2026-09-13T05:45:00Z", event: "swarm.spawn", fleet: "f", host: "dev", by: "outer-0541-1", swarm: "inner-0545", parent_swarm: "outer-0541", task: "t2", ceiling: { fan_out: 2 }, pieces: [] },
    { at: "2026-09-13T05:50:00Z", event: "fleet.cap", fleet: "f", host: "dev", by: "sysop", target: "outer-0541", ceiling: { approvals: "native" } },
  ];
  assert.deepEqual(swarmChain(lines, "inner-0545").map((l) => l.swarm), ["outer-0541", "inner-0545"]);
  assert.deepEqual(effectiveCeiling(lines, "f", { swarm: "inner-0545", host: "dev" }), {
    approvals: "native", depth: 3, hosts: ["dev", "netcup"], fan_out: 2, until: "2026-09-13T06:11:01Z",
  });
  assert.deepEqual(effectiveCeiling(lines, "f", { host: "dev" }), { approvals: "bypass", depth: 3, hosts: ["dev", "netcup"] });
  // The implicit fleet: approvals enter at the root, from the flags it was started with.
  assert.deepEqual(effectiveCeiling([], "anthony@dev", { rootApprovals: "bypass", host: "dev" }), { depth: 1, hosts: ["dev"], approvals: "bypass" });
});

/* ------------------------------------------------------------- the caller */

test("context resolves the fleet from the record, else OPENFLEET_FLEET, else current, else the implicit fleet", () => {
  withHome(() => {
    const none = context();
    assert.equal(none.fleet, implicitFleet());
    assert.equal(none.sysop, implicitFleet());
    assert.equal(none.member, null);
    assert.equal(none.agent, false);
    assert.equal(none.by, "sysop");
    assert.equal(none.opened, false);
    assert.equal(none.ceiling.approvals, undefined, "by hand, in the implicit fleet, the root supplies its own approvals");

    writeCurrent("team-20260913");
    append("team-20260913", { event: "fleet.open", by: "sysop", sysop: "https://example.com/anthony.md", ceiling: { approvals: "native", depth: 2 } }, { host: "dev" });
    const current = context();
    assert.equal(current.fleet, "team-20260913");
    assert.equal(current.sysop, "https://example.com/anthony.md");
    assert.equal(current.opened, true);
    assert.equal(current.ceiling.approvals, "native");

    process.env.OPENFLEET_FLEET = "other";
    assert.equal(context().fleet, "other", "OPENFLEET_FLEET overrides current");

    const record = { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "460a4502", depth: 0, approvals: "bypass", ceiling: { approvals: "bypass", depth: 1, hosts: ["dev"] } };
    const written = writeRecord(record);
    process.env.OPENFLEET_RECORD = written.path;
    process.env.OPENFLEET_MEMBER = "460a4502";
    const own = context();
    assert.equal(own.fleet, "anthony@dev", "the record wins over OPENFLEET_FLEET");
    assert.equal(own.member, "460a4502");
    assert.equal(own.agent, true);
    assert.equal(own.by, "460a4502");
    assert.equal(own.depth, 0);
    assert.deepEqual(own.ceiling, { approvals: "bypass", depth: 1, hosts: ["dev"] });
  });
});

test("inside a member of the implicit fleet, approvals come from the root of the parent chain", () => {
  withHome(() => {
    writeRecord({ openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "root", depth: 0, approvals: "native" });
    const child = writeRecord({ openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "root-1-1", parent: "root", swarm: "root-1", depth: 1, approvals: "bypass", ceiling: { approvals: "bypass", depth: 1 } });
    process.env.OPENFLEET_RECORD = child.path;
    assert.equal(context().ceiling.approvals, "native", "the root was started native, whatever a child's record copied");
    const orphan = writeRecord({ openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "stray", orphan: true, approvals: "bypass" });
    process.env.OPENFLEET_RECORD = orphan.path;
    assert.equal(context().ceiling.approvals, "native", "a root that carries orphan gets native");
    const missing = writeRecord({ openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "lonely", parent: "nobody", depth: 1, ceiling: { approvals: "bypass", depth: 1 } });
    process.env.OPENFLEET_RECORD = missing.path;
    assert.equal(context().ceiling.approvals, "bypass", "with the chain broken, the record's own ceiling is the witness");
  });
});

/* ---------------------------------------------------------------- the ids */

test("a swarm id is a short slug of the task and the UTC minute, and its member ids fit the pane name rule", () => {
  const now = Date.UTC(2026, 8, 13, 5, 41, 30);
  assert.equal(swarmId("create two ...", { now }), "create-two-0541");
  assert.equal(swarmId("Port the auth routes and the dashboard to the new API", { now }), "port-the-auth-routes-an-0541");
  assert.equal(swarmId("anything", { name: "api", now }), "api-0541");
  assert.equal(swarmId("2024 report", { now }), "report-0541", "a leading digit cannot start a pane name");
  assert.equal(swarmId("!!!", { now }), "agent-0541", "the herd's own fallback for a task with no letters");
  for (const task of ["create two ...", "a".repeat(80), "x-y-z-w-v-u-t-s-r-q-p-o-n-m-l-k"]) {
    const id = swarmId(task, { now });
    assert.ok(id.length <= 28, `${id} leaves room for -NN`);
    assert.match(`${id}-16`, NAME_RE, `${id}-16 must be a valid pane name`);
  }
  assert.equal(iso(now), "2026-09-13T05:41:30Z");
});

/* --------------------------------------------------------------- the fold */

// The spec's worked example: job 460a4502, a root of the implicit fleet, spawns
// create-two-0541 with two pieces; the planner's own call was a swarm of one.
const EXAMPLE_LINES = [
  { at: "2026-09-13T04:55:00Z", event: "member.start", fleet: "anthony@dev", host: "dev", by: "460a4502", member: "460a4502", engine: "claude-code", depth: 0, approvals: "bypass", cwd: "/home/anthony" },
  { at: "2026-09-13T05:40:50Z", event: "swarm.spawn", fleet: "anthony@dev", host: "dev", by: "460a4502", swarm: "460a4502-1", task: 'claude -p "Split the task below into at most 4 ..."', ceiling: {}, pieces: [{ member: "460a4502-1-1" }] },
  { at: "2026-09-13T05:40:51Z", event: "member.start", fleet: "anthony@dev", host: "dev", by: "460a4502-1-1", member: "460a4502-1-1", session: "31337", swarm: "460a4502-1", parent: "460a4502", depth: 1, engine: "claude-p", approvals: "bypass" },
  { at: "2026-09-13T05:41:00Z", event: "member.end", fleet: "anthony@dev", host: "dev", by: "460a4502-1-1", member: "460a4502-1-1", state: "done" },
  { at: "2026-09-13T05:41:00Z", event: "swarm.end", fleet: "anthony@dev", host: "dev", by: "460a4502", swarm: "460a4502-1", state: "done" },
  { at: "2026-09-13T05:41:01Z", event: "swarm.spawn", fleet: "anthony@dev", host: "dev", by: "460a4502", swarm: "create-two-0541", task: "create two ...", ceiling: { fan_out: 4, until: "2026-09-13T06:11:01Z" }, pieces: [{ member: "create-two-0541-1", title: "create hello.sh bash", owns: ["hello.sh"] }, { member: "create-two-0541-2", title: "create bye.sh bash", owns: ["bye.sh"] }] },
  { at: "2026-09-13T05:41:12Z", event: "member.start", fleet: "anthony@dev", host: "dev", by: "create-two-0541-1", member: "create-two-0541-1", session: "172ffd83", swarm: "create-two-0541", parent: "460a4502", depth: 1, engine: "claude-code", cwd: "/x", approvals: "bypass", piece: { title: "create hello.sh bash", owns: ["hello.sh"] } },
  { at: "2026-09-13T05:41:13Z", event: "member.start", fleet: "anthony@dev", host: "dev", by: "460a4502", member: "create-two-0541-2", session: "create-two-0541-2", swarm: "create-two-0541", parent: "460a4502", depth: 1, engine: "moshcode/claude", cwd: "/x", approvals: "bypass", piece: { title: "create bye.sh bash", owns: ["bye.sh"] } },
  { at: "2026-09-13T05:41:30Z", event: "member.spend", fleet: "anthony@dev", host: "dev", by: "create-two-0541-1", member: "create-two-0541-1", amount: "1200 tokens", total: "1200 tokens" },
  { at: "2026-09-13T05:41:36Z", event: "member.end", fleet: "anthony@dev", host: "dev", by: "create-two-0541-1", member: "create-two-0541-1", state: "done", summary: "Created hello.sh, mode -rwxrwxr-x, prints hello." },
];
const EXAMPLE_RECORDS = [
  { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "460a4502", engine: "claude-code", depth: 0, approvals: "bypass", host: "dev", started: "2026-09-13T04:55:00Z", ceiling: { approvals: "bypass", depth: 1, hosts: ["dev"] } },
  { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "create-two-0541-1", parent: "460a4502", swarm: "create-two-0541", task: "create two ...", piece: { title: "create hello.sh bash", owns: ["hello.sh"] }, depth: 1, engine: "claude-code", host: "dev", cwd: "/x", started: "2026-09-13T05:41:01Z", approvals: "bypass", ceiling: { approvals: "bypass", depth: 1, fan_out: 4, hosts: ["dev"], until: "2026-09-13T06:11:01Z" } },
  { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "create-two-0541-2", parent: "460a4502", swarm: "create-two-0541", task: "create two ...", piece: { title: "create bye.sh bash", owns: ["bye.sh"] }, depth: 1, engine: "moshcode/claude", session: "create-two-0541-2", host: "dev", cwd: "/x", started: "2026-09-13T05:41:01Z", approvals: "bypass", ceiling: { approvals: "bypass", depth: 1, fan_out: 4, hosts: ["dev"], until: "2026-09-13T06:11:01Z" } },
];

test("fold turns the worked example into the tree on the landing page", () => {
  const model = fold({ fleets: [{ fleet: "anthony@dev", lines: EXAMPLE_LINES, records: EXAMPLE_RECORDS }], host: "dev", implicit: "anthony@dev", now: Date.UTC(2026, 8, 13, 5, 42, 0) });
  assert.equal(model.fleets.length, 1);
  const f = model.fleets[0];
  assert.equal(f.implicit, true);
  assert.equal(f.sysop, "anthony@dev");
  assert.deepEqual(f.ceiling, { depth: 1, hosts: ["dev"] });
  assert.equal(f.spend, "1200 tokens");
  assert.deepEqual(f.nodes.map((n) => n.kind), ["member"], "one root, and the swarms hang under it");
  const root = f.nodes[0];
  assert.equal(root.member, "460a4502");
  assert.equal(root.state, "running");
  assert.equal(root.approvals, "bypass");
  assert.deepEqual(root.swarms.map((s) => s.swarm), ["460a4502-1", "create-two-0541"]);
  const [planner, swarm] = root.swarms;
  assert.equal(planner.state, "done");
  assert.equal(planner.members[0].engine, "claude-p");
  assert.equal(planner.members[0].session, "31337");
  assert.equal(swarm.state, "running");
  assert.equal(swarm.fan_out, 4);
  assert.equal(swarm.until, "2026-09-13T06:11:01Z");
  assert.equal(swarm.pieces, 2);
  assert.deepEqual(swarm.members.map((m) => m.member), ["create-two-0541-1", "create-two-0541-2"], "in piece order");
  const [one, two] = swarm.members;
  assert.equal(one.session, "172ffd83");
  assert.equal(one.state, "done");
  assert.equal(one.spend, "1200 tokens");
  assert.deepEqual(one.owns, ["hello.sh"]);
  assert.equal(one.title, "create hello.sh bash");
  assert.equal(two.state, "running");
  assert.equal(two.engine, "moshcode/claude");
  assert.equal(two.claimed, true);
  assert.equal(swarm.spend, "1200 tokens");

  const text = renderTree(model, { host: "dev" });
  const lines = text.split("\n");
  assert.equal(lines[0], "anthony@dev  (implicit fleet, sysop anthony@dev, depth 1, hosts dev, spent 1200 tokens)");
  assert.match(lines[1], /^└─ 460a4502  claude-code  running  \[bypass\]$/);
  assert.match(lines[2], /^   ├─ swarm 460a4502-1  "claude -p "Split the task below into \.\.\."  1 member  done$/, "a long task is clipped to 40 characters");
  assert.match(lines[3], /^   │  └─ 460a4502-1-1 \(31337\)  claude-p  done  \[bypass\]$/);
  assert.match(lines[4], /^   └─ swarm create-two-0541  "create two \.\.\."  2\/4 members  until 06:11  spent 1200 tokens$/);
  assert.match(lines[5], /^      ├─ create-two-0541-1 \(172ffd83\)  create hello\.sh bash  claude-code  done  \[bypass\]  owns hello\.sh  spent 1200 tokens$/);
  assert.match(lines[6], /^      └─ create-two-0541-2  create bye\.sh bash  moshcode\/claude  running  \[bypass\]  owns bye\.sh$/);
  assert.equal(lines.length, 7);
});

test("fold joins the herd roster: liveness for moshcode members, lost for a claimed pane the roster dropped, roster-only roots", () => {
  const live = fold({
    fleets: [{ fleet: "anthony@dev", lines: EXAMPLE_LINES, records: EXAMPLE_RECORDS }],
    roster: [
      { name: "create-two-0541-2", engine: "moshcode/claude", state: "working", alive: true, approvals: "bypass" },
      { name: "shell-1", engine: "moshcode/shell", state: "idle", alive: true, approvals: "native", cwd: "/home/anthony/src" },
    ],
    host: "dev", implicit: "anthony@dev",
  });
  const swarm = live.fleets[0].nodes[0].swarms[1];
  assert.equal(swarm.members[1].state, "working", "the roster's state, since the member is claimed and has no end line");
  assert.equal(swarm.members[1].live, true);
  assert.equal(swarm.members[1].lost, false);
  assert.equal(swarm.members[0].live, null, "a claude-code member is not in the herd roster; no liveness claimed");
  const rosterOnly = live.fleets[0].nodes.find((n) => n.member === "shell-1");
  assert.ok(rosterOnly, "a herd session with no record is a root of the implicit fleet");
  assert.equal(rosterOnly.rosterOnly, true);
  assert.equal(rosterOnly.depth, 0);
  assert.match(renderTree(live, { host: "dev" }), /shell-1  \/home\/anthony\/src  moshcode\/shell  idle  \[roster\]/);

  const dropped = fold({ fleets: [{ fleet: "anthony@dev", lines: EXAMPLE_LINES, records: EXAMPLE_RECORDS }], roster: [], host: "dev", implicit: "anthony@dev" });
  const gone = dropped.fleets[0].nodes[0].swarms[1].members[1];
  assert.equal(gone.state, "lost");
  assert.equal(gone.lost, true, "flagged so the tool writes the member.end");
  assert.equal(dropped.fleets.length, 1, "an empty roster invents no implicit fleet entry");
  assert.equal(dropped.fleets[0].nodes[0].swarms[1].members[0].lost, false, "an ended member is not lost");

  const noFleet = fold({ fleets: [], roster: [{ name: "api", engine: "moshcode/claude", state: "idle", alive: true, approvals: "bypass" }], host: "dev", implicit: "anthony@dev" });
  assert.equal(noFleet.fleets.length, 1);
  assert.equal(noFleet.fleets[0].implicit, true);
  assert.equal(noFleet.fleets[0].nodes[0].rosterOnly, true);
});

test("a swarm the sysop started by hand hangs under the fleet; an unclaimed record reads unclaimed; a swarm with no spawn line is drawn anyway", () => {
  const lines = [
    { at: "2026-09-13T05:41:01Z", event: "swarm.spawn", fleet: "anthony@dev", host: "dev", by: "sysop", swarm: "byhand-0541", task: "t", ceiling: {}, pieces: [{ member: "byhand-0541-1" }] },
    { at: "2026-09-13T05:41:02Z", event: "ceiling.refuse", fleet: "anthony@dev", host: "dev", by: "sysop", action: "spawn", key: "depth", wanted: 2, allowed: 1 },
  ];
  const records = [
    { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "byhand-0541-1", swarm: "byhand-0541", depth: 0, engine: "moshcode/codex", approvals: "native" },
    { openfleet: "0.1", fleet: "anthony@dev", sysop: "anthony@dev", member: "mystery-1", swarm: "mystery", parent: "nobody", depth: 1, engine: "moshcode/kimi" },
  ];
  const model = fold({ fleets: [{ fleet: "anthony@dev", lines, records }], host: "dev", implicit: "anthony@dev" });
  const f = model.fleets[0];
  assert.deepEqual(f.nodes.map((n) => `${n.kind}:${n.swarm}`), ["swarm:byhand-0541", "swarm:mystery"]);
  assert.equal(f.nodes[0].by, "sysop");
  assert.equal(f.nodes[0].members[0].state, "unclaimed");
  assert.equal(f.nodes[1].missing, true);
  assert.equal(f.refusals.length, 1);
  assert.match(renderTree(model, { host: "dev" }), /\[no swarm\.spawn\]/);
  assert.equal(sumSpend(["1 USD", "2 USD", "5 tokens", "junk"]), "3 USD + 5 tokens");
  assert.equal(sumSpend([]), null);
});
