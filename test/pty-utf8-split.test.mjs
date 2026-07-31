// followFile hands the mirror whatever bytes a poll tick happened to catch, and
// that boundary lands wherever it lands — regularly in the middle of a
// multi-byte character. Decoding each slice on its own turned those into U+FFFD,
// which matters because engines draw their full-screen UI out of box-drawing
// characters (three UTF-8 bytes each): a mirrored session that ran past the
// 64KB read slice showed a wall of replacement characters.
//
// Two boundaries can split a character and both are covered here: the 65536
// byte read slice inside a single tick, and the gap between two ticks.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { followFile } from "../src/pty.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_SLICE = 65536;

/** A scratch dir plus a collector, torn down whatever the test does. */
function withFollow(name, run) {
  const dir = mkdtempSync(path.join(tmpdir(), `moshcode-utf8-${name}-`));
  const file = path.join(dir, "transcript");
  const seen = [];
  let stop = null;
  const start = (opts = {}) => {
    stop = followFile(file, (c) => seen.push(c), { intervalMs: 10, ...opts });
    return stop;
  };
  return Promise.resolve(run({ file, seen, start, text: () => seen.join("") }))
    .finally(() => {
      try { stop?.(); } catch { /* already stopped */ }
      rmSync(dir, { recursive: true, force: true });
    });
}

test("a character straddling the 64KB read boundary is not corrupted", async () => {
  await withFollow("slice", async ({ file, start, text }) => {
    // "─" is U+2500, three bytes (e2 94 80). Padding it to exactly one byte
    // short of the slice puts its first byte at the end of read one and the
    // other two at the start of read two.
    const payload = `${"x".repeat(READ_SLICE - 1)}─done`;
    writeFileSync(file, payload);
    const stop = start();
    await sleep(60);
    stop();
    assert.equal(text(), payload);
    assert.equal(text().includes("�"), false);
  });
});

test("a character split across two poll ticks is not corrupted", async () => {
  await withFollow("tick", async ({ file, start, text }) => {
    writeFileSync(file, "");
    const stop = start();
    // "é" is two bytes (c3 a9). Write the first, let a tick read it, then the
    // second — exactly what a pty flush landing mid-character looks like.
    const bytes = Buffer.from("héllo", "utf8");
    appendFileSync(file, bytes.subarray(0, 2));
    await sleep(40);
    appendFileSync(file, bytes.subarray(2));
    await sleep(40);
    stop();
    assert.equal(text(), "héllo");
  });
});

test("a box-drawing UI larger than the read slice survives intact", async () => {
  await withFollow("boxes", async ({ file, start, text }) => {
    // What an engine's framed UI actually looks like, run past the slice so the
    // boundary has to fall inside a character rather than between two.
    const row = "│ ┌─────┐ ├─┤ └─────┘ │\r\n";
    const payload = row.repeat(Math.ceil((READ_SLICE * 2) / row.length));
    writeFileSync(file, payload);
    const stop = start();
    await sleep(80);
    stop();
    assert.ok(Buffer.byteLength(payload) > READ_SLICE, "payload must cross the slice");
    assert.equal(text(), payload);
    assert.equal((text().match(/�/g) || []).length, 0);
  });
});

test("astral characters spanning the read boundary survive intact", async () => {
  await withFollow("astral", async ({ file, start, text }) => {
    // Emoji are four UTF-8 bytes and two JS code units, so they can be split in
    // two different places. Sweeping the pad length walks the boundary through
    // every byte of the character.
    for (const pad of [3, 2, 1, 0]) {
      const payload = `${"y".repeat(READ_SLICE - pad)}🚀tail`;
      writeFileSync(file, payload);
      const seen = [];
      const stop = followFile(file, (c) => seen.push(c), { intervalMs: 10 });
      await sleep(60);
      stop();
      assert.equal(seen.join(""), payload, `pad ${pad}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Controls. These pass with or without the fix; they are here so the fix cannot
// buy clean decoding by dropping or reordering output.
// ---------------------------------------------------------------------------

test("plain ASCII still streams in order and drains on stop", async () => {
  await withFollow("ascii", async ({ file, start, text }) => {
    writeFileSync(file, "");
    const stop = start();
    appendFileSync(file, "first\n");
    await sleep(40);
    appendFileSync(file, "second\n");
    await sleep(40);
    appendFileSync(file, "last\n");
    stop();
    assert.equal(text(), "first\nsecond\nlast\n");
  });
});

test("a genuinely truncated character at end of stream is still emitted", async () => {
  await withFollow("truncated", async ({ file, start, text }) => {
    writeFileSync(file, "");
    const stop = start();
    // The first two bytes of a three-byte character and then nothing more —
    // a killed child. Held-back bytes must not vanish silently: the tail is
    // reported as replacement text, and everything before it is intact.
    appendFileSync(file, Buffer.from("ok", "utf8"));
    appendFileSync(file, Buffer.from([0xe2, 0x94]));
    await sleep(40);
    stop();
    assert.equal(text().startsWith("ok"), true);
    assert.ok(text().length > 2, "the truncated tail must not be swallowed");
  });
});

test("a replaced transcript resyncs instead of reading from the middle", async () => {
  await withFollow("rotate", async ({ file, start, text }) => {
    writeFileSync(file, "");
    const stop = start();
    appendFileSync(file, "aaaaaaaaaa\n");
    await sleep(40);
    // Shorter than what we have already read: the follower must start over
    // rather than seek past the end of the new content.
    writeFileSync(file, "bb\n");
    await sleep(40);
    stop();
    assert.equal(text().includes("aaaaaaaaaa\n"), true);
    assert.equal(text().endsWith("bb\n"), true);
  });
});

test("a file that does not exist yet is picked up once it appears", async () => {
  await withFollow("late", async ({ file, start, text }) => {
    const stop = start();
    await sleep(30);
    writeFileSync(file, "arrived ─ ok\n");
    await sleep(60);
    stop();
    assert.equal(text(), "arrived ─ ok\n");
  });
});

test("stop() is idempotent and emits nothing on a second call", async () => {
  await withFollow("idempotent", async ({ file, start, seen, text }) => {
    writeFileSync(file, "one\n");
    const stop = start();
    await sleep(40);
    stop();
    const after = seen.length;
    stop();
    stop();
    assert.equal(seen.length, after);
    assert.equal(text(), "one\n");
  });
});
