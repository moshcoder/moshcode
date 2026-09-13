// Swarm (PRD 0015, PRD 0016): the flag grammar, the lenient readers of what a
// model says, the gate that keeps a swarm to N at a time, the four phases run
// against fakes (no tmux, no model), and the record every swarm now leaves
// behind: the swarm id, one record per member, and the ledger lines in order.
// The fleet's files are real, under a mkdtemp OPENFLEET_HOME per test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AGENTS, MAX_AGENTS, bootAnswer, endStateOf, parsePlan, parseSwarmArgs, parseVerdict, planPrompt, runSwarm,
  summaryOf, swarmCommand, swarmId, synthesisPrompt, throttled, verifyPrompt, waitForPrompt,
} from "../src/swarm.mjs";
import { ENGINES } from "../src/engines.mjs";
import { NAME_RE } from "../src/herd.mjs";
import * as openfleet from "../src/openfleet.mjs";

/* -------------------------------------------------------------- the flags */

test("the task is every positional word, so the pit and the CLI agree", () => {
  const cli = parseSwarmArgs(["port the auth routes", "--agents", "3"]);
  const pit = parseSwarmArgs(["port", "the", "auth", "routes", "--agents=3"]);
  assert.equal(cli.task, "port the auth routes");
  assert.equal(pit.task, "port the auth routes");
  assert.equal(cli.agents, 3);
  assert.equal(pit.agents, 3);
});

test("four at a time is the default, and the cap is the herd's", () => {
  assert.equal(DEFAULT_AGENTS, 4);
  assert.equal(parseSwarmArgs(["x"]).agents, 4);
  assert.match(parseSwarmArgs(["x", "--agents", "0"]).errors[0], /1 to/);
  assert.match(parseSwarmArgs(["x", "--agents", String(MAX_AGENTS + 1)]).errors[0], /1 to/);
  assert.match(parseSwarmArgs(["x", "--agents", "lots"]).errors[0], /whole number/);
});

test("the four defaults match the claude engine's settings cap", () => {
  // The whole point of the number: a swarm may not run more agents at once
  // than moshcode tells Claude's own workflows to.
  assert.equal(String(DEFAULT_AGENTS), ENGINES.claude.settings.defaults.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS);
});

test("an unknown flag is an error, not part of the task", () => {
  const parsed = parseSwarmArgs(["fix it", "--fast"]);
  assert.deepEqual(parsed.errors, ["unknown flag --fast"]);
  assert.equal(parsed.task, "fix it");
});

test("--timeout takes the herd's durations", () => {
  assert.equal(parseSwarmArgs(["x", "--timeout", "5m"]).timeoutMs, 300000);
  assert.equal(parseSwarmArgs(["x", "--timeout=90s"]).timeoutMs, 90000);
});

test("the swarm id comes from the task and the minute, and member ids fit the herd's name rule", () => {
  // The member id is the pane name (PRD 0016): `<swarm>-<n>` has to satisfy
  // NAME_RE with two digits to spare, so the swarm id stays short.
  const now = Date.UTC(2026, 8, 13, 5, 41, 0);
  const id = swarmId("Port the auth routes and the dashboard to the new API", { now });
  assert.match(id, /^[a-z][a-z0-9-]*-0541$/);
  assert.ok(id.length + 3 <= 32, "id plus -NN must fit NAME_RE");
  assert.match(`${id}-16`, NAME_RE);
  assert.equal(swarmId("anything", { name: "api", now }), "api-0541");
  assert.equal(swarmId("!!!", { now }), "agent-0541", "the herd's own fallback name for a task with no letters");
  assert.equal(swarmId("create two ...", { now }), "create-two-0541", "the spec's own example");
});

test("claude's trust dialog is answered with Down then Enter, never a bare Enter", () => {
  // Seen live: the dialog's default is "No, exit". A swarm that pressed Enter
  // on "something is blocking at boot" ended its own engine.
  const screen = " Quick safety check: Is this a project you created or one you trust? \n ❯ No, exit\n   Yes, I trust this folder\n";
  const answer = bootAnswer("claude", screen);
  assert.ok(answer, "the trust dialog was not recognised");
  assert.deepEqual(answer.keys, ["Down", "Enter"]);
  assert.equal(bootAnswer("claude", "? for shortcuts"), null);
  assert.equal(bootAnswer("codex", screen), null, "an engine with no boot spec answers nothing");
});

test("waiting for the prompt answers a boot dialog once and then sees idle", async () => {
  const trust = " Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder";
  let screens = [trust, trust, "? for shortcuts"];
  let states = ["unknown", "unknown", "idle"];
  const answers = [];
  let t = 0;
  const result = await waitForPrompt("s", {
    engine: "claude", timeoutMs: 10000, intervalMs: 1, now: () => (t += 1),
    look: () => ({ name: "s", alive: true, state: states.shift() ?? "idle" }),
    screen: () => screens.shift() ?? "",
    answer: (name, keys) => answers.push(keys),
  });
  assert.deepEqual(result, { outcome: "matched", state: "idle" });
  assert.deepEqual(answers, [["Down", "Enter"]], "the same dialog is never answered twice");
});

