// The streaming publish endpoint, over a real socket.
//
// The parser has its own tests; these are about the contract a client sees.
// Two parts of it can only be checked here: that refusals which happen BEFORE
// the stream opens are ordinary status codes, and that a cap hit AFTER it opens
// arrives as a line in the body — because by then the 200 has already gone out
// and there is no status left to change.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  MAX_CONCURRENT_STREAMS, acquireStreamSlot, resetStreamSlots,
} from "../src/lib/moshpit-publish-stream.mjs";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-stream-route-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','blue','u1',1)`);
  const key = (await createApiKey("u1", "cli one")).plaintext;

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** POST an NDJSON body and collect the parsed response lines. */
  const stream = async (body, { token = key, type = "application/x-ndjson", name = "blue.eggs" } = {}) => {
    const res = await fetch(`${base}/api/moshpit/sites/${encodeURIComponent(name)}/content/stream`, {
      method: "POST",
      headers: { ...(type ? { "content-type": type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    });
    const text = await res.text();
    const messages = text.split("\n").filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return { type: "unparseable", raw: l }; }
    });
    return { status: res.status, headers: res.headers, messages, text };
  };

  return { server, db, stream };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };
const ndjson = (items) => items.map((i) => JSON.stringify(i)).join("\n") + "\n";

test("stream: publishes every item and reports each as it lands", skip, async () => {
  const { stream } = await app();
  const res = await stream(ndjson([
    { kind: "text", title: "One", slug: "s-one", body: "first" },
    { kind: "link", title: "Two", slug: "s-two", url: "https://example.com" },
    { kind: "text", title: "Three", slug: "s-three", body: "third" },
  ]));

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  // Without this nginx buffers the whole response and the progress bar jumps
  // from 0 to 100 on a proxied deploy.
  assert.equal(res.headers.get("x-accel-buffering"), "no");

  assert.equal(res.messages[0].type, "accepted");
  const progress = res.messages.filter((m) => m.type === "progress");
  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map((p) => p.index), [1, 2, 3]);
  assert.ok(progress.every((p) => p.ok), JSON.stringify(progress));

  const done = res.messages.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.created, 3);
  assert.equal(done.failed, 0);
});

test("stream: it upserts, so re-sending the same file updates rather than duplicates", skip, async () => {
  const { stream } = await app();
  const items = [{ kind: "text", title: "Again", slug: "again", body: "v1" }];

  const first = await stream(ndjson(items));
  assert.equal(first.messages.at(-1).created, 1);

  const second = await stream(ndjson([{ ...items[0], body: "v2" }]));
  const done = second.messages.at(-1);
  assert.equal(done.created, 0, "the same slug must not create a second item");
  assert.equal(done.updated, 1);
});

test("stream: one bad line is reported and the rest still publish", skip, async () => {
  const { stream } = await app();
  const body = [
    JSON.stringify({ kind: "text", title: "Good one", slug: "g-1", body: "x" }),
    "{ this is not json",
    JSON.stringify({ kind: "nonsense", title: "Bad kind", slug: "g-2" }),
    JSON.stringify({ kind: "text", title: "Good two", slug: "g-3", body: "x" }),
  ].join("\n") + "\n";

  const res = await stream(body);
  const progress = res.messages.filter((m) => m.type === "progress");
  assert.equal(progress.length, 4);
  assert.equal(progress.filter((p) => p.ok).length, 2);
  assert.equal(progress.filter((p) => !p.ok).length, 2);

  const done = res.messages.at(-1);
  assert.equal(done.type, "done", "a bad line must not abort the stream");
  assert.equal(done.created, 2);
  assert.equal(done.failed, 2);
});

test("stream: refusals before the stream opens are status codes", skip, async () => {
  const { stream } = await app();

  const anon = await stream(ndjson([{ kind: "text", title: "x", slug: "x", body: "x" }]), { token: null });
  assert.equal(anon.status, 401);

  // application/json would already have been buffered by express.json(), so the
  // request stream is drained and the upload would look empty. Refusing the
  // content type is what stops that from being a silent no-op.
  const wrongType = await stream(ndjson([{ kind: "text", title: "x", slug: "x2", body: "x" }]), {
    type: "application/json",
  });
  assert.equal(wrongType.status, 400);

  const noSuchName = await stream(ndjson([{ kind: "text", title: "x", slug: "x3", body: "x" }]), {
    name: "not-a-name",
  });
  assert.equal(noSuchName.status, 400);
});

test("stream: past the item cap it stops mid-stream and says so in the body", skip, async () => {
  const { stream } = await app();
  const { MAX_STREAM_ITEMS } = await import("../src/lib/moshpit-publish-stream.mjs");

  const tooMany = Array.from({ length: MAX_STREAM_ITEMS + 5 }, (_, i) => ({
    kind: "text", title: `Cap ${i}`, slug: `cap-${i}`, body: "x",
  }));

  const res = await stream(ndjson(tooMany));

  // Still a 200: the header went out before the cap was reached, and the items
  // written before it are written. The refusal has to be in-band.
  assert.equal(res.status, 200);
  const last = res.messages.at(-1);
  assert.equal(last.type, "error");
  assert.equal(last.code, "too_many_items");
  assert.equal(res.messages.filter((m) => m.type === "progress").length, MAX_STREAM_ITEMS);
});

test("stream: past the concurrency cap it is 503 with a Retry-After, not a queue", skip, async () => {
  const { stream } = await app();
  resetStreamSlots();
  const held = Array.from({ length: MAX_CONCURRENT_STREAMS }, () => acquireStreamSlot());
  assert.ok(held.every(Boolean));

  try {
    const res = await stream(ndjson([{ kind: "text", title: "busy", slug: "busy", body: "x" }]));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
  } finally {
    held.forEach((release) => release());
    resetStreamSlots();
  }
});
