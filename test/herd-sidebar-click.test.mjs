// The herd sidebar, on hqtui: what the pane shows, and what a click on a cell
// of it actually does.
//
// These render the real view headlessly and then press screen cells, which is
// the whole reason the port was worth doing. The hand-rolled sidebar kept a
// click map beside the renderer and the two could drift; here the question "is
// the thing that says `api` the thing that opens api" is answered by pressing
// the cell that says `api`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderToScreen } from "@profullstack/hqtui";

// Every herd module reads these, and the heartbeat classifier reads
// OPENFLEET_HOME as well, so both are pointed at a scratch directory before the
// modules under test are imported. A test that stops a member would otherwise
// edit the manifest of whatever is actually running on this box.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-sidebar-test-"));
process.env.MOSHCODE_HERD_DIR = path.join(SCRATCH, "herd");
process.env.OPENFLEET_HOME = path.join(SCRATCH, "fleet");

const { herdNodes, herdSidebar, sidebarView, stateCell } = await import("../src/herd-sidebar.mjs");
const { ACTIONS, parkPane } = await import("../src/herd-workspace.mjs");

const member = (name, extra = {}) => ({
  name, engine: "claude", herd: "main", state: "idle", cwd: "/x", alive: true, confidence: "known", ...extra,
});
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A state object with the defaults the view expects, plus whatever a test wants. */
const stateOf = (sessions, extra = {}) => ({
  sessions, collapsed: new Set(), selected: null, showing: null, hovered: -1, offset: 0, error: "", ...extra,
});

/** Render the view and give back the screen plus what each handler was told. */
function paint(state, { width = 26, height = 30 } = {}) {
  const seen = { opened: [], folded: [], hovered: [], acted: [], scrolled: [] };
  const view = sidebarView(state, {
    onOpen: (s) => seen.opened.push(s.name),
    onFold: (h) => seen.folded.push(h),
    onHover: (i) => seen.hovered.push(i),
    onAction: (a) => seen.acted.push(a),
    onScroll: (d) => seen.scrolled.push(d),
  });
  return { screen: renderToScreen(view, { width, height }), seen };
}

/* ------------------------------------------------------- the tree is the map */

test("clicking the cell that says a member's name opens that member", () => {
  const { screen, seen } = paint(stateOf([member("api"), member("web")]));
  const at = screen.find("web");
  assert.ok(at, `the sidebar never drew "web":\n${screen.text()}`);
  assert.equal(screen.click(at.x, at.y), true, "no hit region covers the member row");
  assert.deepEqual(seen.opened, ["web"], "the click opened something else");
  assert.deepEqual(seen.folded, [], "a member is not a fold");
});

test("one click, not two: the first press opens it", () => {
  // Anthony rejected the two-click idiom outright in diskpush 0.7.0 ("i had to
  // double click that was odd"). hqtui reports `clicks`, and nothing here
  // reads it.
  const { screen, seen } = paint(stateOf([member("api")]));
  const at = screen.find("api");
  screen.click(at.x, at.y, { clicks: 1 });
  assert.deepEqual(seen.opened, ["api"]);
});

test("clicking a herd folds it in place instead of replacing the screen", () => {
  const sessions = [member("api"), member("logs", { herd: "scratch" })];
  const first = paint(stateOf(sessions));
  const at = first.screen.find("SCRATCH");
  assert.ok(at, `no herd heading:\n${first.screen.text()}`);
  first.screen.click(at.x, at.y);
  assert.deepEqual(first.seen.folded, ["scratch"]);
  assert.deepEqual(first.seen.opened, [], "folding a herd must not open anything");

  // And folded, its member is gone from the tree while the herd itself stays.
  const folded = paint(stateOf(sessions, { collapsed: new Set(["scratch"]) }));
  assert.equal(folded.screen.contains("SCRATCH"), true, "the herd itself must stay on screen");
  assert.equal(folded.screen.contains("logs"), false, "a folded herd still shows its members");
  assert.equal(folded.screen.contains("api"), true, "folding one herd hid another");
});

