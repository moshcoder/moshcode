// The stopwatch, and the ledger behind it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clientCommand } from "../src/clients.mjs";
import { rateCommand } from "../src/rates.mjs";
import { dayOf, elapsed, humanDuration, parseDuration, selectEntries, timerCommand, windowFrom } from "../src/timer.mjs";
import { loadTimers } from "../src/business-store.mjs";

function sandbox(t) {
  const previous = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "moshcode-timer-"));
  t.after(() => { process.env.HOME = previous; });
  const lines = [];
  return { lines, write: (l) => lines.push(String(l)), said: () => lines.join("\n") };
}

/** A clock that starts at a fixed instant and only moves when told to. */
function clock(startMs = Date.UTC(2026, 0, 5, 9, 0, 0)) {
  let at = startMs;
  return { now: () => at, advance: (seconds) => { at += seconds * 1000; } };
}

test("a duration is read the way it is said", () => {
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("90m"), 5400);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("1:30"), 5400);
  assert.equal(parseDuration("0.5h"), 1800);
  // A bare number is minutes — the unit people say when logging after the fact.
  assert.equal(parseDuration("45"), 2700);
  assert.equal(parseDuration("nope"), null);
  assert.equal(parseDuration(""), null);
});

test("a duration is written short, and stays exact enough", () => {
  assert.equal(humanDuration(45), "45s");
  assert.equal(humanDuration(2700), "45m");
  assert.equal(humanDuration(5400), "1h 30m");
  assert.equal(humanDuration(7200), "2h");
  assert.equal(humanDuration(0), "0s");
});

test("on writes an active timer and off turns it into an entry", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  assert.equal(await timerCommand(["on", "acme", "--task", "batch payments"], { ...io, now: c.now }), 0);
  assert.equal(loadTimers().active.client, "acme");
  c.advance(3600);
  assert.equal(await timerCommand(["off"], { ...io, now: c.now }), 0);
  const state = loadTimers();
  assert.equal(state.active, null);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].seconds, 3600);
  assert.equal(state.entries[0].task, "batch payments");
  assert.equal(state.entries[0].billed, false);
});

test("a second on refuses instead of stacking two open timers", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  await timerCommand(["on", "acme"], { ...io, now: c.now });
  io.lines.length = 0;
  assert.equal(await timerCommand(["on", "acme"], { ...io, now: c.now }), 1);
  assert.match(io.said(), /already running/);
  assert.equal(loadTimers().entries.length, 0, "the refusal wrote nothing");
});

test("switch closes one and opens the next", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  clientCommand(["create", "Globex"], io);
  await timerCommand(["on", "acme"], { ...io, now: c.now });
  c.advance(1800);
  await timerCommand(["switch", "globex"], { ...io, now: c.now });
  const state = loadTimers();
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].client, "acme");
  assert.equal(state.active.client, "globex");
});

test("a timer will not start against a client that does not exist", async (t) => {
  const io = sandbox(t);
  assert.equal(await timerCommand(["on", "acme"], io), 1);
  assert.match(io.said(), /no client "acme"/);
  assert.equal(loadTimers().active, null, "time must not accrue to a name nobody can invoice");
});

test("--agents auto asks the herd, and the count reaches the entry", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  await timerCommand(["on", "acme", "--agents", "auto"], { ...io, now: c.now, countAgents: async () => 5 });
  c.advance(600);
  await timerCommand(["off"], { ...io, now: c.now });
  assert.equal(loadTimers().entries[0].agents, 5);
});

test("off says what the time earned, and that the cap applied", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  rateCommand(["set", "acme", "$100/hour/agent/upto:4"], io);
  await timerCommand(["on", "acme", "--agents", "6"], { ...io, now: c.now });
  c.advance(3600);
  io.lines.length = 0;
  await timerCommand(["off"], { ...io, now: c.now });
  assert.match(io.said(), /\$400\.00/, "six agents bill as four");
  assert.match(io.said(), /billed 4/);
});

test("add logs time after the fact, ending when it says", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  await timerCommand(["add", "acme", "2h30m", "--task", "code review"], { ...io, now: c.now });
  const [entry] = loadTimers().entries;
  assert.equal(entry.seconds, 9000);
  assert.equal(entry.manual, true);
  assert.equal(new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime(), 9000 * 1000);
});

test("rm drops one entry and leaves the rest", async (t) => {
  const io = sandbox(t);
  const c = clock();
  clientCommand(["create", "Acme"], io);
  await timerCommand(["add", "acme", "1h"], { ...io, now: c.now });
  await timerCommand(["add", "acme", "2h"], { ...io, now: c.now });
  const [first] = loadTimers().entries;
  assert.equal(await timerCommand(["rm", first.id], io), 0);
  assert.equal(loadTimers().entries.length, 1);
  assert.equal(await timerCommand(["rm", "nope"], io), 1);
});

test("selectEntries filters the way billing needs it to", () => {
  const entries = [
    { id: "a", client: "acme", endedAt: "2026-01-01T10:00:00Z", startedAt: "2026-01-01T09:00:00Z", billed: true },
    { id: "b", client: "acme", endedAt: "2026-02-01T10:00:00Z", startedAt: "2026-02-01T09:00:00Z", billed: false },
    { id: "c", client: "globex", endedAt: "2026-02-02T10:00:00Z", startedAt: "2026-02-02T09:00:00Z", billed: false },
  ];
  assert.deepEqual(selectEntries(entries, { client: "acme" }).map((e) => e.id), ["a", "b"]);
  assert.deepEqual(selectEntries(entries, { client: "acme", unbilled: true }).map((e) => e.id), ["b"]);
  assert.deepEqual(selectEntries(entries, { since: "2026-02-01T00:00:00Z" }).map((e) => e.id), ["b", "c"]);
  assert.deepEqual(selectEntries(entries).map((e) => e.id), ["a", "b", "c"], "oldest first");
});

test("windowFrom turns the words into a lower bound", () => {
  const now = Date.UTC(2026, 1, 15, 12, 0, 0);
  assert.equal(windowFrom({}, now), null);
  assert.equal(new Date(windowFrom({ week: true }, now)).getTime(), now - 7 * 86400_000);
  assert.equal(dayOf(windowFrom({ month: true }, now)).slice(-2), "01");
  assert.equal(windowFrom({ since: "2026-01-01" }, now), new Date("2026-01-01").toISOString());
});

test("elapsed survives a ledger with nonsense in it", () => {
  assert.equal(elapsed(null), 0);
  assert.equal(elapsed({ startedAt: "not a date" }), 0);
  assert.equal(elapsed({ startedAt: new Date(1000).toISOString() }, 61_000), 60);
});