test("waiting for the prompt gives up on a session that ends or times out", async () => {
  const ended = await waitForPrompt("s", {
    engine: "claude", timeoutMs: 10000, intervalMs: 1,
    look: () => ({ name: "s", alive: false, state: "done" }), screen: () => "", answer: () => {},
  });
  assert.equal(ended.outcome, "ended");
  let t = 0;
  const late = await waitForPrompt("s", {
    engine: "claude", timeoutMs: 5, intervalMs: 1, now: () => (t += 3),
    look: () => ({ name: "s", alive: true, state: "unknown" }), screen: () => "", answer: () => {},
  });
  assert.equal(late.outcome, "timeout");
  const gone = await waitForPrompt("s", { engine: "claude", look: () => null, screen: () => "", answer: () => {} });
  assert.equal(gone.outcome, "gone");
});

/* ------------------------------------------------------------ the readers */

test("the plan is the first JSON array in the reply, whatever surrounds it", () => {
  const reply = 'Sure! Here is the split:\n```json\n[{"title":"a","prompt":"do a"},{"title":"b","prompt":"do b"}]\n```\nGood luck.';
  assert.deepEqual(parsePlan(reply), [{ title: "a", prompt: "do a" }, { title: "b", prompt: "do b" }]);
});

test("a plan keeps the files a piece owns, as data, and only when the planner gave some", () => {
  const reply = JSON.stringify([
    { title: "a", prompt: "do a", files: ["hello.sh", " lib/a.js ", "", 7] },
    { title: "b", prompt: "do b", files: [] },
    { title: "c", prompt: "do c" },
  ]);
  assert.deepEqual(parsePlan(reply), [
    { title: "a", prompt: "do a", files: ["hello.sh", "lib/a.js"] },
    { title: "b", prompt: "do b" },
    { title: "c", prompt: "do c" },
  ]);
  assert.match(planPrompt({ task: "T", agents: 2, cwd: "/x" }), /"files": \[/, "the planner is asked for them");
});

test("a plan is capped at --agents and drops entries with no prompt", () => {
  const reply = JSON.stringify([{ title: "a", prompt: "x" }, { title: "b" }, { prompt: "y" }, { title: "d", prompt: "z" }]);
  const plan = parsePlan(reply, { agents: 2 });
  assert.deepEqual(plan.map((p) => p.prompt), ["x", "y"]);
  assert.equal(plan[1].title, "piece 2", "an untitled piece still gets a name");
});

test("a plan that does not parse is null, not a throw", () => {
  assert.equal(parsePlan("I cannot split this."), null);
  assert.equal(parsePlan("[not json"), null);
  assert.equal(parsePlan("[]"), null);
  assert.equal(parsePlan('{"title":"a","prompt":"b"}'), null);
});

test("a verdict is read leniently and defaults to unknown", () => {
  assert.deepEqual(parseVerdict('{"refuted": false, "reason": "it shows the diff"}'), { refuted: false, reason: "it shows the diff" });
  assert.equal(parseVerdict("no").refuted, null);
  assert.equal(parseVerdict('{"reason":"hmm"}').refuted, null);
});

test("a member's summary is its SUMMARY: section when it wrote one, else the tail", () => {
  assert.equal(summaryOf("did things\nSUMMARY: wrote hello.sh, it prints hello"), "wrote hello.sh, it prints hello");
  assert.equal(summaryOf("first SUMMARY: no\nlater\nSummary: the last one counts"), "the last one counts");
  assert.equal(summaryOf("x".repeat(600), { max: 500 }).length, 500);
  assert.equal(summaryOf(""), "");
  assert.equal(endStateOf({ outcome: "matched", state: "idle" }), "done");
  assert.equal(endStateOf({ outcome: "matched", state: "done" }), "done");
  assert.equal(endStateOf({ outcome: "matched", state: "blocked" }), "failed", "a pane asking a question did not finish its piece");
  assert.equal(endStateOf({ outcome: "timeout" }), "timeout");
  assert.equal(endStateOf({ outcome: "gone" }), "lost");
  assert.equal(endStateOf({ outcome: "failed" }), "failed");
  assert.equal(endStateOf({ outcome: "ended" }), "failed");
});

/* ------------------------------------------------------------ the prompts */

test("the planning prompt asks for pieces that do not collide, as bare JSON", () => {
  const p = planPrompt({ task: "T", agents: 3, cwd: "/x" });
  assert.match(p, /at most 3/);
  assert.match(p, /do not edit the same files/);
  assert.match(p, /ONLY a JSON array/);
  assert.match(p, /SUMMARY:/);
  assert.match(p, /\/x/);
  assert.ok(p.endsWith("T"));
});

test("the headless calls are told to think, not act", () => {
  // Seen live: a synthesis run in the working directory did the task itself
  // instead of summarising what the agents had done.
  const guard = /Do not run commands, read or write files, or use any tool/;
  assert.match(planPrompt({ task: "T", agents: 2, cwd: "/x" }), guard);
  assert.match(verifyPrompt({ task: "T", piece: { title: "a", prompt: "a" }, output: "o" }), guard);
  assert.match(synthesisPrompt({ task: "T", results: [] }), guard);
});

test("the verifier is told to refute and to default to refuted", () => {
  const p = verifyPrompt({ task: "T", piece: { title: "a", prompt: "do a" }, output: "did a" });
  assert.match(p, /Try to refute/);
  assert.match(p, /Default to refuted=true/);
  assert.match(p, /did a$/);
});

test("the synthesis carries every piece, its state, and its verdict", () => {
  const p = synthesisPrompt({ task: "T", results: [
    { title: "a", state: "done", artifact: "A!" },
    { title: "b", state: "failed", artifact: "", verified: { refuted: true, reason: "no diff" } },
  ] });
  assert.match(p, /piece 1: a \(done\)/);
  assert.match(p, /piece 2: b \(failed, review: REFUTED: no diff\)/);
  assert.match(p, /A!/);
  assert.match(p, /\(no output captured\)/);
});

/* -------------------------------------------------------------- the gate */

test("throttled runs at most N at a time and keeps order", async () => {
  let running = 0, peak = 0;
  const out = await throttled([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 * (7 - n)));
    running--;
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
});

/* ------------------------------------------------------------- the phases */

// One minute, so the swarm id and every member id are known: `T` at 05:41
// UTC is swarm `t-0541`, members `t-0541-1`, `t-0541-2`, ... The clock ticks
// 100ms per look, because the ledger is sorted by `at` and a real run's lines
// are written in the order they happen.
const NOW = Date.UTC(2026, 8, 13, 5, 41, 0);
const SWARM = "t-0541";
const m = (n) => `${SWARM}-${n}`;
let clock = NOW;
const now = () => { clock += 100; return clock; };

const OPENFLEET_VARS = ["OPENFLEET_HOME", "OPENFLEET_RECORD", "OPENFLEET_FLEET", "OPENFLEET_MEMBER", "OPENFLEET_SWARM"];

/** A fresh fleet home per test; the module reads the env var on every call. */
async function inHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-swarm-test-"));
  const previous = Object.fromEntries(OPENFLEET_VARS.map((k) => [k, process.env[k]]));
  for (const k of OPENFLEET_VARS) delete process.env[k];
  process.env.OPENFLEET_HOME = dir;
  clock = NOW;
  try { return await fn(dir); }
  finally {
    for (const k of OPENFLEET_VARS) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const fleetOf = () => openfleet.implicitFleet();
const ledger = () => openfleet.readLedger(fleetOf());
const events = () => ledger().map((l) => l.event);

function fakes({ plan, verdict = { refuted: false, reason: "fine" }, synthesis = "THE ANSWER", failStart = [], neverReady = [], artifact = (name) => `output of ${name}` } = {}) {
  const calls = { ai: [], start: [], boot: [], prompt: [], kill: [], killSeen: [] };
  let running = 0, peak = 0;
  const deps = {
    ai: (engine, prompt, options = {}) => {
      calls.ai.push({ engine, prompt, options });
      if (prompt.startsWith("You are planning")) return typeof plan === "string" ? plan : JSON.stringify(plan);
      if (prompt.startsWith("You are a skeptical")) return JSON.stringify(verdict);
      return synthesis;
    },
    // Each start notes what the ledger already held, so a test can say what
    // was written before the first member began.
    start: (name, opts) => { calls.start.push({ name, ...opts, seen: events() }); return failStart.includes(name) ? { ok: false, error: "tmux said no" } : { ok: true }; },
    boot: async (name) => { calls.boot.push(name); return neverReady.includes(name) ? { outcome: "timeout", state: "working" } : { outcome: "matched", state: "idle" }; },
    prompt: async (name, text, { onSubmitted, timeoutMs } = {}) => {
      running++; peak = Math.max(peak, running);
      onSubmitted?.({ at: now(), task: `t-${name}` });
      await new Promise((r) => setTimeout(r, 5));
      running--;
      calls.prompt.push({ name, text, timeoutMs });
      return { ok: true, task: `t-${name}`, outcome: "matched", state: "done", artifact: artifact(name), error: null };
    },
    kill: async (name) => { calls.kill.push(name); calls.killSeen.push(events()); },
  };
  return { deps, calls, peak: () => peak };
}

const engineOf = () => "claude";
const run = (options, { deps }, extra = {}) => runSwarm(
  { task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000, ...options },
  { deps, engineOf, now, ...extra },
);

/** A parent record for moshcode to run inside, claimed, with its effective ceiling. */
function insideMember({ member = "460a4502", depth = 0, approvals = "bypass", ceiling = { approvals, depth: 1, hosts: [openfleet.host()] }, swarm = null } = {}) {
  const record = { openfleet: "0.1", fleet: fleetOf(), sysop: fleetOf(), member, ...(swarm ? { swarm } : {}), depth, engine: "claude-code", approvals, ceiling };
  const written = openfleet.writeRecord(record);
  openfleet.append(fleetOf(), { event: "member.start", by: member, member, engine: "claude-code", depth, approvals });
  process.env.OPENFLEET_RECORD = written.path;
  process.env.OPENFLEET_FLEET = fleetOf();
  process.env.OPENFLEET_MEMBER = member;
  return record;
}

test("a swarm plans, fans out, kills its sessions, and synthesises", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "do a\nthen b" }, { title: "b", prompt: "do b" }] });
  const lines = [];
  const result = await run({}, f, { write: (l) => lines.push(l) });
  assert.equal(result.ok, true);
  assert.equal(result.engine, "claude");
  assert.equal(result.swarm, SWARM);
  assert.equal(result.fleet, fleetOf());
  assert.deepEqual(result.plan.map((p) => p.title), ["a", "b"]);
  assert.deepEqual(f.calls.start.map((s) => s.name), [m(1), m(2)], "panes are named after their member ids");
  assert.equal(f.calls.start[0].herd, "swarm");
  assert.equal(f.calls.start[0].cwd, "/x");
  assert.equal(f.calls.prompt[0].text, "do a then b", "a newline in a prompt would submit it early");
  assert.deepEqual(f.calls.kill, [m(1), m(2)], "sessions are ended when the swarm is done");
  assert.equal(result.results[1].task, `t-${m(2)}`);
  assert.equal(result.results[1].member, m(2));
  assert.equal(result.results[1].session, m(2));
  assert.equal(result.results[1].artifact, `output of ${m(2)}`);
  assert.equal(result.synthesis, "THE ANSWER");
  const synth = f.calls.ai.at(-1).prompt;
  assert.match(synth, new RegExp(`output of ${m(1)}`));
  assert.match(synth, new RegExp(`output of ${m(2)}`));
  assert.equal(f.calls.ai.length, 2, "plan, synthesis, and no verifier unless asked");
}));

