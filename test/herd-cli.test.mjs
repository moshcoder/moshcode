// The command surface: the exit codes `wait` exists to produce, the flags that
// turn a launch into a herd session, and the rules that keep notifications from
// becoming the thing everyone switches off.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXIT, humanAge, paintState, renderRoster, shouldNotify, splitDetachArgs, waitFor,
} from "../src/herd-cli.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const session = (extra = {}) => ({
  name: "api", engine: "claude", cwd: "/x/api", age: 60000, alive: true, state: "working", ...extra,
});

/* ---------------------------------------------------------- detach parsing */

test("a launch stays in the foreground unless it is asked not to", () => {
  // The load-bearing default. If `-d` were implied, this whole feature would be
  // a regression wearing a roster.
  assert.deepEqual(splitDetachArgs(["--model", "opus"]), { detach: false, name: null, rest: ["--model", "opus"] });
});

test("--name implies --detach", () => {
  // Naming a session you were about to sit inside is a request for one you can
  // come back to.
  const parsed = splitDetachArgs(["--name", "api"]);
  assert.equal(parsed.detach, true);
  assert.equal(parsed.name, "api");
});

test("the herd flags never reach the engine", () => {
  // An engine has never heard of `-d`, and passing it on turns a detach into an
  // argument error from something that is not moshcode.
  const parsed = splitDetachArgs(["-d", "--model", "opus", "--name=api", "-p", "hi"]);
  assert.deepEqual(parsed.rest, ["--model", "opus", "-p", "hi"]);
  assert.equal(parsed.name, "api");
});

test("--name=value is the same as --name value", () => {
  assert.equal(splitDetachArgs(["--name=api"]).name, "api");
  assert.equal(splitDetachArgs(["--name", "api"]).name, "api");
});

/* -------------------------------------------------------------- exit codes */

test("wait's outcomes are distinguishable", () => {
  // The whole reason `wait` exists is to be branched on, so the codes have to
  // mean different things — a script cannot tell "it blocked" from "it never
  // did" if both exit 0.
  assert.notEqual(EXIT.matched, EXIT.timeout);
  assert.notEqual(EXIT.timeout, EXIT.gone);
  assert.equal(EXIT.matched, 0, "success is 0 or no shell believes it");
});

test("wait returns as soon as the state is reached", async () => {
  let looks = 0;
  const result = await waitFor("api", ["blocked"], {
    intervalMs: 1,
    look: () => session({ state: ++looks >= 3 ? "blocked" : "working" }),
  });
  assert.deepEqual(result, { outcome: "matched", state: "blocked" });
});

test("wait gives up rather than hanging on a state that cannot arrive", async () => {
  // A finished session will never reach `blocked`. Waiting the full timeout for
  // something impossible is a hang, not a wait.
  const result = await waitFor("api", ["blocked"], {
    intervalMs: 1,
    look: () => session({ state: "done", alive: true }),
  });
  assert.equal(result.outcome, "ended");
});

test("waiting for done is satisfied by done", async () => {
  const result = await waitFor("api", ["done"], { intervalMs: 1, look: () => session({ state: "done" }) });
  assert.deepEqual(result, { outcome: "matched", state: "done" });
});

test("wait on a session that does not exist says so instead of timing out", async () => {
  const result = await waitFor("nope", ["blocked"], { intervalMs: 1, look: () => null });
  assert.equal(result.outcome, "gone");
});

test("wait holds the process open between polls", () => {
  // This has to run in its own process with nothing else pending, because the
  // test runner itself keeps the event loop alive and hides the bug entirely.
  //
  // The failure it guards against is not a hang, it is the opposite and much
  // worse: with an unref'd poll timer node finds nothing scheduled between
  // polls and simply exits, so `moshcode wait api --timeout 1h` returns in a
  // millisecond, exit 0, having waited for nothing. CI caught it; a green local
  // suite did not.
  const source = `
    const { waitFor } = await import(${JSON.stringify(path.join(ROOT, "src", "herd-cli.mjs"))});
    const started = Date.now();
    const result = await waitFor("nobody", ["blocked"], {
      intervalMs: 50, timeoutMs: 600,
      look: () => ({ name: "nobody", state: "working", alive: true }),
    });
    console.log(JSON.stringify({ outcome: result.outcome, elapsed: Date.now() - started }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", cwd: ROOT });
  assert.equal(run.status, 0, `the wait process died instead of waiting: ${run.stderr}`);
  const out = JSON.parse(run.stdout.trim());
  assert.equal(out.outcome, "timeout", "waitFor must settle, not leave the process to exit under it");
  assert.ok(out.elapsed >= 500, `waited only ${out.elapsed}ms of 600ms — the poll timer is not holding the loop open`);
});

test("wait times out on a session that just keeps working", async () => {
  let clock = 0;
  const result = await waitFor("api", ["blocked"], {
    intervalMs: 1,
    timeoutMs: 5,
    now: () => (clock += 10),
    look: () => session({ state: "working" }),
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.state, "working");
});

/* ----------------------------------------------------------- notifications */

test("only a transition into a watched state notifies", () => {
  const watched = new Set(["blocked"]);
  assert.equal(shouldNotify("working", "blocked", watched), true);
  // A session sitting blocked must not page every poll — that is the failure
  // mode that gets the feature switched off within a day.
  assert.equal(shouldNotify("blocked", "blocked", watched), false);
  // Leaving a watched state is good news nobody needs a text about.
  assert.equal(shouldNotify("blocked", "working", watched), false);
});

test("the first sighting of a session is history, not news", () => {
  // The watcher starting up sees everything for the first time. Without this,
  // restarting it pages the operator once for every already-blocked session.
  assert.equal(shouldNotify(undefined, "blocked", new Set(["blocked"])), false);
});

test("states nobody asked to watch stay quiet", () => {
  assert.equal(shouldNotify("working", "done", new Set(["blocked"])), false);
  assert.equal(shouldNotify("working", "done", new Set(["blocked", "done"])), true);
});

/* --------------------------------------------------------------- rendering */

test("the roster puts one session on one line", () => {
  const text = renderRoster([session(), session({ name: "web", engine: "codex" })]);
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /api/);
  assert.match(text, /web/);
});

test("an empty herd renders nothing rather than a heading over nothing", () => {
  assert.equal(renderRoster([]), "");
});

test("the home directory is abbreviated so the cwd column stays readable", () => {
  const previous = process.env.HOME;
  process.env.HOME = "/home/x";
  try {
    assert.match(renderRoster([session({ cwd: "/home/x/src/api" })]), /~\/src\/api/);
  } finally { process.env.HOME = previous; }
});

test("every state renders as its own name", () => {
  // The roster is read at a glance; a state that renders as something else, or
  // as nothing, is a state nobody can act on.
  for (const state of ["working", "blocked", "done", "idle", "unknown", "gone"]) {
    assert.match(paintState(state), new RegExp(state));
  }
});

test("ages read as durations, not milliseconds", () => {
  assert.equal(humanAge(5000), "5s");
  assert.equal(humanAge(4 * 60000), "4m");
  assert.equal(humanAge(72 * 60000), "1h12m");
  assert.equal(humanAge(50 * 3600000), "2d");
  assert.equal(humanAge(null), "", "an unknown age is blank, not NaN");
});
