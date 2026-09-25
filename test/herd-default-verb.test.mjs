// Bare `moshcode herd` opens the workspace.
//
// The load-bearing part is not the new default, it is the three guards on it.
// A full-screen UI launched into a pipe, a CI log or a captured writer hangs
// forever on input that is never coming, so every one of those has to keep the
// roster it has always had.
import test from "node:test";
import assert from "node:assert/strict";

import { canOpenUi, takesTerminal } from "../src/herd-cli.mjs";

test("a captured writer never gets a full-screen UI", () => {
  // herdCommand's `write` is injected by the mosh bar (a one-row pane), by the
  // hooks that render herd output into another surface, and by tests. Every one
  // of those collects lines; none of them can be handed a program that paints
  // the screen and waits for a click.
  const lines = [];
  assert.equal(canOpenUi({ write: (l) => lines.push(l), stdout: { isTTY: true } }), false);
});

test("a pipe gets the roster, not the workspace", () => {
  assert.equal(canOpenUi({ stdout: { isTTY: false } }), false);
  assert.equal(canOpenUi({ stdout: {} }), false);
});

test("a real terminal with the default writer opens the workspace", () => {
  // stdin has to be a tty as well: `moshcode herd < /dev/null` on a terminal
  // would otherwise open a UI whose input stream is already at EOF.
  const real = process.stdout.isTTY && process.stdin.isTTY;
  assert.equal(canOpenUi({ stdout: { isTTY: true } }), Boolean(real));
});

test("--json is never the workspace, however good the terminal is", async () => {
  const { herdCommand } = await import("../src/herd-cli.mjs");
  const lines = [];
  const code = await herdCommand(["--json"], { write: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.doesNotThrow(() => JSON.parse(lines.join("\n")), "--json stopped being json");
});

test("the pit is told which herd verbs take the terminal", () => {
  // The pit's readline holds stdin, and tmux and readline cannot both have it.
  // This is the list `/herd` checks before deciding whether to close it.
  for (const verb of ["ui", "sidebar", "bar", "tile", "attach"]) {
    assert.equal(takesTerminal([verb]), true, `${verb} paints the screen`);
  }
  for (const verb of ["ps", "cost", "prompt", "read", "tasks", "wait"]) {
    assert.equal(takesTerminal([verb]), false, `${verb} answers in place`);
  }
  // Bare `herd` takes the terminal exactly when it would open the workspace.
  assert.equal(takesTerminal([], { stdout: { isTTY: false } }), false);
});