test("the record of a swarm: spawn before the first start, one record and the four variables per member, start on submit, ends before the kills", () => inHome(async (home) => {
  const f = fakes({
    plan: [{ title: "a", prompt: "do a", files: ["a.js"] }, { title: "b", prompt: "do b" }],
    artifact: (name) => `worked on ${name}\nSUMMARY: ${name} is done`,
  });
  const result = await run({}, f);
  const fleet = fleetOf();
  const host = openfleet.host();

  // swarm.spawn, by the sysop since moshcode ran by hand, before any start.
  const spawn = ledger().find((l) => l.event === "swarm.spawn");
  assert.ok(spawn, "swarm.spawn was written");
  assert.deepEqual(f.calls.start[0].seen, ["swarm.spawn"], "it precedes the first member start");
  assert.equal(spawn.by, "sysop");
  assert.equal(spawn.fleet, fleet);
  assert.equal(spawn.host, host);
  assert.equal(spawn.swarm, SWARM);
  assert.equal(spawn.task, "T");
  assert.equal(spawn.parent_swarm, undefined, "no parent swarm when the sysop starts it by hand");
  const until = openfleet.iso(Date.parse(spawn.at) + 1000);
  assert.deepEqual(spawn.ceiling, { fan_out: 4, until }, "the narrowing from --agents and --timeout, from the moment of the spawn");
  assert.deepEqual(spawn.pieces, [{ member: m(1), title: "a", owns: ["a.js"] }, { member: m(2), title: "b" }]);

  // One unclaimed record per member, with exactly the spec's keys.
  const record = openfleet.readMember(fleet, m(1));
  assert.deepEqual(Object.keys(record), ["openfleet", "fleet", "sysop", "member", "swarm", "task", "piece", "depth", "engine", "session", "host", "cwd", "started", "approvals", "ceiling"]);
  assert.equal(record.openfleet, "0.1");
  assert.equal(record.sysop, fleet);
  assert.equal(record.parent, undefined, "members of a sysop-started swarm have no parent");
  assert.equal(record.depth, 0);
  assert.deepEqual(record.piece, { title: "a", owns: ["a.js"] });
  assert.deepEqual(openfleet.readMember(fleet, m(2)).piece, { title: "b" }, "no owns when the planner gave no files");
  assert.equal(record.engine, "moshcode/claude");
  assert.equal(record.session, m(1), "the pane name is the tmux target");
  assert.equal(record.cwd, "/x");
  assert.equal(record.approvals, "bypass", "truthful: the pane runs claude --dangerously-skip-permissions");
  assert.deepEqual(record.ceiling, { depth: 1, hosts: [host], fan_out: 4, until, approvals: "bypass" }, "a member of a swarm the sysop started by hand is its own root: its record carries its own approvals");
  assert.equal(fs.statSync(openfleet.recordPath(fleet, m(1))).mode & 0o777, 0o600);

  // The four variables, plus the home, reach the pane.
  assert.deepEqual(f.calls.start[0].env, {
    OPENFLEET_HOME: home, OPENFLEET_RECORD: openfleet.recordPath(fleet, m(1)), OPENFLEET_FLEET: fleet, OPENFLEET_MEMBER: m(1), OPENFLEET_SWARM: SWARM,
  });

  // member.start on behalf of the pane, at the submit moment.
  const starts = ledger().filter((l) => l.event === "member.start");
  assert.deepEqual(starts.map((l) => l.member), [m(1), m(2)]);
  assert.ok(starts[0].at >= spawn.at, "at is the submit moment, at or after the spawn (the sort is stable within a second)");
  assert.equal(starts[0].by, "sysop", "the starter wrote it, not the session");
  assert.equal(starts[0].session, m(1));
  assert.equal(starts[0].swarm, SWARM);
  assert.equal(starts[0].engine, "moshcode/claude");
  assert.equal(starts[0].approvals, "bypass");
  assert.deepEqual(starts[0].piece, { title: "a", owns: ["a.js"] });

  // member.end for each, then one swarm.end with the synthesis, then the kills.
  const ends = ledger().filter((l) => l.event === "member.end");
  assert.deepEqual(ends.map((l) => [l.member, l.state, l.summary]), [[m(1), "done", `${m(1)} is done`], [m(2), "done", `${m(2)} is done`]]);
  assert.ok(ends[0].at >= starts[1].at, "and the ends come after every start");
  const end = ledger().find((l) => l.event === "swarm.end");
  assert.equal(end.state, "done");
  assert.equal(end.summary, "THE ANSWER");
  assert.equal(end.verdict, undefined, "no verdict unless --verify ran");
  assert.equal(end.by, "sysop");
  assert.deepEqual(events(), ["swarm.spawn", "member.start", "member.start", "member.end", "member.end", "swarm.end"]);
  assert.deepEqual(f.calls.killSeen[0], events(), "every line was written before the first kill");
  assert.equal(result.ok, true);
}));