test("the row under the pointer is the row a click would take", () => {
  const { screen, seen } = paint(stateOf([member("api"), member("web")]));
  const at = screen.find("web");
  assert.equal(screen.hover(at.x, at.y), true, "no region answers a hover");
  const hoveredIndex = seen.hovered.at(-1);
  // Prove it by drawing again with that hover and pressing the same cell.
  const again = paint(stateOf([member("api"), member("web")], { hovered: hoveredIndex }));
  again.screen.click(at.x, at.y);
  assert.deepEqual(again.seen.opened, ["web"], "the lit row and the clicked row disagree");
});

test("the flat index a click resolves to is the row hqtui drew", () => {
  // herdNodes builds the tree and the meaning of each row in one pass, in the
  // order hqtui flattens an expanded tree in. If those two orders ever part,
  // every click below the first herd lands on its neighbour.
  const sessions = [member("api"), member("web"), member("logs", { herd: "scratch" })];
  const { rows } = herdNodes(sessions);
  assert.deepEqual(
    rows.map((r) => (r.kind === "herd" ? `#${r.herd}` : r.session.name)),
    ["#main", "api", "web", "#scratch", "logs"],
  );
  const { screen, seen } = paint(stateOf(sessions));
  for (const [index, row] of rows.entries()) {
    const needle = row.kind === "herd" ? row.herd.toUpperCase() : row.session.name;
    const at = screen.find(needle);
    seen.hovered.length = 0;
    screen.hover(at.x, at.y);
    assert.equal(seen.hovered.at(-1), index, `${needle} reports flat index ${seen.hovered.at(-1)}, not ${index}`);
  }
});

/* --------------------------------------------------------------- the actions */

test("every action is a button you can press, and the key is printed beside it", () => {
  const { screen, seen } = paint(stateOf([member("api")]));
  for (const action of ACTIONS) {
    const at = screen.find(action.label);
    assert.ok(at, `${action.label} is not on screen:\n${screen.text()}`);
    assert.equal(screen.click(at.x, at.y), true, `${action.label} is not clickable`);
    assert.match(screen.line(at.y), new RegExp(`${action.key}\\s*$`), `${action.label} does not show its key`);
  }
  assert.deepEqual(seen.acted, ACTIONS.map((a) => a.run));
});

/* ------------------------------------------------------------- what it shows */

test("a guessed state does not look like a reported one", () => {
  // PRD 0019. The heartbeat exists so the roster stops stating guesses as
  // facts; a sidebar that renders both identically puts the lie straight back.
  assert.equal(stateCell(member("a", { state: "idle" })).text, "·");
  assert.equal(stateCell(member("a", { state: "idle", confidence: "inferred" })).text, "·?");
  // Not on `unknown`, whose mark is already "?": two marks for one fact.
  assert.equal(stateCell(member("a", { state: "unknown", confidence: "inferred" })).text, "?");
});

test("the member on screen is marked, and the empty herd still offers the actions", () => {
  const shown = paint(stateOf([member("api"), member("web")], { showing: "web" }));
  const at = shown.screen.find("web");
  assert.match(shown.screen.line(at.y), /▸\s*web/, "the member in the content pane is not marked");

  const empty = paint(stateOf([]));
  assert.equal(empty.screen.contains("+ shell"), true, "an empty herd has no way to create the first member");
});

test("a failure is shown on the sidebar rather than swallowed", () => {
  const { screen } = paint(stateOf([member("api")], { error: "open: can't find pane" }));
  assert.equal(screen.contains("can't find pane"), true, `the reason is not on screen:\n${screen.text()}`);
});

/* ------------------------------------------- the sidebar wired to a fake app */

/**
 * An App stand-in. It records the view and the key listeners, so a test can
 * render a real frame and press a real cell against the real tmux plumbing.
 */
function fakeApp() {
  let view = null;
  let finish = null;
  const keys = [];
  return {
    frames: 0,
    render(fn) { view = fn; },
    on(event, cb) { if (event === "key") keys.push(cb); return () => {}; },
    invalidate() { this.frames++; },
    stop() { finish?.(); },
    start() { return new Promise((r) => { finish = r; }); },
    screen(options = {}) { return renderToScreen(view, { width: 26, height: 30, ...options }); },
    key(event) { for (const cb of keys) cb(event); },
  };
}

