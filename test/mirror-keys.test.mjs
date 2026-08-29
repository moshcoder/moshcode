// Keys pressed on the session page, arriving down the command long-poll.
//
// They travel the same queue as a typed line but must not be treated as one:
// a key is pressed the moment it lands, and it goes to whatever is reading the
// terminal right now — readline at the prompt, a raw-mode UI otherwise.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createMirror, decodeKey, pressKey, KEY_PREFIX, KEY_NAMES } from "../src/mirror.mjs";

const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, "timed out waiting for the mirror");
}

test("decodeKey tells a key from a line", () => {
  for (const name of KEY_NAMES) assert.equal(decodeKey(KEY_PREFIX + name), name);
  assert.equal(decodeKey("/help"), null);
  assert.equal(decodeKey(`${KEY_PREFIX}pgup`), null, "a key we don't know is not a key");
  assert.equal(decodeKey(undefined), null);
});

test("a queued key reaches onKey, and never onCommand", async () => {
  const acked = [];
  let served = false;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/sessions") return json({ id: "session-1" });
    if (pathname === "/api/sessions/session-1/commands") {
      if (served) {
        // One batch, then park: the pump loops forever otherwise.
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      served = true;
      return json({ commands: [
        { id: "c1", body: `${KEY_PREFIX}down` },
        { id: "c2", body: "/ps" },
      ] });
    }
    acked.push(pathname);
    return json({ ok: true });
  };

  const mirror = createMirror({
    credentials: { api: "https://app.example.test", token: "mck_test" },
    fetchImpl,
  });
  const keys = [];
  const lines = [];
  mirror.onKey((name) => keys.push(name));
  mirror.onCommand((body) => lines.push(body));

  assert.equal(await mirror.start(), true);
  await waitFor(() => keys.length > 0 && lines.length > 0);

  assert.deepEqual(keys, ["down"]);
  assert.deepEqual(lines, ["/ps"], "the sentinel must never be handed to the prompt as text");
  // Both are acked, so neither is claimed again by the next poll.
  await waitFor(() => acked.length === 2);
  await mirror.stop();
});

test("at the prompt a key is a readline keypress", () => {
  const seen = [];
  const rl = { write: (data, key) => seen.push({ data, key }) };
  assert.equal(pressKey("up", rl), true);
  assert.equal(pressKey("enter", rl), true);
  assert.deepEqual(seen, [
    { data: null, key: { name: "up" } },
    // Enter is "return" to readline — the name that runs the line.
    { data: null, key: { name: "return" } },
  ]);
});

test("with no prompt a key is the escape sequence a raw-mode UI reads", () => {
  const stdin = new EventEmitter();
  const chunks = [];
  stdin.on("data", (buf) => chunks.push(buf.toString("latin1")));

  for (const name of ["up", "down", "right", "left", "enter"]) {
    assert.equal(pressKey(name, null, stdin), true);
  }
  assert.deepEqual(chunks, ["\u001b[A", "\u001b[B", "\u001b[C", "\u001b[D", "\r"]);
});

test("a key we don't know does nothing at all", () => {
  const stdin = new EventEmitter();
  let wrote = false;
  stdin.on("data", () => { wrote = true; });
  const rl = { write: () => { wrote = true; } };
  assert.equal(pressKey("pgdn", rl, stdin), false);
  assert.equal(pressKey("", null, stdin), false);
  assert.equal(wrote, false);
});

test("a prompt that refuses the keypress falls back to the tty", () => {
  const stdin = new EventEmitter();
  const chunks = [];
  stdin.on("data", (buf) => chunks.push(buf.toString("latin1")));
  // readline throws once it has been closed; the key still has somewhere to go.
  const rl = { write: () => { throw new Error("readline was closed"); } };
  assert.equal(pressKey("up", rl, stdin), true);
  assert.deepEqual(chunks, ["\u001b[A"]);
});