test("inside a member, the swarm's parent is that member and the members sit one deeper", () => inHome(async () => {
  insideMember({ member: "460a4502", depth: 0, approvals: "bypass" });
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const result = await run({}, f);
  assert.equal(result.ok, true);
  const spawn = ledger().find((l) => l.event === "swarm.spawn");
  assert.equal(spawn.by, "460a4502");
  assert.equal(spawn.parent_swarm, undefined, "the parent is a root, in no swarm");
  const record = openfleet.readMember(fleetOf(), m(1));
  assert.equal(record.parent, "460a4502");
  assert.equal(record.depth, 1);
  assert.equal(record.ceiling.approvals, "bypass", "the root's approvals reach its subtree");
  const start = ledger().find((l) => l.event === "member.start" && l.member === m(1));
  assert.equal(start.by, "460a4502");
  assert.equal(start.parent, "460a4502");
  assert.equal(start.depth, 1);
  assert.equal(ledger().find((l) => l.event === "swarm.end").by, "460a4502");
  assert.equal(f.calls.start[0].env.OPENFLEET_MEMBER, m(1));
}));

test("inside a member that is itself in a swarm, parent_swarm names it", () => inHome(async () => {
  openfleet.append(fleetOf(), { event: "swarm.spawn", by: "root", swarm: "outer-0500", task: "outer", ceiling: {}, pieces: [{ member: "outer-0500-1" }] });
  insideMember({ member: "outer-0500-1", depth: 0, approvals: "bypass", ceiling: { approvals: "bypass", depth: 2, hosts: [openfleet.host()] }, swarm: "outer-0500" });
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  await run({}, f);
  const spawn = ledger().find((l) => l.event === "swarm.spawn" && l.swarm === SWARM);
  assert.equal(spawn.parent_swarm, "outer-0500");
  assert.equal(spawn.by, "outer-0500-1");
}));

