// The Authorization scheme name is case-insensitive (RFC 7235 §2.1), so
// `authorization: bearer <key>` is a valid way to present a moshcode API key.
// These boot the real routers against a throwaway libsql file database and
// check that the API-key endpoints accept the scheme in any casing, while
// still rejecting a wrong key, a missing header, and a different scheme.
//
// They skip cleanly when the PWA dependencies are not installed (a fresh repo
// clone only has the root CLI deps), so the root `npm test` stays green either
// way. Run `npm install` in apps/pwa to enable them.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null; // pwa dependencies not installed — tests below skip
}

// Point the app at a throwaway database BEFORE importing its modules (config
// reads the environment once, at import time).
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { cliRouter } = await import("../src/routes/cli.mjs");
  const { approvalsRouter } = await import("../src/routes/approvals.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(cliRouter);
  app.use(approvalsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  const { plaintext } = await createApiKey("u1", "test");

  // `headers` is passed through verbatim so each test controls the exact
  // scheme casing that goes on the wire.
  const me = (headers) => fetch(`${base}/api/me`, { headers })
    .then(async (res) => ({ status: res.status, body: await res.json() }));
  const ingest = (headers) => fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message: "ship it?", kind: "notify" }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  return { run, get, db, server, key: plaintext, me, ingest };
}

// One shared app/db for the whole file (db.mjs is a module-level singleton —
// closing it between tests would break the next boot).
let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("api/me: the canonical `Bearer` scheme authenticates", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { key, me } = await app();

  const res = await me({ authorization: `Bearer ${key}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, "u1");
});

test("api/me: a lowercase `bearer` scheme authenticates the same key", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { key, me } = await app();

  const res = await me({ authorization: `bearer ${key}` });
  assert.equal(res.status, 200, "RFC 7235 §2.1: the scheme name is case-insensitive");
  assert.equal(res.body.id, "u1");
});

test("api/me: an uppercase `BEARER` scheme authenticates the same key", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { key, me } = await app();

  const res = await me({ authorization: `BEARER ${key}` });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, "u1");
});

test("api/approvals: ingest accepts a lowercase `bearer` scheme", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { key, ingest } = await app();

  const res = await ingest({ authorization: `bearer ${key}` });
  assert.equal(res.status, 201);
  assert.ok(res.body.id, "ingest must create an approval");
});

test("api/me: a wrong key is still rejected in any casing", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { me } = await app();

  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    const res = await me({ authorization: `${scheme} mck_not-a-real-key` });
    assert.equal(res.status, 401, `${scheme} with a bad key must 401`);
  }
});

test("api/me: a missing or non-Bearer Authorization header is rejected", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { key, me } = await app();

  assert.equal((await me({})).status, 401, "no header must 401");
  assert.equal((await me({ authorization: `Basic ${key}` })).status, 401, "a different scheme must 401");
  assert.equal((await me({ authorization: key })).status, 401, "a bare token with no scheme must 401");
  assert.equal((await me({ authorization: `Bearer${key}` })).status, 401, "no space after the scheme must 401");
});
