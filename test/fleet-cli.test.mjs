// `moshcode fleet` (PRD 0016): the sysop's verbs over a mkdtemp OPENFLEET_HOME,
// with the herd roster and every engine stop faked. Nothing here touches
// ~/.openfleet, tmux, or a Claude Code job.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REFUSED, fleetCommand } from "../src/fleet-cli.mjs";
import * as fleet from "../src/openfleet.mjs";
import { strip } from "../src/ui.mjs";

const NOW = Date.UTC(2026, 8, 13, 5, 42, 0);
const FLEET = "anthony@dev";

/** A home, a fake world, and a runner that captures what the verbs print. */
function harness({ roster = [], env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-fleet-cli-test-"));
  const lines = [];
  const kills = [];
  const execs = [];
  const signals = [];
  const opts = {
    write: (l) => lines.push(strip(String(l))),
    env: { OPENFLEET_HOME: dir, ...env },
    now: () => NOW,
    host: "dev",
    roster: () => roster,
    kill: async (name) => { kills.push(name); return roster.some((r) => r.name === name) ? { ok: true } : { ok: false, error: "no such session" }; },
    exec: (bin, args) => { execs.push([bin, ...args]); return { ok: true }; },
    signal: (pid) => { signals.push(pid); return { ok: true }; },
  };
  return {
    dir, lines, kills, execs, signals, opts,
    run: (argv) => fleetCommand(argv, opts),
    ledger: (f = FLEET) => fleet.readLedger(f, opts.env),
    text: () => lines.join("\n"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const at = (hhmmss) => `2026-09-13T${hhmmss}Z`;

/** The worked example, plus a nested swarm the second piece spawned. */
function seed(h) {
  const { env } = h.opts;
  const put = (line, when) => fleet.append(FLEET, { ...line, at: when }, { env, host: "dev" });
  const rec = (r) => fleet.writeRecord({ openfleet: "0.1", fleet: FLEET, sysop: FLEET, host: "dev", ...r }, { env });
  rec({ member: "460a4502", engine: "claude-code", depth: 0, approvals: "bypass", ceiling: { approvals: "bypass", depth: 1, hosts: ["dev"] } });
  put({ event: "member.start", by: "460a4502", member: "460a4502", engine: "claude-code", depth: 0, approvals: "bypass" }, at("04:55:00"));
  put({ event: "swarm.spawn", by: "460a4502", swarm: "create-two-0541", task: "create two ...", ceiling: { fan_out: 4, until: at("06:11:01") },
    pieces: [{ member: "create-two-0541-1", title: "create hello.sh bash", owns: ["hello.sh"] }, { member: "create-two-0541-2", title: "create bye.sh bash", owns: ["bye.sh"] }] }, at("05:41:01"));
  const ceiling = { approvals: "bypass", depth: 2, fan_out: 4, hosts: ["dev"], until: at("06:11:01") };
  rec({ member: "create-two-0541-1", parent: "460a4502", swarm: "create-two-0541", task: "create two ...", piece: { title: "create hello.sh bash", owns: ["hello.sh"] }, depth: 1, engine: "claude-code", cwd: "/x", approvals: "bypass", ceiling });
  rec({ member: "create-two-0541-2", parent: "460a4502", swarm: "create-two-0541", task: "create two ...", piece: { title: "create bye.sh bash", owns: ["bye.sh"] }, depth: 1, engine: "moshcode/claude", session: "create-two-0541-2", cwd: "/x", approvals: "bypass", ceiling });
  put({ event: "member.start", by: "create-two-0541-1", member: "create-two-0541-1", session: "172ffd83", swarm: "create-two-0541", parent: "460a4502", depth: 1, engine: "claude-code", approvals: "bypass" }, at("05:41:12"));
  put({ event: "member.start", by: "460a4502", member: "create-two-0541-2", session: "create-two-0541-2", swarm: "create-two-0541", parent: "460a4502", depth: 1, engine: "moshcode/claude", approvals: "bypass" }, at("05:41:13"));
  put({ event: "member.end", by: "create-two-0541-1", member: "create-two-0541-1", state: "done", summary: "Created hello.sh." }, at("05:41:36"));
  // The second piece spawned a swarm of its own: a codex pane.
  put({ event: "swarm.spawn", by: "create-two-0541-2", swarm: "inner-0541", parent_swarm: "create-two-0541", task: "inner", ceiling: {}, pieces: [{ member: "inner-0541-1", title: "inner piece" }] }, at("05:41:40"));
  rec({ member: "inner-0541-1", parent: "create-two-0541-2", swarm: "inner-0541", task: "inner", piece: { title: "inner piece" }, depth: 2, engine: "moshcode/codex", session: "inner-0541-1", cwd: "/x", approvals: "native", ceiling: { ...ceiling, approvals: "native" } });
  put({ event: "member.start", by: "create-two-0541-2", member: "inner-0541-1", session: "inner-0541-1", swarm: "inner-0541", parent: "create-two-0541-2", depth: 2, engine: "moshcode/codex", approvals: "native" }, at("05:41:41"));
}

const ROSTER = [
  { name: "create-two-0541-2", engine: "moshcode/claude", state: "working", alive: true, approvals: "bypass", cwd: "/x" },
  { name: "inner-0541-1", engine: "moshcode/codex", state: "working", alive: true, approvals: "native", cwd: "/x" },
  { name: "scratch", engine: "moshcode/shell", state: "idle", alive: true, approvals: "native", cwd: "/home/anthony" },
];

/* --------------------------------------------------------------------- open */

test("open mints <name>-<yyyymmdd>, writes fleet.open by sysop with the ceiling, and makes it current", async () => {
  const h = harness();
  try {
    assert.equal(await h.run(["open", "--approvals", "bypass", "--depth", "2", "--until", "2h", "--hosts", "dev,netcup"]), 0);
    assert.equal(h.lines[0], "fleet-20260913", "the id is printed first, on its own line");
    const [line] = h.ledger("fleet-20260913");
    assert.equal(line.event, "fleet.open");
    assert.equal(line.by, "sysop");
    assert.equal(line.sysop, fleet.implicitFleet(h.opts.env));
    assert.equal(line.host, "dev");
    assert.deepEqual(line.ceiling, { approvals: "bypass", depth: 2, hosts: ["dev", "netcup"], until: at("07:42:00") });
    assert.equal(fleet.currentFleet(h.opts.env), "fleet-20260913");
    assert.equal(fs.statSync(path.join(h.dir, "current")).mode & 0o777, 0o600);

    assert.equal(await h.run(["open", "team", "--json", "--sysop", "https://example.com/anthony.md"]), 0);
    const json = JSON.parse(h.lines.at(-1));
    assert.equal(json.fleet, "team-20260913");
    assert.equal(json.sysop, "https://example.com/anthony.md");
    assert.deepEqual(json.ceiling, {}, "only the keys given; absent keys read as the spec says");
    assert.equal(fleet.currentFleet(h.opts.env), "team-20260913", "the latest open is current");

    assert.equal(await h.run(["open", "team"]), 0);
    assert.equal(h.lines.at(-2), "team-20260913-2", "a second fleet of the same name today gets a suffix");
  } finally { h.cleanup(); }
});

test("open validates its flags and writes nothing when one is wrong", async () => {
  const h = harness();
  try {
    assert.equal(await h.run(["open", "--approvals", "maybe"]), 1);
    assert.match(h.text(), /native or bypass/);
    assert.equal(await h.run(["open", "--budget", "lots"]), 1);
    assert.equal(await h.run(["open", "--depth", "two"]), 1);
    assert.equal(await h.run(["open", "--until", "someday"]), 1);
    assert.equal(await h.run(["open", "--wat"]), 1);
    assert.deepEqual(fleet.listFleets(h.opts.env), []);
  } finally { h.cleanup(); }
});

test("open and cap are the sysop's: a process carrying OPENFLEET_MEMBER is refused with exit 4 and nothing is written", async () => {
  const h = harness({ env: { OPENFLEET_MEMBER: "460a4502", OPENFLEET_FLEET: FLEET } });
  try {
    seed(h);
    const before = h.ledger().length;
    assert.equal(await h.run(["open"]), REFUSED);
    assert.match(h.text(), /open is the sysop's verb: this process is member 460a4502 of fleet anthony@dev/);
    assert.equal(await h.run(["cap", FLEET, "--approvals", "native"]), REFUSED);
    assert.equal(h.ledger().length, before);
    assert.deepEqual(fleet.listFleets(h.opts.env), [FLEET]);
    assert.equal(REFUSED, 4, "the same exit logicsrc fleet uses");
  } finally { h.cleanup(); }
});

/* ---------------------------------------------------------------------- cap */

test("cap on a fleet writes fleet.cap and stops the members now above the ceiling, through their own engines", async () => {
  const h = harness({ roster: ROSTER });
  try {
    seed(h);
    assert.equal(await h.run(["cap", FLEET, "--approvals", "native", "--depth", "2"]), 0);
    const cap = h.ledger().find((l) => l.event === "fleet.cap");
    assert.equal(cap.by, "sysop");
    assert.equal(cap.target, FLEET);
    assert.deepEqual(cap.ceiling, { approvals: "native", depth: 2 });
    // 460a4502 runs bypass under a now-native ceiling: a Claude Code job, so `claude stop`.
    assert.deepEqual(h.execs, [["claude", "stop", "460a4502"]]);
    // create-two-0541-2 too, a moshcode pane, so the herd kills it. inner-0541-1 is native and stays.
    assert.deepEqual(h.kills, ["create-two-0541-2"]);
    const ends = h.ledger().filter((l) => l.event === "member.end" && l.state === "stopped");
    assert.deepEqual(ends.map((l) => l.member), ["460a4502", "create-two-0541-2"]);
    assert.ok(ends.every((l) => l.by === "sysop"));
    assert.match(h.text(), /460a4502 stopped/);
    assert.equal(h.ledger().filter((l) => l.event === "member.end" && l.member === "create-two-0541-1").length, 1, "an ended member is left alone");
  } finally { h.cleanup(); }
});

test("cap on a swarm only narrows, and a widening is refused before anything is written", async () => {
  const h = harness({ roster: ROSTER });
  try {
    seed(h);
    const before = h.ledger().length;
    assert.equal(await h.run(["cap", "create-two-0541", "--fan-out", "8"]), 1);
    assert.match(h.text(), /never widens/);
    assert.equal(h.ledger().length, before);
    assert.equal(await h.run(["cap", "create-two-0541"]), 1, "a swarm cap names at least one key");
    assert.equal(await h.run(["cap", "create-two-0541", "--fan-out", "2", "--json"]), 0);
    const out = JSON.parse(h.lines.at(-1));
    assert.equal(out.kind, "swarm");
    assert.deepEqual(out.ceiling, { fan_out: 2 });
    assert.deepEqual(h.kills, [], "fan_out does not stop a running member");
    assert.equal(await h.run(["cap", "create-two-0541", "--approvals", "native"]), 0);
    assert.deepEqual(h.kills, ["create-two-0541-2"], "the bypass member of that swarm, and only it");
    assert.deepEqual(h.execs, []);
    assert.equal(await h.run(["cap", "nothing-here", "--depth", "1"]), 3);
  } finally { h.cleanup(); }
});

/* --------------------------------------------------------------------- tree */

test("tree draws the fleet from the records and the ledger, joined to the herd roster", async () => {
  const h = harness({ roster: ROSTER });
  try {
    seed(h);
    assert.equal(await h.run(["tree"]), 0);
    const text = h.text();
    assert.match(text, /^anthony@dev  \(implicit fleet, sysop anthony@dev, depth 1, hosts dev\)$/m);
    assert.match(text, /^├─ 460a4502  claude-code  running  \[bypass\]$/m);
    assert.match(text, /^│  └─ swarm create-two-0541  "create two \.\.\."  2\/4 members  until 06:11$/m);
    assert.match(text, /^│     ├─ create-two-0541-1 \(172ffd83\)  create hello\.sh bash  claude-code  done  \[bypass\]  owns hello\.sh$/m);
    assert.match(text, /^│     └─ create-two-0541-2  create bye\.sh bash  moshcode\/claude  working  \[bypass\]  owns bye\.sh$/m, "state from the roster");
    assert.match(text, /^│        └─ swarm inner-0541  "inner"  1\/4 member  until 06:11$/m);
    assert.match(text, /^│           └─ inner-0541-1  inner piece  moshcode\/codex  working$/m);
    assert.match(text, /^└─ scratch  \/home\/anthony  moshcode\/shell  idle  \[roster\]$/m, "a herd session with no record is a root, marked as from the roster");
    assert.equal(h.ledger().filter((l) => l.state === "lost").length, 0);

    h.lines.length = 0;
    assert.equal(await h.run(["tree", "--json"]), 0);
    const model = JSON.parse(h.text());
    assert.equal(model.fleets[0].fleet, FLEET);
    assert.equal(model.fleets[0].nodes[0].member, "460a4502");
    assert.equal(await h.run(["tree", "no-such-fleet"]), 3);
  } finally { h.cleanup(); }
});

test("tree writes member.end lost for a claimed moshcode member the roster no longer lists, by the caller", async () => {
  const h = harness({ roster: [ROSTER[2]] });
  try {
    seed(h);
    assert.equal(await h.run(["tree"]), 0);
    const lost = h.ledger().filter((l) => l.event === "member.end" && l.state === "lost");
    assert.deepEqual(lost.map((l) => l.member).sort(), ["create-two-0541-2", "inner-0541-1"]);
    assert.ok(lost.every((l) => l.by === "sysop"));
    assert.match(h.text(), /create-two-0541-2  create bye\.sh bash  moshcode\/claude  lost/);
    h.lines.length = 0;
    assert.equal(await h.run(["tree"]), 0);
    assert.equal(h.ledger().filter((l) => l.state === "lost").length, 2, "written once, not on every look");

    const agent = harness({ roster: [], env: { OPENFLEET_MEMBER: "460a4502" } });
    try {
      seed(agent);
      await agent.run(["tree"]);
      assert.ok(agent.ledger().filter((l) => l.state === "lost").every((l) => l.by === "460a4502"), "an agent's tool never writes sysop");
    } finally { agent.cleanup(); }
  } finally { h.cleanup(); }
});

test("an empty home says so, and a bare `fleet` is the tree", async () => {
  const h = harness();
  try {
    assert.equal(await h.run([]), 0);
    assert.match(h.text(), /no fleet yet/);
    assert.equal(await h.run(["--json"]), 0);
    assert.deepEqual(JSON.parse(h.lines.at(-1)).fleets, []);
    assert.equal(await h.run(["dance"]), 1);
    assert.match(h.text(), /unknown fleet verb "dance"/);
  } finally { h.cleanup(); }
});

/* --------------------------------------------------------------------- stop */

test("stop on a swarm ends nested swarms first, then its members through their engines, then writes one swarm.end", async () => {
  const h = harness({ roster: ROSTER });
  try {
    seed(h);
    assert.equal(await h.run(["stop", "create-two-0541"]), 0);
    assert.deepEqual(h.kills, ["inner-0541-1", "create-two-0541-2"], "the nested swarm's member goes first");
    assert.deepEqual(h.execs, [], "create-two-0541-1 had already ended: nothing is stopped twice");
    const tail = h.ledger().slice(-4).map((l) => `${l.event}:${l.member || l.swarm}:${l.state}`);
    assert.deepEqual(tail, [
      "member.end:inner-0541-1:stopped",
      "swarm.end:inner-0541:stopped",
      "member.end:create-two-0541-2:stopped",
      "swarm.end:create-two-0541:stopped",
    ]);
    assert.ok(h.ledger().slice(-4).every((l) => l.by === "sysop"));
    assert.match(h.text(), /swarm create-two-0541 ended stopped/);

    h.lines.length = 0;
    assert.equal(await h.run(["stop", "create-two-0541", "--json"]), 0);
    const again = JSON.parse(h.text());
    assert.ok(again.members.every((m) => m.outcome === "already-ended"));
    assert.ok(again.swarms.every((s) => s.state === "already-ended"), "one swarm.end per swarm, never two");
    assert.equal(h.ledger().filter((l) => l.event === "swarm.end").length, 2);
  } finally { h.cleanup(); }
});

test("stop on a member ends that member and nothing else; an ended member writes nothing", async () => {
  const h = harness({ roster: ROSTER });
  try {
    seed(h);
    assert.equal(await h.run(["stop", "inner-0541-1"]), 0);
    assert.deepEqual(h.kills, ["inner-0541-1"]);
    assert.equal(h.ledger().at(-1).event, "member.end");
    assert.equal(h.ledger().at(-1).member, "inner-0541-1");
    assert.equal(h.ledger().filter((l) => l.event === "swarm.end").length, 0);
    const before = h.ledger().length;
    assert.equal(await h.run(["stop", "create-two-0541-1"]), 0);
    assert.equal(h.ledger().length, before);
    assert.match(h.text(), /had already ended \(done\)/);
    assert.equal(await h.run(["stop", "nobody"]), 3);
    assert.equal(await h.run(["stop"]), 1);
  } finally { h.cleanup(); }
});

test("stop marks a member lost when its engine no longer has it, and reports one it cannot reach", async () => {
  const h = harness({ roster: [] });
  try {
    seed(h);
    assert.equal(await h.run(["stop", "inner-0541-1"]), 0);
    assert.equal(h.ledger().at(-1).state, "lost");
    fleet.writeRecord({ openfleet: "0.1", fleet: FLEET, sysop: FLEET, member: "odd-1", engine: "gemini-cli", session: "x" }, { env: h.opts.env });
    fleet.append(FLEET, { event: "member.start", by: "odd-1", member: "odd-1", engine: "gemini-cli" }, { env: h.opts.env, host: "dev" });
    assert.equal(await h.run(["stop", "odd-1"]), 3);
    assert.match(h.text(), /no engine to stop it through/);
    assert.ok(!h.ledger().some((l) => l.event === "member.end" && l.member === "odd-1"), "a member that was not stopped gets no end line");
    fleet.writeRecord({ openfleet: "0.1", fleet: FLEET, sysop: FLEET, member: "p-1", engine: "claude-p", session: "4242" }, { env: h.opts.env });
    fleet.append(FLEET, { event: "member.start", by: "p-1", member: "p-1", engine: "claude-p", session: "4242" }, { env: h.opts.env, host: "dev" });
    assert.equal(await h.run(["stop", "p-1"]), 0);
    assert.deepEqual(h.signals, [4242], "a claude -p is its pid");
  } finally { h.cleanup(); }
});

test("an agent stops only a swarm it spawned, or a member under one; --fleet, an ancestor and a sibling's swarm refuse", async () => {
  const spawner = harness({ roster: ROSTER, env: { OPENFLEET_MEMBER: "460a4502" } });
  try {
    seed(spawner);
    assert.equal(await spawner.run(["stop", "--fleet", FLEET]), REFUSED);
    assert.match(spawner.text(), /stop --fleet is the sysop's/);
    assert.equal(await spawner.run(["stop", "inner-0541-1"]), 0, "a member under a swarm it spawned, however deep");
    assert.equal(spawner.ledger().at(-1).by, "460a4502", "an agent's action carries its own id");
    assert.equal(await spawner.run(["stop", "create-two-0541"]), 0);
  } finally { spawner.cleanup(); }

  const sibling = harness({ roster: ROSTER, env: { OPENFLEET_MEMBER: "create-two-0541-1" } });
  try {
    seed(sibling);
    assert.equal(await sibling.run(["stop", "create-two-0541"]), REFUSED, "its own swarm is its parent's, not its own");
    assert.equal(await sibling.run(["stop", "inner-0541"]), REFUSED, "a sibling's swarm");
    assert.equal(await sibling.run(["stop", "460a4502"]), REFUSED, "an ancestor");
    assert.match(sibling.text(), /outside what member create-two-0541-1 spawned/);
    assert.deepEqual(sibling.kills, []);
  } finally { sibling.cleanup(); }

  const inner = harness({ roster: ROSTER, env: { OPENFLEET_MEMBER: "create-two-0541-2" } });
  try {
    seed(inner);
    assert.equal(await inner.run(["stop", "inner-0541"]), 0, "the swarm it spawned");
    assert.deepEqual(inner.kills, ["inner-0541-1"]);
  } finally { inner.cleanup(); }
});

test("stop --fleet ends every swarm and root member in the fleet", async () => {
  const h = harness({ roster: ROSTER });
  try {
    seed(h);
    assert.equal(await h.run(["stop", "--fleet", FLEET]), 0);
    // scratch has no record, but a herd session with none is a root member of
    // the implicit fleet (rule 12), and --fleet means everything in it.
    assert.deepEqual(h.kills, ["inner-0541-1", "create-two-0541-2", "scratch"]);
    assert.deepEqual(h.execs, [["claude", "stop", "460a4502"]]);
    assert.equal(h.ledger().filter((l) => l.event === "swarm.end").length, 2);
    assert.equal(await h.run(["stop", "--fleet", "nope"]), 3);
  } finally { h.cleanup(); }
});

/* ---------------------------------------------------------------------- log */

test("log reads the ledger in order and filters by member, swarm and since; --json is one object per line", async () => {
  const h = harness();
  try {
    seed(h);
    assert.equal(await h.run(["log"]), 0);
    const all = h.lines;
    assert.equal(all.length, h.ledger().length);
    assert.match(all[0], /^2026-09-13T04:55:00Z  member\.start\s+by 460a4502  460a4502 · claude-code · bypass$/);
    assert.match(all[1], /swarm\.spawn\s+by 460a4502  create-two-0541 "create two \.\.\." · 2 pieces · fan_out 4, until 2026-09-13T06:11:01Z/);
    assert.match(all[4], /member\.end\s+by create-two-0541-1  create-two-0541-1 · done · Created hello\.sh\./);

    h.lines.length = 0;
    assert.equal(await h.run(["log", "--member", "create-two-0541-1"]), 0);
    assert.deepEqual(h.lines.map((l) => l.split(/\s+/)[1]), ["member.start", "member.end"]);

    h.lines.length = 0;
    assert.equal(await h.run(["log", "--swarm", "create-two-0541", "--json"]), 0);
    const events = h.lines.map((l) => JSON.parse(l)).map((l) => l.event);
    assert.deepEqual(events, ["swarm.spawn", "member.start", "member.start", "member.end"], "a member's end line names no swarm, so membership comes from the records");

    h.lines.length = 0;
    assert.equal(await h.run(["log", "--since", at("05:41:40"), "--json"]), 0);
    assert.deepEqual(h.lines.map((l) => JSON.parse(l).event), ["swarm.spawn", "member.start"]);
    h.lines.length = 0;
    assert.equal(await h.run(["log", "--since", "10s"]), 0);
    assert.match(h.text(), /nothing in the ledger matches/);
    assert.equal(await h.run(["log", "--since", "yesterday-ish"]), 1);
  } finally { h.cleanup(); }
});
