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
      const me = herd.tmux(["list-panes", "-t", ws.TARGET, "-F", "#{pane_id}"]).stdout.trim();
      herd.tmux(["select-pane", "-t", me, "-T", ${JSON.stringify("herd")}]);
      herd.tmux(["resize-window", "-t", ws.TARGET, "-x", "100", "-y", "30"]);
      ws.buildBar({ command: "sh -c 'echo BAR; while read x; do :; done'" });

      const widths = [];
      const footers = [];
      for (const name of ["alpha", "beta", "alpha"]) {
        ws.showMember(name, { me });
        widths.push(herd.tmux(["list-panes", "-t", ws.TARGET, "-F", "#{pane_title}:#{pane_width}"]).stdout.trim().replace(/\\n/g, "|"));
        footers.push(herd.tmux(["list-panes", "-t", ws.TARGET,
          "-F", "#{pane_title}:#{pane_height}:#{pane_width}:#{pane_left}"]).stdout.trim()
          .split("\\n").find((l) => l.startsWith("mosh-bar:")) || "MISSING");
      }
      const focused = ws.focusContent({ me });
      const active = herd.tmux(["list-panes", "-t", ws.TARGET, "-F", "#{pane_title}:#{pane_active}"]).stdout
        .trim().split("\\n").find((l) => l.endsWith(":1"));
      console.log(JSON.stringify({
        widths,
        footers,
        focused,
        active,
        jumpKey: herd.tmux(["list-keys", "-T", "root"]).stdout.split("\\n").filter((l) => l.includes("F12")),
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
    // The sidebar must not creep wider each time the content is swapped.
    for (const state of out.widths) {
      assert.match(state, /:26\b/, `sidebar lost its width: ${state}`);
    }

    // The footer is the only thing on screen that is always visible, so losing
    // it — or letting a swap give it half the window — is the whole bug back.
    for (const footer of out.footers) {
      const [, height, width, left] = footer.split(":");
      assert.notEqual(footer, "MISSING", "the bar did not survive a swap");
      assert.equal(height, "1", `the bar grew to ${height} rows: ${footer}`);
      assert.equal(left, "0", "the bar must span from the left edge");
      assert.equal(width, "100", `the bar must span the full width, got ${width}`);
    }

    // Enter has to reach the agent, or the workspace can only ever be watched.
    assert.equal(out.focused, true);
    assert.match(out.active, /^alpha:1$/, `focus went to ${out.active} instead of the session`);

    // A bare ";" argument ends bind-key instead of chaining, which bound a key
    // that switched sessions and did nothing else. Both halves or it is broken.
    assert.equal(out.jumpKey.length, 1, `expected one F12 binding, got ${out.jumpKey.length}`);
    assert.match(out.jumpKey[0], /switch-client/);
    assert.match(out.jumpKey[0], /select-pane/, "the jump key must also land on the bar");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the workspace target is one agreed string", () => {
  assert.equal(typeof WORKSPACE, "string");
  assert.equal(typeof WINDOW, "string");
});
