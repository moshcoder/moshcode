// Heartbeat liveness and the two-tier roster (PRD 0019 R2).
//
// The failure being fixed is concrete: Claude Code 2.1 overwrote the pane
// title and dropped "? for shortcuts", the screen rules stopped matching, and
// the roster went on reporting a state with exactly the same confidence it
// always had. These tests pin the two halves of the answer. A run that beats
// is read from the beat. A session with nothing to beat with is read from its
// screen and says so.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTHORITY_CONFIDENCE, confidenceOf, reportState, sessionState, withState,
} from "../src/herd-state.mjs";
import { beat, closeRun, liveBeats } from "../src/run-record.mjs";
import { herdReport, paintStateWithConfidence } from "../src/herd-cli.mjs";

const VARS = ["MOSHCODE_HERD_DIR", "OPENFLEET_HOME", "OPENFLEET_RECORD", "OPENFLEET_FLEET", "OPENFLEET_MEMBER", "OPENFLEET_SWARM"];

/** A temporary herd and a temporary fleet home. Neither is ever the real one. */
function withHomes(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-beat-test-"));
  const previous = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.MOSHCODE_HERD_DIR = path.join(dir, "herd");
  process.env.OPENFLEET_HOME = path.join(dir, "openfleet");
  try { return fn(dir); }
  finally {
    for (const k of VARS) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Injected, never a real user@host: the implicit fleet is `<user>@<host>` on a
// real box and an assertion against it would only hold where it was written.
const FLEET = "testfleet-20260925";

const live = (extra = {}) => ({ name: "claude1", engine: "claude", alive: true, exited: false, ...extra });

/* ------------------------------------------------------------- the two tiers */

test("every authority has a tier, and anything unnamed is inferred", () => {
  assert.equal(AUTHORITY_CONFIDENCE.heartbeat, "known");
  assert.equal(AUTHORITY_CONFIDENCE.screen, "inferred");
  assert.equal(confidenceOf("heartbeat"), "known");
  assert.equal(confidenceOf("screen"), "inferred");
  // A source we cannot name is not one we get to call a fact.
  assert.equal(confidenceOf("something-new"), "inferred");
  assert.equal(confidenceOf(undefined), "inferred");
});

/* ------------------------------------------------------------- the heartbeat */

test("a run that beats with a state beats the screen, and is reported as known", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    // The screen says blocked. The run says working. The run wins, because one
    // of those is a report and the other is a regular expression's opinion.
    const state = sessionState(live(), { now: 1000, read: () => "Do you want to proceed?" });
    assert.deepEqual(state, { state: "working", authority: "heartbeat", confidence: "known", run: "r1" });
  });
});

test("a beat carries the blocked sub-kind through, so an --ask reply knows what to type", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "blocked", kind: "menu" }, { now: 1000 });
    const state = sessionState(live(), { now: 1000, read: () => "" });
    assert.equal(state.state, "blocked");
    assert.equal(state.blockedOn, "menu");
    assert.equal(state.confidence, "known");
  });
});

test("a beat with a sub-kind the vocabulary does not hold drops the sub-kind, not the state", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "blocked", kind: "captcha" }, { now: 1000 });
    const state = sessionState(live(), { now: 1000, read: () => "" });
    assert.equal(state.state, "blocked");
    assert.equal(state.blockedOn, undefined);
  });
});

test("a beat with a state outside the vocabulary is ignored, and the screen answers", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "thinking" }, { now: 1000 });
    const state = sessionState(live(), { now: 1000, read: () => "esc to interrupt" });
    assert.equal(state.state, "working");
    assert.equal(state.authority, "screen");
    assert.equal(state.confidence, "inferred");
    assert.equal(state.run, "r1", "the run is still named, so the record can be read");
  });
});

test("a beat with no state proves the run is alive but does not say what it is doing", () => {
  withHomes(() => {
    // This is what moshcode writes at the moment it starts a session: it knows
    // the run exists, it does not know whether the engine is working or
    // waiting, and it must not claim to.
    beat(FLEET, "r1", { session: "claude1" }, { now: 1000 });
    const state = sessionState(live(), { now: 1000, read: () => "Do you want to proceed?" });
    assert.equal(state.state, "blocked");
    assert.equal(state.authority, "screen");
    assert.equal(state.confidence, "inferred");
    assert.equal(state.run, "r1");
  });
});