test("a bypass flag under a native parent is refused with ceiling.refuse, and nothing else is written or started", () => inHome(async () => {
  insideMember({ member: "460a4502", depth: 0, approvals: "native" });
  const f = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  const lines = [];
  const result = await run({}, f, { write: (l) => lines.push(l) });
  assert.equal(result.ok, false);
  assert.match(result.error, /refuses approvals/);
  assert.deepEqual(result.refused, { key: "approvals", wanted: "bypass", allowed: "native" });
  assert.deepEqual(result.results.map((r) => [r.member, r.state, r.outcome]), [[m(1), "failed", "refused"], [m(2), "failed", "refused"]]);
  assert.deepEqual(f.calls.start, [], "no member starts");
  assert.deepEqual(f.calls.kill, []);
  assert.equal(f.calls.ai.length, 1, "the plan ran; the synthesis has nothing to fold");
  const refusals = ledger().filter((l) => l.event === "ceiling.refuse");
  assert.deepEqual(refusals.map((l) => [l.member, l.action, l.key, l.wanted, l.allowed, l.by]), [
    [m(1), "start", "approvals", "bypass", "native", "460a4502"],
    [m(2), "start", "approvals", "bypass", "native", "460a4502"],
  ]);
  assert.deepEqual(events().filter((e) => e !== "member.start" && e !== "ceiling.refuse"), [], "no swarm.spawn, no ends");
  assert.equal(openfleet.readMember(fleetOf(), m(1)), null, "no record");
  assert.ok(lines.some((l) => /refuses approvals/.test(l)));
}));

