// The clickable list. The load-bearing property is that the line a row claims
// and the line it renders on are the same number — everything else is cosmetic,
// but that one drifting sends every click to the wrong session.
import test from "node:test";
import assert from "node:assert/strict";

import { groupByHerd, HEADER_LINES, layout, moveSelection, parseInput, parseMouse, render } from "../src/herd-ui.mjs";

const session = (name, extra = {}) => ({
  name, engine: "claude", herd: "main", state: "idle", cwd: "/x", age: 1000, alive: true, ...extra,
});
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/* ---------------------------------------------------------------- grouping */

test("sessions group under their herd, with main first", () => {
  const groups = groupByHerd([
    session("b", { herd: "scratch" }),
    session("a", { herd: "main" }),
    session("c", { herd: "alpha" }),
  ]);
  assert.deepEqual(groups.map((g) => g.name), ["main", "alpha", "scratch"], "main leads, the rest are alphabetical");
});

test("a session with no herd lands in main, not in a group called undefined", () => {
  // Anything started before herds existed has no herd field, and the manifest
  // outlives releases.
  const groups = groupByHerd([{ name: "old", engine: "claude", state: "idle", cwd: "/x", alive: true }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "main");
});

/* ------------------------------------------------- the click map is the screen */

test("every session renders on exactly the line its click map claims", () => {
  // The bug this exists for: render() printed a two-line header while layout()
  // assumed one, so clicking a row selected the one below it. Caught by
  // rendering the thing rather than reasoning about it.
  const rows = layout(groupByHerd([
    session("api", { herd: "main" }),
    session("work", { herd: "main", engine: "shell" }),
    session("logs", { herd: "scratch", engine: "shell" }),
  ]));
  const lines = strip(render(rows, { selected: 0 })).split("\r\n");

  for (const row of rows.filter((r) => r.kind === "session")) {
    const rendered = lines[row.line - 1];
    assert.ok(rendered, `line ${row.line} for ${row.session.name} is off the end of the screen`);
    assert.match(
      rendered,
      new RegExp(`\\b${row.session.name}\\b`),
      `${row.session.name} claims line ${row.line}, which actually renders as ${JSON.stringify(rendered)}`,
    );
  }
});

test("the header height is shared, not written twice", () => {
  const rows = layout(groupByHerd([session("api")]));
  const lines = strip(render(rows, { selected: 0 })).split("\r\n");
  // The first group heading sits directly after the header block.
  assert.match(lines[HEADER_LINES], /MAIN/);
});

test("a herd heading is never selectable", () => {
  // Pressing enter on a heading must do nothing rather than attach to whatever
  // happens to be next in the array.
  const rows = layout(groupByHerd([session("api"), session("logs", { herd: "scratch" })]));
  let selected = rows.findIndex((r) => r.kind === "session");
  for (let i = 0; i < 10; i++) selected = moveSelection(rows, selected, 1);
  assert.equal(rows[selected].kind, "session");
  for (let i = 0; i < 10; i++) selected = moveSelection(rows, selected, -1);
  assert.equal(rows[selected].kind, "session");
});

test("an empty herd still renders something useful", () => {
  const text = strip(render(layout(groupByHerd([])), { selected: 0 }));
  assert.match(text, /empty/);
  assert.match(text, /moshcode herd shell|agents claude/, "an empty screen should say how to fill it");
});

test("blocked members are counted in the header", () => {
  const rows = layout(groupByHerd([session("a", { state: "blocked" }), session("b")]));
  assert.match(strip(render(rows, { selected: 0 })), /1 waiting on you/);
});

/* -------------------------------------------------------------- mouse input */

test("a left click is decoded to its row", () => {
  assert.deepEqual(parseMouse("\x1b[<0;12;7M"), { kind: "click", col: 12, row: 7 });
});

test("a release is not a second click", () => {
  // SGR reports press and release. Acting on both fires every click twice,
  // which here means entering a session and immediately re-entering it.
  assert.equal(parseMouse("\x1b[<0;12;7m"), null);
});

test("clicks past column 95 still decode", () => {
  // The reason for SGR (1006) over the original scheme: the old encoding packs
  // coordinates into single bytes and cannot express a wide terminal at all.
  assert.deepEqual(parseMouse("\x1b[<0;220;40M"), { kind: "click", col: 220, row: 40 });
});

test("the wheel scrolls the selection rather than clicking", () => {
  assert.deepEqual(parseMouse("\x1b[<64;5;5M"), { kind: "wheel", direction: -1 });
  assert.deepEqual(parseMouse("\x1b[<65;5;5M"), { kind: "wheel", direction: 1 });
});

test("a right or middle click is ignored", () => {
  assert.equal(parseMouse("\x1b[<2;5;5M"), null);
});

test("several reports arriving in one chunk are all decoded", () => {
  // A fast click or a drag delivers more than one report per read; a parser
  // that only looked at the start of the buffer would desync.
  const events = parseInput("\x1b[<0;1;4M\x1b[<0;1;4m\x1b[<0;2;5M");
  assert.equal(events.filter((e) => e.kind === "click").length, 2);
});

test("keys are read when there is no mouse report", () => {
  assert.deepEqual(parseInput("q"), [{ kind: "key", key: "q" }]);
  assert.deepEqual(parseInput("\x1b[B"), [{ kind: "key", key: "\x1b[B" }]);
});
