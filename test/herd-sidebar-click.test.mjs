// The sidebar's input handler: the crash it used to be, and the one click it
// now takes to open an agent.
//
// These drive `herdSidebar` directly with a fake stdin and a stand-in for tmux,
// because the thing under test is not what the screen looks like, it is what
// happens when a shell-out fails halfway through a click. That was the whole
// bug: the handler is async, so one throw out of tmux became an unhandled
// promise rejection and Node ended the process, leaving the pane in raw mode
// with the mouse still captured.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every herd module reads these, and the heartbeat classifier reads
// OPENFLEET_HOME as well, so both are pointed at a scratch directory before the
// modules under test are imported. A test that stops a member would otherwise
// edit the manifest of whatever is actually running on this box.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-sidebar-test-"));
process.env.MOSHCODE_HERD_DIR = path.join(SCRATCH, "herd");
process.env.OPENFLEET_HOME = path.join(SCRATCH, "fleet");

const { ACTIONS, SIDEBAR_KEYS, herdSidebar, parkPane, renderSidebar, sidebarRows } =
  await import("../src/herd-workspace.mjs");
const { parseInput, parseMouse } = await import("../src/herd-ui.mjs");

const member = (name, extra = {}) => ({
  name, engine: "claude", herd: "main", state: "idle", cwd: "/x", alive: true, confidence: "known", ...extra,
});
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const click = (line) => Buffer.from(`\x1b[<0;3;${line}M`);
const move = (line) => Buffer.from(`\x1b[<35;3;${line}M`);
const settle = () => new Promise((r) => setTimeout(r, 30));