test("a swarm that would sit too deep is refused on depth, once, before anything is written", () => inHome(async () => {
  insideMember({ member: "460a4502-1-1", depth: 1, approvals: "bypass" });
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const result = await run({}, f);
  assert.equal(result.ok, false);
  assert.deepEqual(result.refused, { key: "depth", wanted: 2, allowed: 1 });
  const refusals = ledger().filter((l) => l.event === "ceiling.refuse");
  assert.equal(refusals.length, 1, "a swarm-wide key refuses the spawn itself, once");
  assert.equal(refusals[0].action, "spawn");
  assert.equal(refusals[0].member, undefined, "no record exists to name");
  assert.equal(refusals[0].by, "460a4502-1-1");
  assert.deepEqual(f.calls.start, []);
}));

test("run by hand in the implicit fleet, the bypass flag is the sysop's own choice and passes", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const result = await run({}, f);
  assert.equal(result.ok, true);
  assert.equal(ledger().filter((l) => l.event === "ceiling.refuse").length, 0);
  assert.equal(openfleet.readMember(fleetOf(), m(1)).ceiling.approvals, "bypass", "no fleet-level approvals in the implicit fleet: the root, which this member is, supplies its own");
  assert.equal(openfleet.context({ ...process.env, OPENFLEET_RECORD: openfleet.recordPath(fleetOf(), m(1)) }).ceiling.approvals, "bypass", "and every reader agrees");
}));

test("an opened fleet's ceiling applies: native means the bypass flag is refused, and fan_out caps the plan", () => inHome(async () => {
  openfleet.writeCurrent("team-20260913");
  openfleet.append("team-20260913", { event: "fleet.open", by: "sysop", sysop: "anthony@dev", ceiling: { approvals: "bypass", depth: 2, fan_out: 2 } });
  const f = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }, { title: "c", prompt: "c" }] });
  const result = await run({}, f);
  assert.equal(result.fleet, "team-20260913", "current names the fleet new roots join");
  assert.equal(result.ok, false);
  assert.deepEqual(result.refused, { key: "fan_out", wanted: 3, allowed: 2 });
  const [refusal] = openfleet.readLedger("team-20260913").filter((l) => l.event === "ceiling.refuse");
  assert.equal(refusal.by, "sysop");
  const ok = await run({ agents: 2 }, fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] }));
  assert.equal(ok.ok, true);
  const spawn = openfleet.readLedger("team-20260913").find((l) => l.event === "swarm.spawn");
  assert.deepEqual(spawn.ceiling, { until: openfleet.iso(Date.parse(spawn.at) + 1000) }, "fan_out 2 equals what is inherited, so only until is a narrowing");
  assert.equal(openfleet.readMember("team-20260913", m(1)).sysop, "anthony@dev");
}));

test("the planner, the skeptic and the synthesis run without OPENFLEET_SWARM", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  await run({ verify: true }, f);
  assert.equal(f.calls.ai.length, 3);
  for (const call of f.calls.ai) assert.deepEqual(call.options.omitEnv, ["OPENFLEET_SWARM"], `${call.prompt.slice(0, 20)} must not carry the swarm`);
  assert.equal(f.calls.ai[0].options.cwd, "/x");
}));

test("--agents caps the plan as well as gating the sessions", () => inHome(async () => {
  // A model that answers with more pieces than it was asked for does not get
  // to run more agents than the operator allowed.
  const plan = Array.from({ length: 6 }, (_, i) => ({ title: `p${i}`, prompt: `do ${i}` }));
  const f = fakes({ plan });
  const result = await run({ agents: 2 }, f);
  assert.equal(result.results.length, 2);
  assert.ok(f.peak() <= 2);
  const spawn = ledger().find((l) => l.event === "swarm.spawn");
  assert.equal(spawn.ceiling.until, openfleet.iso(Date.parse(spawn.at) + 1000), "one batch of two at --agents 2");
}));

test("the until narrowing is one --timeout per batch, and a plan capped at --agents is one batch", () => inHome(async () => {
  const plan = Array.from({ length: 5 }, (_, i) => ({ title: `p${i}`, prompt: `do ${i}` }));
  const result = await run({ agents: 2, timeoutMs: 60000 }, fakes({ plan }));
  assert.equal(result.plan.length, 2, "the plan never holds more pieces than --agents");
  const spawn = ledger().find((l) => l.event === "swarm.spawn");
  assert.equal(spawn.ceiling.until, openfleet.iso(Date.parse(spawn.at) + 60000));
}));

test("a plan the model fluffs becomes one piece holding the whole task, and says so", () => inHome(async () => {
  const f = fakes({ plan: "I would rather not." });
  const lines = [];
  const result = await run({}, f, { write: (l) => lines.push(l) });
  assert.equal(result.plan.length, 1);
  assert.match(result.plan[0].prompt, /^T\b/);
  assert.match(result.plan[0].prompt, /SUMMARY:/);
  assert.ok(lines.some((l) => /did not parse/.test(l)));
  assert.equal(f.calls.start.length, 1);
  assert.deepEqual(openfleet.readMember(fleetOf(), m(1)).piece, { title: "the whole task" });
}));

