// A key pressed on the session page has to reach the engine, not the pit
// behind it.
//
// The mirror could always *show* a hand-off — `/agents claude` goes under a pty
// and its screen streams up — but delivery ran the other way through
// `stdin.emit("data", …)`, a synthesised event on this process's own stdin
// object. Readline hears that. A child spawned with `stdio: "inherit"` reads a
// file descriptor and hears nothing, so Claude's "do you trust this folder?"
// arrived on the page defaulted to No with no way to move off it: ↓ went to a
// closed readline in the parent and the prompt never twitched.
//
// These pin the fix at the level it actually failed — real script(1), a real
// child, real escape sequences on a real fd — because every individual piece
// was already sound and it was the wiring between them that was missing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureSpec, captureWithInput, cursorKeyMode, ptyShellSpec, scriptFlavor, toApplicationCursor,
} from "../src/pty.mjs";
import { KEY_BYTES, activeChildInput, pressKey, setActiveChildInput } from "../src/mirror.mjs";

const CAPTURABLE = Boolean(scriptFlavor());
// A literal ESC, spelled out so it survives every editor and diff viewer.
const ESC = String.fromCharCode(27);

/**
 * A stand-in for a real terminal. `node --test` has no tty, and the input path
 * refuses to engage without one — quite deliberately — so the test supplies the
 * handful of things it touches rather than skipping the whole file.
 */
function fakeTty({ columns = 100, rows = 30 } = {}) {
  const listeners = new Map();
  return {
    isTTY: true,
    isRaw: false,
    columns,
    rows,
    rawCalls: [],
    resumed: 0,
    paused: 0,
    setRawMode(on) { this.isRaw = on; this.rawCalls.push(on); },
    resume() { this.resumed += 1; },
    pause() { this.paused += 1; },
    on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); return this; },
    off(event, fn) { listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn)); return this; },
    emit(event, arg) { for (const fn of listeners.get(event) || []) fn(arg); },
    count(event) { return (listeners.get(event) || []).length; },
  };
}

/**
 * A child that names the raw bytes it is handed and exits once it sees `stop`.
 *
 * Exits on a byte rather than after N reads because a terminal does not promise
 * one read per key: two writes in quick succession arrive coalesced, and the
 * first version of this counted `data` events and hung waiting for a second one
 * that a working relay had already folded into the first.
 */
function keyReporter(dir, stop) {
  const file = path.join(dir, "reporter.mjs");
  fs.writeFileSync(file, [
    'process.stdin.setRawMode(true); process.stdin.resume();',
    'console.log("READY " + process.stdout.columns + "x" + process.stdout.rows);',
    'process.stdin.on("data", (b) => {',
    '  console.log("KEY " + [...b].map((x) => x.toString(16).padStart(2, "0")).join(" "));',
    `  if (b.includes(${stop})) process.exit(0);`,
    '});',
  ].join("\n"));
  return file;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await settle(25);
  }
  return false;
}

test("ptyShellSpec runs a shell line under both script flavours", () => {
  assert.deepEqual(ptyShellSpec("stty rows 1; exec vi", "/tmp/t", "util-linux"),
    { cmd: "script", args: ["-q", "-e", "-f", "-c", "stty rows 1; exec vi", "/tmp/t"] });
  // BSD wants the transcript first and a real argv after, so the line needs a
  // shell of its own rather than being handed to script as a command string.
  assert.deepEqual(ptyShellSpec("stty rows 1; exec vi", "/tmp/t", "bsd"),
    { cmd: "script", args: ["-q", "-F", "/tmp/t", "sh", "-c", "stty rows 1; exec vi"] });
  assert.equal(ptyShellSpec("exec vi", "/tmp/t", "sysv"), null);
  assert.equal(ptyShellSpec("", "/tmp/t", "util-linux"), null);
});

test("without a local tty there is nothing to relay, so the input path declines", () => {
  const notATty = { isTTY: false, setRawMode() {} };
  assert.equal(captureWithInput({ cmd: "cat" }, () => {}, { flavor: "util-linux", stdin: notATty }), null);
  // …and captureSpec falls back to capturing output rather than losing both.
  const spec = captureSpec({ cmd: "cat" }, () => {}, { flavor: "util-linux", input: true, stdin: notATty });
  assert.equal(spec.stdio, "inherit");
  assert.equal(spec.write("anything"), false);
  spec.stop();
});

test("a launch that never asked for input is untouched by any of this", () => {
  const spec = captureSpec({ cmd: "gh", args: ["pr", "list"] }, undefined);
  assert.equal(spec.stdio, "inherit", "the caller spawns exactly what it always spawned");
  assert.equal(spec.write("x"), false);
  spec.stop();
});