test("a stale beat is an absence: the session falls back to inference rather than to a lie", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    const later = 1000 + 11 * 60 * 1000;
    const state = sessionState(live(), { now: later, read: () => "Do you want to proceed?" });
    assert.equal(state.state, "blocked");
    assert.equal(state.confidence, "inferred");
    assert.equal(state.run, undefined, "an expired beat names nothing at all");
  });
});

test("a closed run stops beating, so a finished session cannot read as working", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    closeRun(FLEET, "r1", { state: "done" }, { now: 1100 });
    const state = sessionState(live(), { now: 1200, read: () => "$ " });
    assert.notEqual(state.authority, "heartbeat");
    assert.equal(state.confidence, "inferred");
  });
});

/* --------------------------------------------------------------- the order */

test("the runtime still outranks the heartbeat, because an exited process is not a matter of opinion", () => {
  withHomes(() => {
    // A beat written two minutes before the process exited would otherwise
    // report a dead run as working for the rest of its ttl.
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    const state = sessionState(live({ exited: true }), { now: 1000, read: () => "" });
    assert.deepEqual(state, { state: "done", authority: "runtime", confidence: "known" });
  });
});

test("the heartbeat outranks the engine hook, and both are known", () => {
  withHomes(() => {
    reportState("claude1", "blocked", { now: 1000 });
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    assert.equal(sessionState(live(), { now: 1000, read: () => "" }).authority, "heartbeat");

    // With no beat, the hook answers and is still a report rather than a guess.
    const hookOnly = sessionState(live({ name: "codex1" }), { now: 1000, read: () => "" });
    assert.equal(hookOnly.authority, "screen", "a different session has neither");
    reportState("codex1", "working", { now: 1000 });
    const reported = sessionState(live({ name: "codex1" }), { now: 1000, read: () => "" });
    assert.deepEqual(reported, { state: "working", authority: "hook", confidence: "known" });
  });
});

test("a beat names its run even when the hook is the one answering", () => {
  withHomes(() => {
    reportState("claude1", "working", { now: 1000 });
    beat(FLEET, "r1", { session: "claude1" }, { now: 1000 });
    const state = sessionState(live(), { now: 1000, read: () => "" });
    assert.equal(state.authority, "hook");
    assert.equal(state.run, "r1");
  });
});

/* ------------------------------------------------------- the permanent tier */

test("a session moshcode did not start has nothing to beat with, and says inferred forever", () => {
  withHomes(() => {
    // The permanent half of the two tiers. An engine launched by hand in a pane
    // cannot report, so this is the true answer rather than a gap.
    const state = sessionState(live({ name: "byhand" }), { now: 1000, read: () => "esc to interrupt" });
    assert.deepEqual(state, { state: "working", authority: "screen", confidence: "inferred" });
  });
});

test("a screen nobody wrote a rule for is unknown and inferred, never a confident answer", () => {
  withHomes(() => {
    const state = sessionState(live(), { now: 1000, read: () => "some ordinary output" });
    assert.deepEqual(state, { state: "unknown", authority: "screen", confidence: "inferred" });
  });
});

test("a remote member's claim stays inferred, because nothing says how that herd worked it out", () => {
  withHomes(() => {
    // The remote protocol carries a state and not the confidence behind it,
    // and the cached status never expires, so an hour-old screen guess from
    // another box would otherwise arrive here dressed as a fact.
    const state = sessionState({ name: "far", kind: "remote" }, { now: 1000, remote: () => ({ state: "working" }) });
    assert.deepEqual(state, { state: "working", authority: "remote", confidence: "inferred" });
  });
});

/* ------------------------------------------ the wedged engine (0019 R2, UX) */

test("an engine that died mid-turn stops being reported as a fact once its report expires", () => {
  withHomes(() => {
    // The concrete failure. An engine that crashes or wedges never fires Stop,
    // so its last report says `working`. Fifteen minutes later that report
    // expires, the screen still carries "esc to interrupt" from the work it
    // was doing when it died, and the classifier says `working` again. The
    // state does not change. What changes is that it stops claiming to be
    // known, which is the difference between "it is working" and "the last
    // thing anyone could see was it working".
    reportState("claude1", "working", { now: 1000 });
    const fresh = sessionState(live(), { now: 1000, read: () => "esc to interrupt" });
    assert.deepEqual(fresh, { state: "working", authority: "hook", confidence: "known" });

    const stale = sessionState(live(), { now: 1000 + 16 * 60 * 1000, read: () => "esc to interrupt" });
    assert.deepEqual(stale, { state: "working", authority: "screen", confidence: "inferred" });
  });
});

