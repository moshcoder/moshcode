import { test } from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { createPasteJoiner, oneLine } from "../src/c0agent-paste.mjs";

// The REPL's wiring, against a fake terminal: keypress listener prepended
// before readline's, `line` events run through the joiner.
function session() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on("data", () => {});
  readline.emitKeypressEvents(input);
  const paste = createPasteJoiner();
  input.prependListener("keypress", (_s, key) => paste.key(key?.name));
  const rl = readline.createInterface({ input, output, terminal: true });
  const sent = [];
  rl.on("line", (raw) => { const t = paste.line(raw); if (t !== null) sent.push(t); });
  const tick = () => new Promise((r) => setImmediate(r));
  return { input, rl, sent, paste, tick };
}

test("a pasted block is one message, sent by the next Enter", async () => {
  const s = session();
  s.input.write("\x1b[200~1. one\n2. two\n3. three\x1b[201~");
  await s.tick();
  assert.deepEqual(s.sent, []);
  assert.equal(s.paste.held, 2);
  s.input.write(" and more\r");
  await s.tick();
  assert.deepEqual(s.sent, ["1. one\n2. two\n3. three and more"]);
  s.rl.close();
});

test("a paste ending in a newline still waits for Enter, without a trailing blank", async () => {
  const s = session();
  s.input.write("\x1b[200~a\nb\n\x1b[201~");
  await s.tick();
  assert.deepEqual(s.sent, []);
  s.input.write("\r");
  await s.tick();
  assert.deepEqual(s.sent, ["a\nb"]);
  s.rl.close();
});

test("typed lines still send one at a time", async () => {
  const s = session();
  s.input.write("hello\r");
  s.input.write("again\r");
  await s.tick();
  assert.deepEqual(s.sent, ["hello", "again"]);
  s.rl.close();
});

test("clear drops a held paste", () => {
  const p = createPasteJoiner();
  p.key("paste-start");
  assert.equal(p.line("x"), null);
  p.clear();
  assert.equal(p.line("y"), "y");
});

test("oneLine collapses a multi-line echo", () => {
  assert.equal(oneLine("short"), "short");
  assert.equal(oneLine("a\nb\nc"), "a (+2 lines)");
  assert.equal(oneLine("abcdef\nz", 3), "abc… (+1 line)");
});