test("an arrow key written from outside lands on a running child as an escape sequence",
  { skip: !CAPTURABLE }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-input-"));
    const stdin = fakeTty();
    const stdout = fakeTty({ columns: 100, rows: 30 });
    let seen = "";
    const launch = captureSpec(
      { cmd: process.execPath, args: [keyReporter(dir, 0x0d)] },
      (chunk) => { seen += chunk; },
      { flavor: scriptFlavor(), input: true, stdin, stdout },
    );
    assert.notEqual(launch.stdio, "inherit", "the child's stdin has to be ours to write to");

    const child = spawn(launch.cmd, launch.args, { stdio: launch.stdio });
    const exited = new Promise((resolve) => child.on("exit", resolve));

    assert.ok(await waitFor(() => seen.includes("READY")), `child never started: ${JSON.stringify(seen)}`);
    // The fifo has no geometry of its own, so a child that starts 0x0 is the
    // failure this guards: full-screen engines do not survive it.
    assert.match(seen, /READY 100x30/, `child got the wrong terminal size: ${JSON.stringify(seen)}`);

    assert.equal(launch.write(KEY_BYTES.down), true);
    assert.equal(launch.write("\r"), true);

    await exited;
    launch.stop();
    // 1b 5b 42 is ESC [ B — down — and 0d is carriage return. Assert on the
    // byte stream rather than per read: the two writes land coalesced as often
    // as not, and how the reads were split is the terminal's business, not
    // something a program navigating a menu can tell apart.
    const bytes = [...seen.matchAll(/KEY ([0-9a-f ]+)/g)].map((m) => m[1].trim()).join(" ");
    assert.equal(bytes, "1b 5b 42 0d",
      `the child got the wrong bytes, in the wrong order, or not at all: ${JSON.stringify(seen)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test("the keyboard keeps working: local stdin is relayed into the same child",
  { skip: !CAPTURABLE }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-input-local-"));
    const stdin = fakeTty();
    const stdout = fakeTty();
    let seen = "";
    const launch = captureSpec(
      { cmd: process.execPath, args: [keyReporter(dir, 0x61)] },
      (chunk) => { seen += chunk; },
      { flavor: scriptFlavor(), input: true, stdin, stdout },
    );
    const child = spawn(launch.cmd, launch.args, { stdio: launch.stdio });
    const exited = new Promise((resolve) => child.on("exit", resolve));

    assert.ok(await waitFor(() => seen.includes("READY")), "child never started");
    // Raw, or the local tty would echo every character twice and hold Enter
    // back until the child had already redrawn without it.
    assert.deepEqual(stdin.rawCalls, [true]);
    stdin.emit("data", Buffer.from([0x61])); // someone types "a"

    await exited;
    launch.stop();
    assert.match(seen, /KEY 61/, `a locally typed key never reached the child: ${JSON.stringify(seen)}`);
    // The terminal has to go back the way we found it; leaving it raw looks
    // like a hung pit with no echo.
    assert.deepEqual(stdin.rawCalls, [true, false]);
    assert.equal(stdin.count("data"), 0, "the relay must not outlive the child");
    assert.equal(stdout.count("resize"), 0, "nor the resize hook");
    fs.rmSync(dir, { recursive: true, force: true });
  });

test("pressKey prefers a running child over readline and over process.stdin", () => {
  const written = [];
  const rl = { write() { throw new Error("readline must not see a key while an engine has the terminal"); } };
  const stdin = { emit() { throw new Error("nor may the parent's own stdin"); } };
  setActiveChildInput((bytes) => { written.push(bytes); return true; });
  try {
    assert.equal(activeChildInput() !== null, true);
    assert.equal(pressKey("down", rl, stdin), true);
    assert.equal(pressKey("enter", rl, stdin), true);
    assert.deepEqual(written, ["[B", "\r"]);
    // An unknown key is still refused outright, so a newer page cannot make an
    // older CLI put something odd in front of an engine.
    assert.equal(pressKey("f7", rl, stdin), false);
    assert.equal(written.length, 2);
  } finally {
    setActiveChildInput(null);
  }
});

test("with no child running, pressKey falls back to the pit exactly as before", () => {
  setActiveChildInput(null);
  const pressed = [];
  const rl = { write(line, key) { pressed.push([line, key]); } };
  assert.equal(pressKey("up", rl), true);
  assert.deepEqual(pressed, [[null, { name: "up" }]]);

  // And with no readline either, the synthesised event is still what drives the
  // pit's raw-mode readers (the herd bar, the reader, a menu).
  const bytes = [];
  const stdin = { emit(event, buf) { bytes.push([event, buf.toString("latin1")]); } };
  assert.equal(pressKey("left", null, stdin), true);
  assert.deepEqual(bytes, [["data", "[D"]]);
});

test("a child that has gone away refuses writes instead of throwing", { skip: !CAPTURABLE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-input-dead-"));
  const stdin = fakeTty();
  const launch = captureSpec(
    { cmd: process.execPath, args: [keyReporter(dir, 0x61)] },
    () => {},
    { flavor: scriptFlavor(), input: true, stdin, stdout: fakeTty() },
  );
  launch.stop();
  assert.equal(launch.write("[B"), false, "a write after stop is refused, not thrown");
  assert.doesNotThrow(() => launch.stop(), "stop is idempotent");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Application cursor keys
// ---------------------------------------------------------------------------
//
// A full-screen program usually asks for the SS3 form of the cursor keys on its
// way in (DECCKM, `ESC [ ? 1 h`), and a real terminal quietly obliges — which is
// why nobody meets this until something starts synthesising keys. Fed the CSI
// form in that mode, `less` does not scroll: it prints "ESC[B" on its own prompt
// line, exactly as if the characters had been typed. The first version of the
// relay did that, and only a full-screen program caught it.

test("DECCKM is read off the child's own output", () => {
  assert.equal(cursorKeyMode("nothing to see"), false);
  assert.equal(cursorKeyMode(`${ESC}[?1h`, false), true);
  assert.equal(cursorKeyMode(`${ESC}[?1l`, true), false);
  // A chunk with no announcement leaves the mode where it was.
  assert.equal(cursorKeyMode("plain output", true), true);
  // Last one in the chunk wins: entering and leaving in one read is a program
  // that ended up back in normal mode.
  assert.equal(cursorKeyMode(`${ESC}[?1h drawing ${ESC}[?1l`, false), false);
  // The neighbours must not be mistaken for it — alternate screen, mouse
  // tracking and cursor visibility all live at `?1…` too.
  assert.equal(cursorKeyMode(`${ESC}[?1049h`, false), false, "alternate screen is not DECCKM");
  assert.equal(cursorKeyMode(`${ESC}[?1000h`, false), false, "mouse tracking is not DECCKM");
  assert.equal(cursorKeyMode(`${ESC}[?25h`, false), false, "cursor visibility is not DECCKM");
  // And a bare mention in ordinary text, with no ESC leading it, is just text.
  assert.equal(cursorKeyMode("the sequence [?1h sets it", false), false);
});

test("only the four cursor keys are rewritten for application mode", () => {
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
  assert.equal(hex(toApplicationCursor(Buffer.from(`${ESC}[A`, "latin1"))), "1b 4f 41");
  assert.equal(hex(toApplicationCursor(Buffer.from(`${ESC}[B`, "latin1"))), "1b 4f 42");
  assert.equal(hex(toApplicationCursor(Buffer.from(`${ESC}[C`, "latin1"))), "1b 4f 43");
  assert.equal(hex(toApplicationCursor(Buffer.from(`${ESC}[D`, "latin1"))), "1b 4f 44");
  // Enter, ordinary text, a bare ESC and a sequence that merely looks close are
  // all left exactly as they arrived.
  assert.equal(hex(toApplicationCursor(Buffer.from("\r", "latin1"))), "0d");
  assert.equal(hex(toApplicationCursor(Buffer.from("yes", "latin1"))), "79 65 73");
  assert.equal(hex(toApplicationCursor(Buffer.from(`${ESC}[E`, "latin1"))), "1b 5b 45");
  assert.equal(hex(toApplicationCursor(Buffer.from(`${ESC}`, "latin1"))), "1b");
  // The input is not mutated in place; callers keep whatever they handed over.
  const original = Buffer.from(`${ESC}[B`, "latin1");
  toApplicationCursor(original);
  assert.equal(hex(original), "1b 5b 42");
});

test("a child that asked for application cursor keys is sent the form it asked for",
  { skip: !CAPTURABLE }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-input-decckm-"));
    const file = path.join(dir, "reporter.mjs");
    // Announces DECCKM the way a full-screen program does, then reports.
    fs.writeFileSync(file, [
      'process.stdin.setRawMode(true); process.stdin.resume();',
      'process.stdout.write("\u001b[?1h");',
      'console.log("READY");',
      'process.stdin.on("data", (b) => {',
      '  console.log("KEY " + [...b].map((x) => x.toString(16).padStart(2, "0")).join(" "));',
      '  process.exit(0);',
      '});',
    ].join("\n"));

    const stdin = fakeTty();
    let seen = "";
    const launch = captureSpec(
      { cmd: process.execPath, args: [file] },
      (chunk) => { seen += chunk; },
      { flavor: scriptFlavor(), input: true, stdin, stdout: fakeTty() },
    );
    const child = spawn(launch.cmd, launch.args, { stdio: launch.stdio });
    const exited = new Promise((resolve) => child.on("exit", resolve));

    assert.ok(await waitFor(() => seen.includes("READY")), "child never started");
    // Give the follower a tick to have read the announcement before we press.
    assert.ok(await waitFor(() => seen.includes("[?1h")), "the mode switch never reached us");
    launch.write(KEY_BYTES.down);

    await exited;
    launch.stop();
    // 1b 4f 42 is ESC O B. Arriving as 1b 5b 42 is the bug: the program prints
    // the characters instead of moving.
    assert.match(seen, /KEY 1b 4f 42/, `down arrived in the wrong form: ${JSON.stringify(seen)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
