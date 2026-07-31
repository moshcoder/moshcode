import assert from "node:assert/strict";
import test from "node:test";

import { createMirror } from "../src/mirror.mjs";

const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

// Terminal geometry rides along with every post, but only when there is a tty
// to measure — under the test runner there isn't. Compare the envelope alone so
// these tests say the same thing whether or not stdout happens to be a terminal.
const envelope = ({ chunk, engine }) => ({ chunk, engine });

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true, "timed out waiting for the mirror request");
}

test("setEngine sends an engine-only update to the session mirror", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/sessions") return json({ id: "session-1" });
    if (pathname.endsWith("/commands")) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    requests.push({ pathname, body: JSON.parse(options.body) });
    return json({ ok: true });
  };
  const mirror = createMirror({
    credentials: { api: "https://app.example.test", token: "mck_test" },
    fetchImpl,
  });

  assert.equal(await mirror.start(), true);
  mirror.setEngine("claude");
  await waitFor(() => requests.some((request) => request.pathname.endsWith("/output")));

  assert.deepEqual(
    envelope(requests.find((request) => request.pathname.endsWith("/output"))?.body),
    { chunk: "", engine: "claude" },
  );

  mirror.setEngine(null);
  await waitFor(() => requests.filter((request) => request.pathname.endsWith("/output")).length === 2);
  assert.deepEqual(
    requests.filter((request) => request.pathname.endsWith("/output")).map((request) => envelope(request.body)),
    [
      { chunk: "", engine: "claude" },
      { chunk: "", engine: null },
    ],
  );
  await mirror.stop();
});

test("the mirror reports terminal geometry, and sends none when there is no tty", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/sessions") { requests.push({ pathname, body: JSON.parse(options.body) }); return json({ id: "session-1" }); }
    if (pathname.endsWith("/commands")) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    requests.push({ pathname, body: JSON.parse(options.body) });
    return json({ ok: true });
  };
  const start = async () => {
    const mirror = createMirror({
      credentials: { api: "https://app.example.test", token: "mck_test" },
      fetchImpl,
    });
    assert.equal(await mirror.start(), true);
    return mirror;
  };

  // Pretend stdout is a 132×40 terminal. The page runs the emulator at exactly
  // this size, so it has to arrive with the very first post — a browser that
  // opens before the first resize would otherwise render at the wrong width.
  const original = { columns: process.stdout.columns, rows: process.stdout.rows };
  process.stdout.columns = 132;
  process.stdout.rows = 40;
  try {
    const mirror = await start();
    mirror.write("hello\n");
    await waitFor(() => requests.some((request) => request.pathname.endsWith("/output")));
    const register = requests.find((request) => request.pathname === "/api/sessions").body;
    assert.equal(register.cols, 132);
    assert.equal(register.rows, 40);
    const output = requests.find((request) => request.pathname.endsWith("/output")).body;
    assert.equal(output.cols, 132);
    assert.equal(output.rows, 40);
    await mirror.stop();
  } finally {
    process.stdout.columns = original.columns;
    process.stdout.rows = original.rows;
  }

  // Piped output has no geometry. Sending nulls would be worse than sending
  // nothing: the app would have to tell "unknown" apart from "unchanged".
  requests.length = 0;
  delete process.stdout.columns;
  delete process.stdout.rows;
  const piped = await start();
  piped.write("hello\n");
  await waitFor(() => requests.some((request) => request.pathname.endsWith("/output")));
  for (const request of requests) {
    assert.equal("cols" in request.body, false, `${request.pathname} must not carry cols`);
    assert.equal("rows" in request.body, false, `${request.pathname} must not carry rows`);
  }
  await piped.stop();
});