test("a planning call that throws degrades the same way", () => inHome(async () => {
  const f = fakes({ plan: [] });
  f.deps.ai = (engine, prompt) => { if (prompt.startsWith("You are planning")) throw new Error("boom"); return "S"; };
  const lines = [];
  const result = await run({}, f, { write: (l) => lines.push(l) });
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 1);
  assert.ok(lines.some((l) => /planning failed \(boom\)/.test(l)));
}));

test("a piece whose session never starts or never boots is failed, not fatal, and its end line says so", () => inHome(async () => {
  const f = fakes({
    plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }, { title: "c", prompt: "c" }],
    failStart: [m(1)], neverReady: [m(2)],
  });
  const result = await run({}, f);
  assert.equal(result.ok, true, "the synthesis still ran");
  assert.deepEqual(result.results.map((r) => r.state), ["failed", "failed", "done"]);
  assert.match(result.results[0].error, /tmux said no/);
  assert.match(result.results[1].error, /never became ready/);
  assert.deepEqual(f.calls.kill, [m(2), m(3)], "a session that booted but never answered is still ended; one that never started is not");
  assert.match(f.calls.ai.at(-1).prompt, /piece 1: a \(failed\)/);
  const ends = ledger().filter((l) => l.event === "member.end");
  assert.deepEqual(ends.map((l) => [l.member, l.state]), [[m(1), "failed"], [m(2), "timeout"], [m(3), "done"]]);
  assert.match(ends[0].summary, /tmux said no/);
  assert.equal(ledger().find((l) => l.event === "swarm.end").state, "failed", "the first failure state among the members");
  assert.deepEqual(events().slice(-4), ["member.end", "member.end", "member.end", "swarm.end"]);
}));

test("--verify attaches a verdict to every piece, shows it to the synthesis, and writes it into swarm.end", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }], verdict: { refuted: true, reason: "claims a test it never ran" } });
  const result = await run({ verify: true }, f);
  assert.deepEqual(result.results[0].verified, { refuted: true, reason: "claims a test it never ran" });
  assert.equal(f.calls.ai.length, 3, "plan, verify, synthesis");
  assert.match(f.calls.ai[1].prompt, new RegExp(`output of ${m(1)}`));
  assert.match(f.calls.ai.at(-1).prompt, /REFUTED: claims a test it never ran/);
  const end = ledger().find((l) => l.event === "swarm.end");
  assert.deepEqual(end.verdict, [{ member: m(1), refuted: true, reason: "claims a test it never ran" }]);
}));

test("a pane that ends its wait blocked, asking a question, is written failed, and its swarm with it", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  const inner = f.deps.prompt;
  f.deps.prompt = async (name, text, opts) => {
    const r = await inner(name, text, opts);
    return name === m(1) ? { ...r, state: "blocked" } : r;
  };
  const result = await run({}, f);
  assert.equal(result.ok, true, "the synthesis still ran");
  const ends = ledger().filter((l) => l.event === "member.end");
  assert.deepEqual(ends.map((l) => [l.member, l.state]), [[m(1), "failed"], [m(2), "done"]]);
  assert.equal(ledger().find((l) => l.event === "swarm.end").state, "failed");
}));

test("an inherited until earlier than --timeout clamps each prompt's wait, so the swarm ends when the ceiling says", () => inHome(async () => {
  openfleet.writeCurrent("team-20260913");
  const until = openfleet.iso(NOW + 30 * 1000);
  openfleet.append("team-20260913", { event: "fleet.open", by: "sysop", sysop: "anthony@dev", ceiling: { approvals: "bypass", depth: 2, until } });
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const result = await run({ timeoutMs: 60 * 1000 }, f);
  assert.equal(result.ok, true);
  const spawn = openfleet.readLedger("team-20260913").find((l) => l.event === "swarm.spawn");
  assert.equal(spawn.ceiling.until, undefined, "sixty seconds out is wider than the fleet's thirty: not a narrowing");
  assert.equal(openfleet.readMember("team-20260913", m(1)).ceiling.until, until);
  const waited = f.calls.prompt[0].timeoutMs;
  assert.ok(waited > 0 && waited <= 30 * 1000, `waited ${waited}ms, within the fleet's deadline`);
  assert.ok(waited < 60 * 1000, "not the full --timeout");
}));

test("a one-piece swarm is the spawner's to end: swarm.end follows member.end, by moshcode, never treated as an engine's swarm of one", () => inHome(async () => {
  insideMember({ member: "460a4502", depth: 0, approvals: "bypass" });
  const f = fakes({ plan: [{ title: "only", prompt: "do it" }] });
  await run({}, f);
  const mine = ledger().filter((l) => l.swarm === SWARM || l.member === m(1)).map((l) => `${l.event}:${l.by}`);
  assert.deepEqual(mine, ["swarm.spawn:460a4502", "member.start:460a4502", "member.end:460a4502", "swarm.end:460a4502"]);
  assert.equal(ledger().find((l) => l.event === "swarm.end").swarm, SWARM, "the spawner's id, not <parent>-<n>");
}));

