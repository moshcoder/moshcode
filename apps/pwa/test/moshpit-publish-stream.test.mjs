// Streaming publish: the parser and its caps.
//
// The caps are the interesting half. A streaming endpoint is a better DoS
// target than a buffered one — it holds a socket open for as long as the client
// keeps trickling — so each cap here bounds a distinct way of abusing that, and
// each gets a test that actually triggers it rather than asserting the constant
// exists.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MAX_CONCURRENT_STREAMS,
  StreamLimitError,
  acquireStreamSlot,
  activeStreams,
  isStreamContentType,
  ndjsonItems,
  resetStreamSlots,
} from "../src/lib/moshpit-publish-stream.mjs";

/** Collect a whole stream, or the error it ended with. */
async function drain(source, opts) {
  const out = [];
  try {
    for await (const entry of ndjsonItems(source, opts)) out.push(entry);
    return { out, err: null };
  } catch (err) {
    return { out, err };
  }
}

const lines = (...parts) => Readable.from(parts.map((p) => Buffer.from(p, "utf8")));

test.beforeEach(() => resetStreamSlots());

test("ndjson: one object per line, in order", async () => {
  const { out, err } = await drain(lines(
    '{"kind":"text","title":"one"}\n',
    '{"kind":"text","title":"two"}\n',
  ));
  assert.equal(err, null);
  assert.deepEqual(out.map((e) => e.index), [1, 2]);
  assert.deepEqual(out.map((e) => e.item.title), ["one", "two"]);
});

test("ndjson: a line split across chunks is still one item", async () => {
  // The realistic case: TCP does not respect line boundaries. Splitting mid
  // object is exactly what a large upload does on every packet.
  const { out, err } = await drain(lines('{"kind":"text",', '"title":"split"}', "\n"));
  assert.equal(err, null);
  assert.equal(out.length, 1);
  assert.equal(out[0].item.title, "split");
});

test("ndjson: a multi-byte character split across chunks is not corrupted", async () => {
  // "🤘" is four bytes. Decoding each chunk independently would turn a split
  // one into replacement characters and silently publish mojibake.
  const payload = Buffer.from('{"kind":"text","title":"🤘"}\n', "utf8");
  const cut = payload.indexOf(Buffer.from("🤘", "utf8")) + 2;
  const { out, err } = await drain(Readable.from([payload.subarray(0, cut), payload.subarray(cut)]));
  assert.equal(err, null);
  assert.equal(out[0].item.title, "🤘");
});

test("ndjson: a final line without a trailing newline still counts", async () => {
  const { out, err } = await drain(lines('{"kind":"text","title":"last"}'));
  assert.equal(err, null);
  assert.equal(out.length, 1);
  assert.equal(out[0].item.title, "last");
});

test("ndjson: blank lines are skipped, not published as empty items", async () => {
  // A trailing newline is how every well-behaved tool ends a file. Counting it
  // as an item would fail the last line of every upload.
  const { out, err } = await drain(lines('{"kind":"text","title":"one"}\n', "\n", "   \n", "\n"));
  assert.equal(err, null);
  assert.equal(out.length, 1);
});

test("ndjson: a malformed line costs that line, not the stream", async () => {
  const { out, err } = await drain(lines(
    '{"kind":"text","title":"good"}\n',
    "{not json\n",
    '{"kind":"text","title":"also good"}\n',
  ));
  assert.equal(err, null, "one bad line must not discard the good ones");
  assert.equal(out.length, 3);
  assert.ok(out[0].item);
  assert.match(out[1].error, /not valid JSON/);
  assert.ok(out[2].item);
});

test("ndjson: a line that is valid JSON but not an object is reported, not published", async () => {
  const { out } = await drain(lines("[1,2,3]\n", '"a string"\n', "null\n"));
  assert.equal(out.length, 3);
  for (const entry of out) assert.match(entry.error, /must be a JSON object/);
});