/** tmux answering the shapes showMember and contentPane actually read. */
const panes = (args) => {
  if (args.includes("-a")) return { status: 0, stdout: "api\t%1\tapi\t@1\t0\nweb\t%2\tweb\t@2\t0\n", stderr: "" };
  if (args[2] === "list-panes") return { status: 0, stdout: "%9\tapi\n", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

async function running({ sessions = [member("api"), member("web")], answer = panes } = {}) {
  const calls = [];
  const app = fakeApp();
  const runner = (cmd, args) => { calls.push(args); return answer(args, calls); };
  const done = herdSidebar({ read: () => sessions, runner, refreshMs: 1_000_000, create: async () => app });
  await settle();
  return { app, calls, done, stop: async () => { app.stop(); await done; } };
}

test("a click on a member joins its pane in and hands it the keyboard", async () => {
  const r = await running();
  r.calls.length = 0;
  const screen = r.app.screen();
  const at = screen.find("web");
  screen.click(at.x, at.y);
  await settle();

  assert.ok(r.calls.some((a) => a.includes("join-pane") && a.includes("%2")), "the member's pane was never joined in");
  assert.ok(
    r.calls.some((a) => a[2] === "select-pane" && a.includes("%9")),
    "the content pane never got the keyboard, so the click only half-opened it",
  );
  await r.stop();
});

test("a tmux call that throws paints the reason instead of ending the sidebar", async () => {
  // The crash this whole surface was rebuilt around: the old handler was async
  // with no catch, so one throw out of tmux was an unhandled rejection and Node
  // ended the process.
  let rejected = null;
  const r = await running({ answer: () => { throw new TypeError("Cannot read properties of undefined"); } });
  r.done.catch((e) => { rejected = e; });
  const screen = r.app.screen();
  const at = screen.find("api");
  screen.click(at.x, at.y);
  await settle();

  assert.equal(rejected, null, "the throw escaped as an unhandled rejection");
  assert.match(r.app.screen().text(), /Cannot read properties|could not open/, "nothing said why the click did nothing");
  await r.stop();
});

test("a member that is not running says so rather than half-opening", async () => {
  const r = await running({ sessions: [member("api"), member("dead", { alive: false, state: "gone" })] });
  r.calls.length = 0;
  const screen = r.app.screen();
  const at = screen.find("dead");
  screen.click(at.x, at.y);
  await settle();
  assert.equal(r.calls.filter((a) => a.includes("join-pane")).length, 0);
  assert.match(r.app.screen().text(), /not running/);
  await r.stop();
});

test("enter opens the selected member, so the mouse is not the only way in", async () => {
  const r = await running();
  r.calls.length = 0;
  r.app.key({ key: "down" });
  r.app.key({ key: "enter" });
  await settle();
  assert.ok(
    r.calls.some((a) => a.includes("join-pane") && a.includes("%2")),
    "enter did not open the member the keyboard had selected",
  );
  await r.stop();
});

test("the action keys the sidebar prints are the keys it answers", async () => {
  // The hand-rolled version printed s / a / x beside its actions and its shared
  // input parser only ever emitted the plain list's keys, so three of the five
  // shortcuts did nothing at all.
  const r = await running();
  r.calls.length = 0;
  r.app.key({ key: "x" }); // stop, on the selected member
  await settle();
  assert.ok(r.calls.some((a) => a.includes("kill-pane")), "x never reached the selected member");
  await r.stop();
});

/* ----------------------------------------------------------- pane identity */

test("a pane whose title is not a legal session name can still be parked", () => {
  // claude and a login shell both rename their own pane via OSC 2, and the
  // window option that stops them does not travel with a joined pane.
  const calls = [];
  const runner = (cmd, args) => {
    calls.push(args);
    if (args[2] === "new-session" && /[:.]/.test(String(args[args.indexOf("-s") + 1]))) {
      return { status: 1, stdout: "", stderr: "bad session name\n" };
    }
    return { status: 0, stdout: "%7\n", stderr: "" };
  };
  assert.equal(parkPane("%3", "anthony@dev:~/src/moshcoder/moshcode", { runner }), true);
  const made = calls.find((a) => a[2] === "new-session");
  assert.doesNotMatch(String(made[made.indexOf("-s") + 1]), /[:.]/, "parked under a name tmux cannot address");
});
