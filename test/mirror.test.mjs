import assert from "node:assert/strict";
import test from "node:test";

import { createMirror } from "../src/mirror.mjs";

const json = (body) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

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
    requests.find((request) => request.pathname.endsWith("/output"))?.body,
    { chunk: "", engine: "claude" },
  );

  mirror.setEngine(null);
  await waitFor(() => requests.filter((request) => request.pathname.endsWith("/output")).length === 2);
  assert.deepEqual(
    requests.filter((request) => request.pathname.endsWith("/output")).map((request) => request.body),
    [
      { chunk: "", engine: "claude" },
      { chunk: "", engine: null },
    ],
  );
  await mirror.stop();
});