/** tmux answering the two list-panes shapes the sidebar actually reads. */
const panes = (args) => {
  if (args.includes("-a")) return { status: 0, stdout: "api\t%1\tapi\t@1\t0\nweb\t%2\tweb\t@2\t0\n", stderr: "" };
  if (args[2] === "list-panes") return { status: 0, stdout: "%9\tapi\n", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

/**
 * A sidebar wired to fakes, plus the tmux argv it produced.
 *
 * `answer` gets the tmux argv and returns a spawnSync-shaped result, so a test
 * can make one specific call fail without stubbing the module graph.
 */
function drive({ sessions = [member("api"), member("web")], answer = panes } = {}) {
  const calls = [];
  const frames = [];
  const stdin = new EventEmitter();
  stdin.setRawMode = (on) => { stdin.rawSetTo = on; };
  stdin.resume = () => {};
  stdin.pause = () => { stdin.paused = true; };
  const stdout = { write: (s) => { frames.push(String(s)); return true; } };
  const runner = (cmd, args) => { calls.push(args); return answer(args, calls); };
  const done = herdSidebar({ stdin, stdout, read: () => sessions, refreshMs: 1_000_000, runner });
  return { calls, frames, stdin, stdout, done, rows: sidebarRows(sessions) };
}

const quit = async (d) => { d.stdin.emit("data", Buffer.from("\x03")); await d.done; };
const rowFor = (d, name) => d.rows.find((r) => r.kind === "session" && r.session.name === name);

/* --------------------------------------------------------------- the crash */

test("a click that throws inside tmux does not end the process", async () => {
  // The exact shape of the original crash: something under the click throws,
  // the handler is async, and the rejection is nobody's. The promise the
  // sidebar hands back must still be pending afterwards, not rejected.
  const d = drive({ answer: () => { throw new TypeError("Cannot read properties of undefined (reading 'trim')"); } });
  let rejected = null;
  d.done.catch((e) => { rejected = e; });

  d.stdin.emit("data", click(rowFor(d, "api").line));
  await settle();

  assert.equal(rejected, null, "the throw must not escape as an unhandled rejection");
  await quit(d);
});

test("the reason a click failed is shown rather than swallowed", async () => {
  const d = drive({ answer: () => { throw new Error("no current client"); } });
  d.stdin.emit("data", click(rowFor(d, "api").line));
  await settle();
  const last = strip(d.frames[d.frames.length - 1]);
  assert.match(last, /no current client|could not open/, `the sidebar said nothing: ${JSON.stringify(last)}`);
  await quit(d);
});

test("the terminal is put back the way it was found, raw mode included", async () => {
  // The destructive half of the old crash. Escape sequences are undone by the
  // next full-screen program to run; a terminal left with no echo is not.
  const d = drive();
  await settle();
  assert.equal(d.stdin.rawSetTo, true, "the sidebar takes raw mode while it runs");
  await quit(d);
  assert.equal(d.stdin.rawSetTo, false, "and gives it back");
  assert.equal(d.stdin.paused, true, "and stops reading");
  const all = d.frames.join("");
  for (const off of ["\x1b[?1006l", "\x1b[?1003l", "\x1b[?1000l", "\x1b[?25h"]) {
    assert.ok(all.includes(off), `${JSON.stringify(off)} was never sent`);
  }
});

/* ---------------------------------------------------------------- one click */

test("one click on a member opens it: shown AND given the keyboard", async () => {
  // Anthony rejected the two-click idiom outright (diskpush 0.7.0, "i had to
  // double click that was odd"). A single click has to do the whole thing.
  const d = drive();
  await settle();
  d.calls.length = 0;
  d.stdin.emit("data", click(rowFor(d, "web").line));
  await settle();

  assert.ok(
    d.calls.some((a) => a.includes("join-pane") && a.includes("%2")),
    "the clicked member's pane was never joined in",
  );
  // focusContent is the second half of "open", and it is what the old code only
  // did on a SECOND click of the same row.
  assert.ok(
    d.calls.some((a) => a[2] === "select-pane" && a.includes("%9")),
    "the keyboard was never handed to the content pane",
  );
  await quit(d);
});

test("enter opens the selected member, so the mouse is not the only way in", async () => {
  const d = drive();
  await settle();
  d.calls.length = 0;
  d.stdin.emit("data", Buffer.from("j")); // api is already on screen; move to web
  await settle();
  d.stdin.emit("data", Buffer.from("\r"));
  await settle();
  assert.ok(
    d.calls.some((a) => a.includes("join-pane") && a.includes("%2")),
    "enter did not open the member the keyboard had selected",
  );
  await quit(d);
});

test("clicking a member that is not running says so instead of half-opening it", async () => {
  const sessions = [member("api"), member("dead", { alive: false, state: "gone" })];
  const d = drive({ sessions });
  await settle();
  d.calls.length = 0;
  d.stdin.emit("data", click(rowFor(d, "dead").line));
  await settle();
  assert.equal(d.calls.filter((a) => a.includes("join-pane")).length, 0);
  assert.match(strip(d.frames[d.frames.length - 1]), /not running/);
  await quit(d);
});

test("clicking an action does not steal the member selection", async () => {
  // The bug that made "stop" unable to stop anything: clicking it set the
  // selection to the action's own key, and then looked for a member by that
  // name. Nothing is ever called "x", so nothing was ever stopped.
  const d = drive();
  await settle();
  const stop = d.rows.find((r) => r.kind === "action" && r.action.run === "stop");
  d.calls.length = 0;
  d.stdin.emit("data", click(stop.line));
  await settle();
  assert.ok(d.calls.some((a) => a.includes("kill-pane")), "stop never reached the selected member");
  await quit(d);
});

/* -------------------------------------------------------------------- hover */

test("motion reports are decoded, and light the row under the pointer", () => {
  // 1003 reports motion with bit 5 of the button field set. Without this a
  // hover is impossible and a click has to be spent moving the highlight,
  // which is how the double-click crept in.
  assert.deepEqual(parseMouse("\x1b[<35;3;7M"), { kind: "move", col: 3, row: 7 });
  assert.deepEqual(parseInput(move(7)), [{ kind: "move", col: 3, row: 7 }]);

  const rows = sidebarRows([member("api"), member("web")]);
  const target = rows.find((r) => r.kind === "session" && r.session.name === "web");
  const painted = renderSidebar(rows, { selected: "api", showing: "api", hovered: target.line });
  const lines = painted.split("\r\n");
  assert.match(lines[target.line - 1], /\x1b\[7m/, "the hovered row is not lit");
  assert.doesNotMatch(lines[target.line - 2], /\x1b\[7m/, "only one row may be lit at a time");
});

test("a hover over a row that is not clickable lights nothing", () => {
  const rows = sidebarRows([member("api")]);
  const heading = rows.find((r) => r.kind === "heading");
  assert.doesNotMatch(renderSidebar(rows, { hovered: heading.line }), /\x1b\[7m/);
});

test("the pointer moving over the sidebar redraws it", async () => {
  const d = drive();
  await settle();
  const before = d.frames.length;
  d.stdin.emit("data", move(rowFor(d, "web").line));
  await settle();
  assert.ok(d.frames.length > before, "a hover drew nothing");
  // And moving within the same row must not repaint, or dragging across the
  // pane redraws it once per cell.
  const after = d.frames.length;
  d.stdin.emit("data", move(rowFor(d, "web").line));
  await settle();
  assert.equal(d.frames.length, after, "the same row was redrawn twice");
  await quit(d);
});

/* --------------------------------------------------- the sidebar's own keys */

test("every action's advertised key actually reaches the handler", () => {
  // The sidebar prints s / a / x beside its actions, and the shared parser only
  // ever emitted the LIST's keys, so three of the five did nothing at all.
  for (const action of ACTIONS) {
    assert.ok(SIDEBAR_KEYS.includes(action.key), `${action.key} is advertised but never read`);
    assert.deepEqual(
      parseInput(Buffer.from(action.key), { keys: SIDEBAR_KEYS }),
      [{ kind: "key", key: action.key }],
      `${action.key} is not decoded`,
    );
  }
});

/* ----------------------------------------------------------- pane identity */

test("a pane whose title is not a legal session name can still be parked", () => {
  // claude and a login shell both rename their own pane via OSC 2, and the
  // window option that stops them does not travel with a joined pane. Before
  // this, `new-session -s "anthony@dev:~/src"` failed and the pane was left
  // wedged in the workspace beside the one that had just arrived.
  const calls = [];
  const runner = (cmd, args) => {
    calls.push(args);
    if (args[2] === "new-session" && /[:.]/.test(String(args[args.indexOf("-s") + 1]))) {
      return { status: 1, stdout: "", stderr: "bad session name\n" };
    }
    return { status: 0, stdout: "%7\n", stderr: "" };
  };
  assert.equal(parkPane("%3", "anthony@dev:~/src/moshcode", { runner }), true);
  const made = calls.find((a) => a[2] === "new-session");
  assert.doesNotMatch(String(made[made.indexOf("-s") + 1]), /[:.]/, "parked under a name tmux cannot address");
});

/* ------------------------------------------------------------- confidence */

test("a guessed state does not look like a reported one", () => {
  // PRD 0019. The heartbeat exists so the roster stops stating guesses as
  // facts; a sidebar that renders both identically puts the lie straight back.
  const rows = sidebarRows([member("sure"), member("guess", { confidence: "inferred" })]);
  const lines = strip(renderSidebar(rows, {})).split("\r\n");
  assert.match(lines.find((l) => l.includes("guess")), /\?/, "an inferred state carries no mark");
  assert.doesNotMatch(
    lines.find((l) => l.includes("sure")).replace("sure", ""),
    /\?/,
    "a known state must not be marked as a guess",
  );
});
