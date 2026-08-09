// Tiling: the layout commands, and the round trip that must not lose anyone.
//
// The integration half runs against a real tmux on a private socket and skips
// itself when there is none, because the whole feature is tmux doing the work —
// asserting on mocked argv would prove only that the strings are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tileBindings, TILE_SESSION } from "../src/herd-tile.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hasTmux = (() => {
  try { return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0; }
  catch { return false; }
})();

/* ------------------------------------------------------------- keybindings */

test("the tile keys do not fight tmux's own", () => {
  // Every binding is a shifted letter. tmux's lowercase z (zoom), x (kill) and
  // o (next pane) keep working, so the layout adds vocabulary rather than
  // replacing what someone already knows.
  for (const [key] of tileBindings()) {
    assert.match(key, /^[A-Z]$/, `${key} should be an uppercase letter to avoid tmux's own bindings`);
  }
});

test("starting and stopping are both bound, and both re-tile after", () => {
  const bindings = Object.fromEntries(tileBindings());
  assert.match(bindings.S, /split-window/, "S starts a shell");
  assert.match(bindings.A, /agents claude/, "A starts an agent");
  assert.match(bindings.X, /kill-pane/, "X stops one");
  // Without the re-layout, killing a tile leaves a hole and splitting leaves
  // the grid lopsided — the window stops looking tiled after the first action.
  for (const key of ["S", "A", "X"]) {
    assert.match(bindings[key], /select-layout tiled/, `${key} must re-tile`);
  }
  assert.match(bindings.B, /break-pane/, "B pops one back out");
});

/* ------------------------------------------------------------- integration */

test("tiling and untiling is a round trip that keeps every member", (t) => {
  if (!hasTmux) { t.skip("no tmux on this machine"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-tile-test-"));
  const socket = `moshcode-tiletest-${process.pid}`;
  const env = { ...process.env, MOSHCODE_HERD_DIR: dir, MOSHCODE_HERD_SOCKET: socket, MOSHCODE_HERD: "tmux" };
  const run = (source) => spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env, encoding: "utf8", cwd: ROOT,
  });

  try {
    const script = `
      const herd = await import(${JSON.stringify(path.join(ROOT, "src", "herd.mjs"))});
      const tile = await import(${JSON.stringify(path.join(ROOT, "src", "herd-tile.mjs"))});
      const cli  = await import(${JSON.stringify(path.join(ROOT, "src", "herd-cli.mjs"))});
      const quiet = () => {};
      const fakeSpawn = () => ({ on: (ev, cb) => { if (ev === "exit") setTimeout(() => cb(0), 5); } });

      for (const n of ["alpha", "beta"]) {
        herd.startSession({ name: n, engine: "test", bin: "sh",
          args: ["-c", "echo MARK-" + n + "; while read x; do :; done"], cwd: process.cwd() });
      }
      await new Promise((r) => setTimeout(r, 900));

      await tile.herdTile([], { write: quiet, spawner: fakeSpawn });
      const tiled = cli.roster().filter((s) => s.alive).map((s) => s.name).sort();
      const together = new Set(cli.roster().filter((s) => s.alive).map((s) => s.window));
      const readable = herd.capture("alpha", { lines: 10 }).includes("MARK-alpha");

      tile.herdUntile([], { write: quiet });
      await new Promise((r) => setTimeout(r, 300));
      const after = cli.roster().filter((s) => s.alive).map((s) => s.name).sort();
      const stillReadable = herd.capture("beta", { lines: 10 }).includes("MARK-beta");

      console.log(JSON.stringify({ tiled, windows: together.size, readable, after, stillReadable }));
    `;
    const result = run(script);
    assert.equal(result.status, 0, `tile round trip crashed: ${result.stderr}`);
    const out = JSON.parse(result.stdout.trim().split("\n").pop());

    // The point of keying members off pane titles: a tiled member's own session
    // is gone, and it still has to be on the roster.
    assert.deepEqual(out.tiled, ["alpha", "beta"], "tiling must not lose anyone from the roster");
    assert.equal(out.windows, 1, "tiled members share one window");
    assert.equal(out.readable, true, "a tiled member's screen is still readable");
    assert.deepEqual(out.after, ["alpha", "beta"], "untiling must not lose anyone either");
    assert.equal(out.stillReadable, true, "content survives the round trip");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tile window has a fixed, known name", () => {
  // untile finds what to put back by looking for panes in this session, so the
  // two sides have to agree on it.
  assert.equal(typeof TILE_SESSION, "string");
  assert.ok(TILE_SESSION.length);
});