test("a session that already wrote its own member.start and member.end is left alone", () => inHome(async () => {
  // A claude pane with hooks claims its record and ends it itself; moshcode
  // writes neither line twice, and a real end is not followed by another.
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  f.deps.prompt = async (name, text, { onSubmitted }) => {
    openfleet.append(fleetOf(), { event: "member.start", by: name, member: name, session: "172ffd83", swarm: SWARM });
    onSubmitted({ at: now(), task: `t-${name}` });
    openfleet.append(fleetOf(), { event: "member.end", by: name, member: name, state: "done", summary: "its own words" });
    return { ok: true, task: `t-${name}`, outcome: "matched", state: "done", artifact: "x", error: null };
  };
  await run({}, f);
  const starts = ledger().filter((l) => l.event === "member.start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].by, m(1), "the session's own claim stands");
  const ends = ledger().filter((l) => l.event === "member.end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].summary, "its own words");
  assert.equal(ledger().filter((l) => l.event === "swarm.end").length, 1);
}));

test("--keep leaves the sessions running and writes no end lines", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const result = await run({ keep: true }, f);
  assert.deepEqual(f.calls.kill, []);
  assert.equal(result.kept, true);
  assert.equal(result.swarm, SWARM);
  assert.deepEqual(events(), ["swarm.spawn", "member.start"], "the record and the start are written; the ends are not, because nothing ended");
  assert.ok(openfleet.readMember(fleetOf(), m(1)));
}));

test("--plan-only starts nothing and writes nothing", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  const result = await run({ planOnly: true }, f);
  assert.equal(result.planOnly, true);
  assert.equal(result.plan.length, 2);
  assert.equal(result.swarm, SWARM, "the id was minted before the plan");
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.ai.length, 1);
  assert.deepEqual(events(), []);
}));

test("a crash after the fan-out still kills the sessions it started", () => inHome(async () => {
  const f = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  f.deps.boot = async (name) => { if (name === m(2)) throw new Error("the box fell over"); return { outcome: "matched", state: "idle" }; };
  await assert.rejects(run({}, f), /fell over/);
  assert.ok(f.calls.kill.includes(m(1)), "the first pane started and must not be left idle");
  assert.ok(f.calls.kill.includes(m(2)));
}));

test("no installed engine is a clear error", () => inHome(async () => {
  const result = await runSwarm({ task: "T", agents: 4, cwd: "/x", herd: "swarm", timeoutMs: 1000 }, { deps: fakes().deps, engineOf: () => null });
  assert.equal(result.ok, false);
  assert.match(result.error, /install claude/);
}));

/* ------------------------------------------------------------- the command */

test("the command needs a task", async () => {
  const lines = [];
  assert.equal(await swarmCommand([], { write: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /usage: moshcode swarm/);
});

test("the command refuses an engine nobody has heard of before touching anything", async () => {
  const lines = [];
  assert.equal(await swarmCommand(["do it", "--engine", "hal9000"], { write: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /no engine named "hal9000"/);
});

test("--json prints the run as data, with the swarm and the fleet, and narrates nothing", () => inHome(async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const lines = [];
  const code = await swarmCommand(["T", "--json"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 0);
  assert.equal(lines.length, 1, "one JSON document, no narration");
  const data = JSON.parse(lines[0]);
  assert.equal(data.synthesis, "THE ANSWER");
  assert.match(data.swarm, /^t-\d{4}$/);
  assert.equal(data.fleet, fleetOf());
  assert.equal(data.results[0].session, `${data.swarm}-1`);
  assert.equal(data.results[0].member, `${data.swarm}-1`);
}));

test("the human form ends with the answer, the ledger, and the count", () => inHome(async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }, { title: "b", prompt: "b" }] });
  const lines = [];
  const code = await swarmCommand(["T"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /THE ANSWER/);
  assert.match(text, /2 pieces finished/);
  assert.match(text, /moshcode herd task t-t-\d{4}-1/);
  assert.match(text, /moshcode fleet log --swarm t-\d{4}/);
}));

test("--keep names the sessions and the swarm, so the sysop can end them later as one unit", () => inHome(async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const lines = [];
  await swarmCommand(["T", "--keep"], { write: (l) => lines.push(l), deps, engineOf });
  assert.match(lines.join("\n"), /sessions kept \(swarm t-\d{4}\): t-\d{4}-1.*moshcode fleet stop t-\d{4}/);
}));

test("a failed piece is a non-zero exit even though the answer was written", () => inHome(async () => {
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }], failStart: [] });
  deps.start = () => ({ ok: false, error: "tmux said no" });
  const lines = [];
  const code = await swarmCommand(["T"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /0 of 1 pieces finished; 1 failed/);
}));

test("a refused swarm says why and exits 1", () => inHome(async () => {
  insideMember({ member: "460a4502", depth: 0, approvals: "native" });
  const { deps } = fakes({ plan: [{ title: "a", prompt: "a" }] });
  const lines = [];
  const code = await swarmCommand(["T"], { write: (l) => lines.push(l), deps, engineOf });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /refuses approvals/);
  assert.match(lines.join("\n"), /0 of 1 pieces finished; 1 failed/);
}));
