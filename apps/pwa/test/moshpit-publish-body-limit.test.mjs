// How much a webhook is allowed to publish in one call.
//
// The publishing endpoint documents a ceiling of MAX_BATCH items, and for a
// while that was a promise the server could not keep: body-parser's default
// limit is 100kb, and MAX_BATCH items of the documented size weigh about ten
// times that. A caller sending exactly what the docs described got a rejection
// no field limit in moshpit-content.mjs explained.
//
// Worse, it did not even report as a rejection. The catch-all error handler
// turned body-parser's 413 into the generic 500 HTML page, so "your batch is
// too big" arrived as "a bug got in" and sent people reading server logs.
//
// These tests pin all three halves of the fix: the limit is derived from the
// field limits rather than guessed, a batch far past the old default is
// accepted, and one past the new ceiling is refused as JSON with the status
// body-parser chose.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

import { MAX_BATCH, MAX_BODY, MAX_PUBLISH_BYTES } from "../src/lib/moshpit-content.mjs";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-publish-limit-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

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

  // Wired the way src/server.mjs wires it: the scoped parser first, the global
  // one after. That order is the fix — see the drift guard at the bottom.
  const app = deps.express();
  const captureRaw = (req, _res, buf) => { req.rawBody = buf.toString("utf8"); };
  app.use("/api/moshpit/sites", deps.express.json({ limit: MAX_PUBLISH_BYTES, verify: captureRaw }));
  app.use(deps.express.json({ verify: captureRaw }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = Number(err?.status ?? err?.statusCode) || 500;
    if (status >= 400 && status < 500) {
      const detail = err?.type === "entity.too.large" ? "too large" : "unreadable";
      if (req.path.startsWith("/api/")) return res.status(status).json({ error: detail });
      return res.status(status).type("text").send(`${detail}\n`);
    }
    return res.status(500).type("html").send("<body>500</body>");
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML error page */ }
    return { status: res.status, json, text };
  };

  return { server, db, call };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("publish limit: the ceiling is derived from the field limits, not guessed", () => {
  // The property that matters: a batch of the documented size must fit. If
  // MAX_BODY or MAX_BATCH grows and this is still a hardcoded "2mb", the two
  // drift apart silently and the endpoint starts refusing documented input.
  assert.ok(
    MAX_PUBLISH_BYTES >= MAX_BATCH * MAX_BODY,
    `${MAX_PUBLISH_BYTES} must hold ${MAX_BATCH} bodies of ${MAX_BODY}`,
  );

  // And it must be meaningfully past the 100kb default, or nothing was fixed.
  assert.ok(MAX_PUBLISH_BYTES > 100 * 1024 * 4, "should be well past body-parser's 100kb default");
});

test("publish limit: a batch past the old 100kb default is accepted", skip, async () => {
  const { call } = await app();

  // ~240kb of JSON: comfortably past the old default, comfortably under the
  // new ceiling. This is the request that used to fail.
  const items = Array.from({ length: 20 }, (_, i) => ({
    kind: "text",
    title: `post ${i}`,
    slug: `post-${i}`,
    body: "x".repeat(12_000),
  }));
  const payload = JSON.stringify(items);
  assert.ok(payload.length > 100 * 1024, `fixture must exceed the old default, got ${payload.length}`);
  assert.ok(payload.length < MAX_PUBLISH_BYTES, "fixture must stay under the new ceiling");

  const res = await call("POST", "/api/moshpit/sites/blue.eggs/content", items);
  // 201 when every item was created, 200 on a pure update, 207 when the batch
  // was partly valid. Any of the three means the body was read — which is the
  // thing under test. What must not come back is 413.
  assert.ok(
    [200, 201, 207].includes(res.status),
    `expected a published batch, got ${res.status} ${res.text.slice(0, 200)}`,
  );
  assert.equal(res.json.results.length, 20);
  assert.ok(res.json.results.every((r) => r.ok), "every item in a valid batch should publish");
});

test("publish limit: past the ceiling it is a 413 in JSON, not a 500 in HTML", skip, async () => {
  const { call } = await app();

  // One item whose body alone exceeds the whole-batch ceiling.
  const huge = [{ kind: "text", title: "too much", slug: "too-much", body: "x".repeat(MAX_PUBLISH_BYTES + 1024) }];

  const res = await call("POST", "/api/moshpit/sites/blue.eggs/content", huge);

  // The status body-parser chose, not the catch-all 500 this used to become.
  assert.equal(res.status, 413, `expected 413, got ${res.status}`);
  // JSON, because /api/ is an API. An HTML error page here is unparseable by
  // the scripts this endpoint exists for.
  assert.ok(res.json, `expected a JSON body, got ${res.text.slice(0, 200)}`);
  assert.match(res.json.error, /too large/i);
});

test("publish limit: the scoped parser is mounted before the global one", () => {
  // A drift guard rather than a behaviour test, because the wiring lives in
  // server.mjs and server.mjs listens on import — it cannot be imported here.
  //
  // Order is the whole fix. body-parser skips a request whose body another
  // parser already read, so if the global 100kb parser is mounted first it
  // wins and the scoped limit becomes decorative. That reversal is invisible:
  // every test above still passes, because they wire their own stack.
  const src = fs.readFileSync(path.join(SRC, "server.mjs"), "utf8");

  const scoped = src.indexOf('app.use("/api/moshpit/sites", express.json(');
  const global = src.indexOf("app.use(express.json({ verify: captureRaw }))");

  assert.ok(scoped !== -1, "server.mjs should mount a scoped JSON parser for /api/moshpit/sites");
  assert.ok(global !== -1, "server.mjs should still mount a global JSON parser");
  assert.ok(scoped < global, "the scoped parser must be mounted BEFORE the global one, or its limit never applies");

  // And it must use the derived constant, not a literal that can drift.
  assert.match(src, /limit:\s*MAX_PUBLISH_BYTES/, "the scoped parser should use MAX_PUBLISH_BYTES");
});