test("a beat that stopped arriving degrades the same way, rather than holding the last state", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    const fresh = sessionState(live(), { now: 1000, read: () => "esc to interrupt" });
    assert.equal(fresh.confidence, "known");
    const stale = sessionState(live(), { now: 1000 + 11 * 60 * 1000, read: () => "esc to interrupt" });
    assert.equal(stale.confidence, "inferred");
    assert.equal(stale.state, "working", "the screen still says so, and that is all it says");
  });
});

/* ---------------------------------------------------------------- the roster */

test("withState reads the beats once for the whole roster and every row carries its tier", () => {
  withHomes(() => {
    beat(FLEET, "r1", { session: "claude1", state: "working" }, { now: 1000 });
    const rows = withState(
      [live(), live({ name: "byhand" })],
      { now: 1000, read: () => "Do you want to proceed?" },
    );
    assert.deepEqual(rows.map((r) => [r.name, r.state, r.authority, r.confidence]), [
      ["claude1", "working", "heartbeat", "known"],
      ["byhand", "blocked", "screen", "inferred"],
    ]);
  });
});

test("withState takes an injected beat map, so a caller can render a roster with no fleet home at all", () => {
  withHomes(() => {
    const beats = new Map([["claude1", { run: "r9", session: "claude1", state: "idle", at: 1000, ttl: 60000 }]]);
    const rows = withState([live()], { now: 1000, beats, read: () => "esc to interrupt" });
    assert.equal(rows[0].state, "idle");
    assert.equal(rows[0].authority, "heartbeat");
    assert.equal(rows[0].run, "r9");
  });
});

test("the state column marks an inferred answer with one character and leaves a known one bare", () => {
  // One character, because the roster is read at a glance and a second column
  // saying "inferred" forty times is a second column nobody reads.
  const known = paintStateWithConfidence("working", "known");
  const guessed = paintStateWithConfidence("working", "inferred");
  assert.equal(stripColour(known), "working");
  assert.equal(stripColour(guessed), "working?");
});

/* eslint-disable-next-line no-control-regex */
const stripColour = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

/* ------------------------------- one channel, not two (0019 R2, herd report) */

test("herd report beats for the run as well, so a hook installs one command and not two", () => {
  withHomes(() => {
    // Deliberately not a second channel. `herd report` is already the one
    // socket any process with $MOSHCODE_HERD_NAME can call, already
    // TTL-bounded, and already what the engine hooks are wired to.
    process.env.MOSHCODE_RUN = "r1";
    process.env.MOSHCODE_RUN_FLEET = FLEET;
    try {
      assert.equal(herdReport(["claude1", "blocked:permission"], { write: () => {} }), 0);
      const state = sessionState(live(), { read: () => "" });
      assert.equal(state.authority, "heartbeat");
      assert.equal(state.state, "blocked");
      assert.equal(state.blockedOn, "permission");
      assert.equal(state.run, "r1");
    } finally {
      delete process.env.MOSHCODE_RUN;
      delete process.env.MOSHCODE_RUN_FLEET;
    }
  });
});

test("herd report without a run writes the herd's state and no beat at all", () => {
  withHomes(() => {
    // An engine somebody launched by hand. It reports, it is read from the
    // hook, and nothing anywhere pretends a run record exists for it.
    assert.equal(herdReport(["byhand", "working"], { write: () => {} }), 0);
    const state = sessionState(live({ name: "byhand" }), { read: () => "" });
    assert.equal(state.authority, "hook");
    assert.equal(state.run, undefined);
    assert.equal(liveBeats().size, 0);
  });
});

test("a beat that cannot be written does not fail the report the roster reads", () => {
  withHomes((dir) => {
    // A fleet home that is a regular file, so every write under it fails with
    // ENOTDIR. The report is what the roster reads right now and the beat is
    // what the record reads later; losing the second must cost a line of
    // history rather than a wrong answer on screen.
    const blocked = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocked, "");
    process.env.MOSHCODE_RUN = "r1";
    process.env.MOSHCODE_RUN_FLEET = FLEET;
    process.env.OPENFLEET_HOME = blocked;
    try {
      assert.equal(herdReport(["claude1", "working"], { write: () => {} }), 0);
      // The herd's own state landed, which is the half that had to survive.
      assert.equal(sessionState(live(), { read: () => "" }).authority, "hook");
    } finally {
      delete process.env.MOSHCODE_RUN;
      delete process.env.MOSHCODE_RUN_FLEET;
    }
  });
});
