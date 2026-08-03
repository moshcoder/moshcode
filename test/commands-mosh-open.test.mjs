import assert from "node:assert/strict";
import test from "node:test";

import { moshVocabulary } from "../src/commands.mjs";

// mosh() gates its browser line on openBrowser(), which can only report that a
// spawn was *started*: a missing opener arrives as an async 'error' event well
// after the call returns. These tests drive the real (non-dry) path with an
// empty PATH, so the opener genuinely cannot be found on any platform, and pin
// that the output never claims a browser that did not open.

function createCtx({ dryRun = false } = {}) {
  return {
    dryRun,
    iter: 0,
    stopped: false,
    lines: [],
    out(line) {
      this.lines.push(line);
    },
    stop() {
      this.stopped = true;
    },
  };
}

function verb(name) {
  const cmd = moshVocabulary().get(name);
  assert.ok(cmd, `expected a ${name}() command in the vocabulary`);
  return cmd.run;
}

/** Run body with env overrides restored afterwards (undefined = delete). */
async function withEnv(overrides, body) {
  const saved = new Map(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A desktop with no opener anywhere on PATH: `open`/`cmd`/`xdg-open` all ENOENT. */
const noOpenerDesktop = { PATH: "", DISPLAY: ":0", WAYLAND_DISPLAY: undefined };

test("mosh() does not claim the browser launched when no opener exists", async () => {
  const ctx = createCtx();
  await withEnv(noOpenerDesktop, () => verb("mosh")(ctx));

  const output = ctx.lines.join("\n");
  assert.ok(
    !/launched in your browser/.test(output),
    `mosh() reported a completed launch it cannot observe:\n${output}`
  );
});

test("mosh() still tells you it is opening a browser on a desktop", async () => {
  const ctx = createCtx();
  await withEnv(noOpenerDesktop, () => verb("mosh")(ctx));

  // The fix must not silence the line — only stop it overstating the outcome.
  assert.match(ctx.lines.join("\n"), /opening it in your browser/);
});

test("mosh() prints the playlist url on the real path too", async () => {
  const ctx = createCtx();
  await withEnv(noOpenerDesktop, () => verb("mosh")(ctx));

  assert.match(ctx.lines.join("\n"), /open\.spotify\.com\/playlist\//);
});

test("mosh() opens nothing under --dry-run", async () => {
  const ctx = createCtx({ dryRun: true });
  await withEnv(noOpenerDesktop, () => verb("mosh")(ctx));

  const output = ctx.lines.join("\n");
  assert.ok(!/in your browser/.test(output), `dry run tried to open a browser:\n${output}`);
  assert.match(output, /open\.spotify\.com\/playlist\//);
});

// hasDesktop() short-circuits to true on darwin/win32, so only a POSIX box with
// no display server can exercise the headless branch.
const needsDisplayGate =
  process.platform === "darwin" || process.platform === "win32" ?
    { skip: "hasDesktop() is unconditionally true here" }
  : {};

test("mosh() says nothing about a browser on a headless box", needsDisplayGate, async () => {
  const ctx = createCtx();
  await withEnv({ PATH: "", DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () =>
    verb("mosh")(ctx)
  );

  const output = ctx.lines.join("\n");
  assert.ok(!/in your browser/.test(output), `headless run mentioned a browser:\n${output}`);
  assert.match(output, /open\.spotify\.com\/playlist\//);
});
