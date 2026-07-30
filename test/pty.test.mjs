// The session mirror showed the pit's own output but nothing from an engine or
// tool, because those run with `stdio: "inherit"` and write straight to the tty.
// These cover the pty capture that fixes it: the flag sets differ per platform
// and a wrong one either 404s the capture or breaks the child, so both spellings
// are pinned.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  followFile, ptyEnabled, ptySpec, scriptFlavor, shQuote, stripScriptBanner,
} from "../src/pty.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("shQuote survives arguments that would break a -c command string", () => {
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("two words"), "'two words'");
  // The dangerous one: a bare apostrophe would end the quote early and hand the
  // rest of the argument to the shell as code.
  assert.equal(shQuote("it's"), "'it'\\''s'");
  assert.equal(shQuote("; rm -rf /"), "'; rm -rf /'");
});

test("util-linux spec flushes, stays quiet, and forwards the exit code", () => {
  const spec = ptySpec("gh", ["pr", "list"], "/tmp/t", "util-linux");
  assert.deepEqual(spec, {
    cmd: "script",
    args: ["-q", "-e", "-f", "-c", "'gh' 'pr' 'list'", "/tmp/t"],
  });
  // -e is what makes `script` exit with the child's status; callers print that
  // code and tests assert on it, so its absence would be a silent regression.
  assert.ok(spec.args.includes("-e"));
  assert.ok(spec.args.includes("-f"), "-f flushes per write — without it this is not realtime");
});

test("bsd spec takes the transcript first and a real argv after", () => {
  assert.deepEqual(ptySpec("gh", ["pr", "list"], "/tmp/t", "bsd"), {
    cmd: "script",
    args: ["-q", "-F", "/tmp/t", "gh", "pr", "list"],
  });
});

test("an unknown flavour or missing input yields no spec, so the caller falls back", () => {
  assert.equal(ptySpec("gh", [], "/tmp/t", "sysv"), null);
  assert.equal(ptySpec("gh", [], "/tmp/t", null), null);
  assert.equal(ptySpec("", [], "/tmp/t", "util-linux"), null);
  assert.equal(ptySpec("gh", [], "", "util-linux"), null);
});

test("scriptFlavor identifies util-linux from its version banner", () => {
  const utilLinux = () => ({ stdout: "script from util-linux 2.41.3\n", stderr: "" });
  assert.equal(scriptFlavor({ platform: "linux", runner: utilLinux }), "util-linux");
});

test("scriptFlavor treats darwin's version-less script as bsd, and gives up elsewhere", () => {
  const bsd = () => ({ stdout: "", stderr: "usage: script [-adfkpqr]...\n" });
  assert.equal(scriptFlavor({ platform: "darwin", runner: bsd }), "bsd");
  // Same unrecognised output on linux is not assumed to be usable.
  assert.equal(scriptFlavor({ platform: "linux", runner: bsd }), null);
  // No script(1) at all.
  assert.equal(scriptFlavor({ platform: "linux", runner: () => ({ error: new Error("ENOENT") }) }), null);
  assert.equal(scriptFlavor({ platform: "linux", runner: () => { throw new Error("boom"); } }), null);
});

test("capture only engages when something is actually watching", () => {
  const sink = () => {};
  assert.equal(ptyEnabled(sink, "util-linux"), true);
  // No mirror attached → unmirrored sessions keep the untouched inherit path.
  assert.equal(ptyEnabled(undefined, "util-linux"), false);
  assert.equal(ptyEnabled(null, "util-linux"), false);
  // No usable script(1) → fall back rather than break the launch.
  assert.equal(ptyEnabled(sink, null), false);
});

test("MOSHCODE_MIRROR_PTY=0 forces capture off", () => {
  const previous = process.env.MOSHCODE_MIRROR_PTY;
  try {
    process.env.MOSHCODE_MIRROR_PTY = "0";
    assert.equal(ptyEnabled(() => {}, "util-linux"), false);
  } finally {
    if (previous === undefined) delete process.env.MOSHCODE_MIRROR_PTY;
    else process.env.MOSHCODE_MIRROR_PTY = previous;
  }
});

test("script's own bookkeeping is stripped from the transcript", () => {
  // `-q` silences these on the terminal but still writes them to the file, so
  // without stripping every mirrored session opens with the quoted command line.
  const header = `Script started on 2026-07-30 14:44:30+00:00 [COMMAND="'/usr/bin/node' '/tmp/probe.mjs'" <not executed on terminal>]\n`;
  const footer = `\nScript done on 2026-07-30 14:44:30+00:00 [COMMAND_EXIT_CODE="23"]\n`;
  assert.equal(stripScriptBanner(`${header}HELLO\r\n`, true), "HELLO\r\n");
  assert.equal(stripScriptBanner(`HELLO\r\n${footer}`), "HELLO\r\n");
  assert.equal(stripScriptBanner(`${header}HELLO\r\n${footer}`, true), "HELLO\r\n");
});

test("banner stripping leaves ordinary output alone", () => {
  // Only the anchored header/footer go. A mid-stream line that merely mentions
  // the words is the child's output and must survive verbatim.
  assert.equal(stripScriptBanner("Script started on my own terms\n", false), "Script started on my own terms\n");
  assert.equal(stripScriptBanner("echo Script done on tuesday\nmore\n", true), "echo Script done on tuesday\nmore\n");
  assert.equal(stripScriptBanner("plain output\n", true), "plain output\n");
  assert.equal(stripScriptBanner("", true), "");
});

test("followFile streams appended output and drains the tail on stop", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-follow-"));
  const file = path.join(dir, "transcript");
  writeFileSync(file, "");
  const seen = [];
  const stop = followFile(file, (c) => seen.push(c), { intervalMs: 10 });
  try {
    appendFileSync(file, "first\n");
    await sleep(60);
    appendFileSync(file, "second\n");
    await sleep(60);
    // Written right before stop(): the final drain must not lose it, because
    // the end of a session is usually the part you went looking for.
    appendFileSync(file, "last\n");
    stop();
    assert.equal(seen.join(""), "first\nsecond\nlast\n");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("followFile tolerates a file that does not exist yet", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-follow-"));
  const file = path.join(dir, "not-yet");
  const seen = [];
  const stop = followFile(file, (c) => seen.push(c), { intervalMs: 10 });
  try {
    await sleep(30);
    writeFileSync(file, "arrived\n");
    await sleep(60);
    stop();
    assert.equal(seen.join(""), "arrived\n");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