test("cap: too many items stops the stream", async () => {
  const many = Array.from({ length: 5 }, (_, i) => `{"kind":"text","title":"${i}"}\n`);
  const { out, err } = await drain(lines(...many), { maxItems: 3 });

  assert.ok(err instanceof StreamLimitError);
  assert.equal(err.code, "too_many_items");
  assert.equal(err.status, 413);
  // The items before the cap were already yielded, and the route has already
  // written them. Partial success is the contract.
  assert.equal(out.length, 3);
});

test("cap: total bytes stops the stream even when every line is small", async () => {
  const { err } = await drain(lines(...Array.from({ length: 40 }, () => '{"kind":"text","title":"x"}\n')), {
    maxBytes: 100,
    maxItems: 10_000,
  });
  assert.ok(err instanceof StreamLimitError);
  assert.equal(err.code, "too_large");
});

test("cap: one unterminated line cannot grow without bound", async () => {
  // The attack the total-bytes cap alone does not stop cleanly: no newline
  // ever, so nothing is ever yielded and the buffer just grows.
  const { err } = await drain(Readable.from([Buffer.from("x".repeat(5000), "utf8")]), {
    maxLineBytes: 1000,
    maxBytes: 10_000_000,
  });
  assert.ok(err instanceof StreamLimitError);
  assert.equal(err.code, "line_too_large");
});

test("cap: an idle client is cut off rather than holding the slot", async () => {
  // A stream that opens and then says nothing — the slowloris shape.
  const stalled = new Readable({ read() { /* deliberately never pushes */ } });
  const { err } = await drain(stalled, { idleMs: 60 });

  assert.ok(err instanceof StreamLimitError, `expected a StreamLimitError, got ${err}`);
  assert.equal(err.code, "idle");
  // 408, not 413: the client was too slow, not too large. Reporting it as a
  // size problem sends them shrinking a payload that was never the issue.
  assert.equal(err.status, 408);
});

test("cap: idle timer resets on data, so a slow but live upload survives", async () => {
  const slow = Readable.from((async function* () {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 40));
      yield Buffer.from(`{"kind":"text","title":"${i}"}\n`, "utf8");
    }
  })());

  // Each gap is under the timeout but the total is well over it. Without the
  // reset this would be killed halfway through a legitimate upload.
  const { out, err } = await drain(slow, { idleMs: 100 });
  assert.equal(err, null);
  assert.equal(out.length, 4);
});

test("slots: bounded, and released slots come back", () => {
  const held = [];
  for (let i = 0; i < MAX_CONCURRENT_STREAMS; i += 1) {
    const release = acquireStreamSlot();
    assert.ok(release, `slot ${i} should be available`);
    held.push(release);
  }
  assert.equal(activeStreams(), MAX_CONCURRENT_STREAMS);
  assert.equal(acquireStreamSlot(), null, "past the cap it must refuse, not queue");

  held.pop()();
  assert.equal(activeStreams(), MAX_CONCURRENT_STREAMS - 1);
  assert.ok(acquireStreamSlot(), "a released slot is reusable");
});

test("slots: releasing twice does not invent a slot", () => {
  // The route releases in a `finally` that can run after an error path already
  // released. Double-decrementing would hand out slots that do not exist and
  // quietly remove the cap.
  const release = acquireStreamSlot();
  assert.equal(activeStreams(), 1);
  release();
  release();
  release();
  assert.equal(activeStreams(), 0);
});

test("content type: only the ndjson spellings, and parameters are ignored", () => {
  assert.ok(isStreamContentType("application/x-ndjson"));
  assert.ok(isStreamContentType("application/x-ndjson; charset=utf-8"));
  assert.ok(isStreamContentType("APPLICATION/NDJSON"));
  assert.ok(isStreamContentType("application/jsonl"));

  // Plain JSON must not reach the streaming path: express.json() has already
  // buffered it, so the request stream is drained and the upload would look
  // empty rather than failing outright.
  assert.equal(isStreamContentType("application/json"), false);
  assert.equal(isStreamContentType(""), false);
  assert.equal(isStreamContentType(undefined), false);
});
