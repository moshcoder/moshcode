// The sidebar workspace: the row/line agreement a click depends on, and the
// pane swap that has to leave the sidebar alone.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACTIONS, renderSidebar, sidebarRows, WINDOW, WORKSPACE } from "../src/herd-workspace.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hasTmux = (() => {
  try { return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0; }
  catch { return false; }
})();
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const member = (name, extra = {}) => ({
  name, engine: "claude", herd: "main", state: "idle", cwd: "/x", alive: true, ...extra,
});

/* ------------------------------------------------ the click map is the screen */

test("every clickable row renders on exactly the line it claims", () => {
  // Same guarantee the list needed, for the same reason: these line numbers ARE
  // the click map, so a one-line drift sends every click to its neighbour.
  const rows = sidebarRows([member("api"), member("work", { engine: "shell" }), member("logs", { herd: "scratch" })]);
  const lines = strip(renderSidebar(rows, { selected: "api", showing: "api" })).split("\r\n");

  for (const row of rows.filter((r) => r.kind === "session" || r.kind === "action")) {
    const rendered = lines[row.line - 1];
    const label = row.kind === "session" ? row.session.name : row.action.label;
    assert.ok(rendered !== undefined, `line ${row.line} for ${label} is off the end`);
    assert.ok(
      rendered.includes(row.kind === "session" ? row.session.name : row.action.label.split(" ").pop()),
      `${label} claims line ${row.line}, which renders as ${JSON.stringify(rendered)}`,
    );
  }
});

test("actions are always present, even with an empty herd", () => {
  // The sidebar has to be able to CREATE the first member; a herd with nothing
  // in it and no actions would be a dead end.
  const rows = sidebarRows([]);
  const actions = rows.filter((r) => r.kind === "action");
  assert.equal(actions.length, ACTIONS.length);
  assert.match(strip(renderSidebar(rows, {})), /\+ shell/);
});

test("the member being shown is marked differently from the one selected", () => {
  // Selecting and showing are separate: you can move the highlight around
  // without the right-hand pane changing under you.
  const rows = sidebarRows([member("api"), member("web")]);
  const text = strip(renderSidebar(rows, { selected: "web", showing: "api" }));
  const apiLine = text.split("\r\n").find((l) => l.includes("api"));
  assert.match(apiLine, /▸/, "the shown member carries the marker");
});

test("every action has a single-key shortcut and none collide", () => {
  const keys = ACTIONS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, "two actions cannot share a key");
  for (const key of keys) assert.match(key, /^[a-z]$/);
});

/* ------------------------------------------------------------- integration */

test("swapping the content pane leaves the sidebar in place", (t) => {
  if (!hasTmux) { t.skip("no tmux on this machine"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-ws-test-"));
  const socket = `moshcode-wstest-${process.pid}`;
  const env = { ...process.env, MOSHCODE_HERD_DIR: dir, MOSHCODE_HERD_SOCKET: socket, MOSHCODE_HERD: "tmux" };

  try {
    const script = `
      const herd = await import(${JSON.stringify(path.join(ROOT, "src", "herd.mjs"))});
      const ws   = await import(${JSON.stringify(path.join(ROOT, "src", "herd-workspace.mjs"))});
      const cli  = await import(${JSON.stringify(path.join(ROOT, "src", "herd-cli.mjs"))});

      for (const n of ["alpha", "beta"]) {
        herd.startSession({ name: n, engine: "test", bin: "sh",
          args: ["-c", "echo MARK-" + n + "; while read x; do :; done"], cwd: process.cwd() });
      }
      await new Promise((r) => setTimeout(r, 900));

      herd.tmux(["new-session", "-d", "-s", ws.WORKSPACE, "-n", ws.WINDOW,
        "sh -c 'echo SIDEBAR; while read x; do :; done'"]);
      herd.tmux(["set-option", "-t", ws.WORKSPACE, "main-pane-width", "26"]);
      const me = herd.tmux(["list-panes", "-t", ws.TARGET, "-F", "#{pane_id}"]).stdout.trim();

      const widths = [];
      for (const name of ["alpha", "beta", "alpha"]) {
        ws.showMember(name, { me });
        widths.push(herd.tmux(["list-panes", "-t", ws.TARGET, "-F", "#{pane_title}:#{pane_width}"]).stdout.trim().replace(/\\n/g, "|"));
      }
      console.log(JSON.stringify({
        widths,
        sidebarAlive: herd.tmux(["capture-pane", "-p", "-t", me]).stdout.includes("SIDEBAR"),
        roster: cli.roster().filter((s) => s.alive).map((s) => s.name).sort(),
        contentKept: herd.capture("beta", { lines: 10 }).includes("MARK-beta"),
      }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", cwd: ROOT });
    assert.equal(run.status, 0, `workspace swap crashed: ${run.stderr}`);
    const out = JSON.parse(run.stdout.trim().split("\n").pop());

    assert.equal(out.sidebarAlive, true, "the sidebar pane must survive every swap");
    // Neither member may be lost by being moved in and out of the workspace.
    assert.deepEqual(out.roster, ["alpha", "beta"]);
    assert.equal(out.contentKept, true, "a swapped-out member keeps its scrollback");
    // The sidebar must not creep wider each time main-vertical is reapplied.
    for (const state of out.widths) {
      assert.match(state, /:26\b/, `sidebar lost its width: ${state}`);
    }
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the workspace target is one agreed string", () => {
  assert.equal(typeof WORKSPACE, "string");
  assert.equal(typeof WINDOW, "string");
});
