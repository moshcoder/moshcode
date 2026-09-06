import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULTS,
  canCapMemory,
  clampCpu,
  clampIo,
  describeNice,
  loadNice,
  niceFile,
  parseMemory,
  saveNice,
  throttleSpec,
} from "../src/nice.mjs";

/**
 * $HOME is a temp dir per test so the suite never reads or writes the throttle
 * of whoever is running it — src/nice.mjs derives the path per call for this.
 */
function withHome(fn) {
  const HOME = mkdtempSync(join(tmpdir(), "moshcode-nice-"));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  try { return fn(HOME); }
  finally {
    if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
  }
}

/** A fake box: only the binaries named here exist. */
const boxWith = (...bins) => (bin) => bins.includes(bin);

const BARE = { cmd: "/usr/bin/claude", args: ["--resume"] };

test("throttle is off by default, so a fresh install spawns exactly what it used to", () => {
  withHome(() => {
    const spec = throttleSpec(BARE, { has: boxWith("nice", "ionice"), platform: "linux" });
    assert.equal(spec.cmd, "/usr/bin/claude");
    assert.deepEqual(spec.args, ["--resume"]);
    assert.equal(spec.throttled, false);
  });
});

test("on a box with both, nice wraps ionice wraps the command", () => {
  const spec = throttleSpec(BARE, {
    settings: { on: true, ...DEFAULTS },
    has: boxWith("nice", "ionice"),
    platform: "linux",
  });
  assert.equal(spec.cmd, "nice");
  assert.deepEqual(spec.args, [
    "-n", "10",
    "ionice", "-c", "2", "-n", "7",
    "/usr/bin/claude", "--resume",
  ]);
  assert.equal(spec.throttled, true);
});

test("a box without ionice still gets nice rather than nothing", () => {
  const spec = throttleSpec(BARE, {
    settings: { on: true, ...DEFAULTS },
    has: boxWith("nice"),
    platform: "linux",
  });
  assert.equal(spec.cmd, "nice");
  assert.deepEqual(spec.args, ["-n", "10", "/usr/bin/claude", "--resume"]);
});

test("a box with neither returns the spec untouched instead of a broken command line", () => {
  const spec = throttleSpec(BARE, {
    settings: { on: true, ...DEFAULTS },
    has: boxWith(),
    platform: "linux",
  });
  assert.equal(spec.cmd, "/usr/bin/claude");
  assert.deepEqual(spec.args, ["--resume"]);
  assert.equal(spec.throttled, false);
});

test("windows is a no-op — nice/ionice are not a thing there", () => {
  const spec = throttleSpec(BARE, {
    settings: { on: true, ...DEFAULTS },
    has: () => true,
    platform: "win32",
  });
  assert.equal(spec.cmd, "/usr/bin/claude");
  assert.equal(spec.throttled, false);
});

test("a memory ceiling goes OUTSIDE nice, so the cgroup encloses the whole pipeline", () => {
  const spec = throttleSpec(BARE, {
    settings: { on: true, ...DEFAULTS, memoryMax: "2G" },
    has: boxWith("nice", "ionice", "systemd-run"),
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    platform: "linux",
  });
  assert.equal(spec.cmd, "systemd-run");
  assert.deepEqual(spec.args, [
    "--user", "--scope", "--quiet",
    "-p", "MemoryMax=2G",
    "--",
    "nice", "-n", "10",
    "ionice", "-c", "2", "-n", "7",
    "/usr/bin/claude", "--resume",
  ]);
});

test("no systemd user session means no scope — the engine still launches", () => {
  // systemd-run --user fails outright without a session bus, which would take
  // the engine down with it. Better to drop the ceiling than the command.
  const spec = throttleSpec(BARE, {
    settings: { on: true, ...DEFAULTS, memoryMax: "2G" },
    has: boxWith("nice", "ionice", "systemd-run"),
    env: {},
    platform: "linux",
  });
  assert.equal(spec.cmd, "nice");
  assert.ok(!spec.args.includes("systemd-run"));
  assert.ok(spec.args.includes("/usr/bin/claude"));
});

test("settings survive a round trip and the file is owner-only", () => {
  withHome(() => {
    saveNice({ on: true, cpu: 15, io: 3, memoryMax: "4G", memoryHigh: "" });
    const back = loadNice();
    assert.equal(back.on, true);
    assert.equal(back.cpu, 15);
    assert.equal(back.io, 3);
    assert.equal(back.memoryMax, "4G");
    // Values include how you run things; same 0600 as aliases and history.
    assert.equal(statSync(niceFile()).mode & 0o777, 0o600);
  });
});

test("a hand-mangled file reads as off rather than throwing on the spawn path", () => {
  withHome((HOME) => {
    mkdirSync(join(HOME, ".moshcode"), { recursive: true });
    writeFileSync(niceFile(), "{ not json at all,,,");
    const back = loadNice();
    assert.equal(back.on, false);
    assert.equal(back.cpu, DEFAULTS.cpu);
  });
});

test("one bad key loses only itself", () => {
  withHome((HOME) => {
    mkdirSync(join(HOME, ".moshcode"), { recursive: true });
    writeFileSync(niceFile(), JSON.stringify({ on: true, cpu: "loud", io: 2, memoryMax: "not a size" }));
    const back = loadNice();
    assert.equal(back.on, true);
    assert.equal(back.cpu, DEFAULTS.cpu, "bad cpu falls back");
    assert.equal(back.io, 2, "good io survives");
    assert.equal(back.memoryMax, "", "unparseable size is dropped, not passed to systemd");
  });
});

test("levels are clamped to what nice(1) and ionice(1) actually accept", () => {
  assert.equal(clampCpu(99), 19);
  assert.equal(clampCpu(-99), -20);
  assert.equal(clampIo(99), 7);
  assert.equal(clampIo(-1), 0);
  withHome(() => {
    const saved = saveNice({ on: true, cpu: 500, io: 500 });
    assert.equal(saved.cpu, 19);
    assert.equal(saved.io, 7);
  });
});

test("memory sizes are validated before they can reach systemd", () => {
  assert.deepEqual(parseMemory("2G"), { ok: true, value: "2G" });
  assert.deepEqual(parseMemory("1500m"), { ok: true, value: "1500M" });
  assert.deepEqual(parseMemory("off"), { ok: true, value: "" });
  assert.deepEqual(parseMemory(""), { ok: true, value: "" });
  assert.equal(parseMemory("a lot").ok, false);
  assert.equal(parseMemory("2 gigs").ok, false);
});

test("canCapMemory needs both the binary and a session bus", () => {
  assert.equal(canCapMemory({ has: boxWith("systemd-run"), env: { XDG_RUNTIME_DIR: "/run/user/1000" } }), true);
  assert.equal(canCapMemory({ has: boxWith("systemd-run"), env: {} }), false);
  assert.equal(canCapMemory({ has: boxWith(), env: { XDG_RUNTIME_DIR: "/run/user/1000" } }), false);
});

test("status line says when a ceiling is set but cannot be enforced here", () => {
  const settings = { on: true, ...DEFAULTS, memoryMax: "2G" };
  const enforced = describeNice(settings, { has: boxWith("systemd-run"), env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
  assert.match(enforced, /MemoryMax=2G/);
  assert.doesNotMatch(enforced, /not applied/);

  const cannot = describeNice(settings, { has: boxWith(), env: {} });
  assert.match(cannot, /not applied/, "a ceiling that silently does nothing is the one thing worth saying");
});

test("off reads as off in the status line", () => {
  assert.match(describeNice({ on: false, ...DEFAULTS }), /off/);
});
