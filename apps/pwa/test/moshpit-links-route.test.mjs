// The shortener end to end: mint over the API key a terminal holds, follow the
// code, take it down.
//
// Boots the real moshpit router against a throwaway libsql file, because the
// three things worth being sure of here are all things the pure lib cannot see:
// that /f/ actually redirects (and to the right place), that minting the same
// URL twice does not mint a second code, and that a link belongs to the account
// that made it.
//
// Skips cleanly when the PWA dependencies are not installed, the same as the
// other route tests here — a fresh clone only has the root CLI deps.
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
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-links-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PIT_ORIGIN = "https://pit.moshcode.sh";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','d@e.f','two',1)`);
  const mine = (await createApiKey("u1", "test")).plaintext;
  const theirs = (await createApiKey("u2", "test")).plaintext;

  const shorten = (body, key = mine) => fetch(`${base}/api/moshpit/links`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  const list = (key = mine) => fetch(`${base}/api/moshpit/links`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  const remove = (code, key = mine) => fetch(`${base}/api/moshpit/links/${code}`, {
    method: "DELETE",
    headers: key ? { authorization: `Bearer ${key}` } : {},
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  // `redirect: manual` or fetch follows it and the status under test is gone.
  const follow = (code) => fetch(`${base}/f/${code}`, { redirect: "manual" });

  return { run, get, db, server, shorten, list, remove, follow, mine, theirs };
}

// One shared app/db for the whole file (db.mjs is a module-level singleton —
// closing it between tests would break the next boot).
let booted = null;
const app = () => (booted ||= boot());
const skip = !deps && "apps/pwa deps not installed";

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("shorten: an API key mints a code, and /f/<code> follows to the url", { skip }, async () => {
  const { shorten, follow } = await app();

  const minted = await shorten({ url: "https://profullstack.com/blog/a-very-long-post-title" });
  assert.equal(minted.status, 201);
  assert.match(minted.body.code, /^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/);
  assert.equal(minted.body.short, `https://pit.moshcode.sh/f/${minted.body.code}`);

  const res = await follow(minted.body.code);
  assert.equal(res.status, 302, "302, not 301 — a permanent redirect outlives the link");
  assert.equal(res.headers.get("location"), "https://profullstack.com/blog/a-very-long-post-title");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
});

test("shorten: the same url twice is the same code", { skip }, async () => {
  const { shorten } = await app();

  const first = await shorten({ url: "https://example.com/idempotent" });
  const second = await shorten({ url: "https://example.com/idempotent" });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200, "the second is not a creation");
  assert.equal(second.body.created, false);
  assert.equal(second.body.code, first.body.code);
});

test("shorten: following a code counts the hit without blocking the redirect", { skip }, async () => {
  const { shorten, follow, get } = await app();

  const minted = await shorten({ url: "https://example.com/counted" });
  await follow(minted.body.code);
  await follow(minted.body.code);

  // The bump is fire-and-forget, so give the write a moment rather than
  // asserting on a race the redirect deliberately does not wait for.
  let row = null;
  for (let i = 0; i < 20 && (row?.hits ?? 0) < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
    // eslint-disable-next-line no-await-in-loop
    row = await get(`SELECT hits, last_hit_at FROM moshpit_links WHERE code = ?`, [minted.body.code]);
  }
  assert.equal(row.hits, 2);
  assert.ok(row.last_hit_at > 0);
});

test("shorten: a javascript: target never reaches the database", { skip }, async () => {
  const { shorten } = await app();

  const res = await shorten({ url: "javascript:alert(document.cookie)" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /http\(s\) only/);
});

test("shorten: minting needs an account", { skip }, async () => {
  const { shorten } = await app();

  const res = await shorten({ url: "https://example.com/anon" }, null);
  assert.equal(res.status, 401, "an anonymous shortener is an open redirector");
});

test("shorten: a link is only listed and only deletable by the account that minted it", { skip }, async () => {
  const { shorten, list, remove, follow, theirs } = await app();

  const minted = await shorten({ url: "https://example.com/mine-alone" });
  const code = minted.body.code;

  const others = await list(theirs);
  assert.equal(others.status, 200);
  assert.ok(!others.body.links.some((link) => link.code === code), "another account must not see it");

  const refused = await remove(code, theirs);
  assert.equal(refused.status, 403);
  assert.equal((await follow(code)).status, 302, "a refused delete must not have deleted it");

  const deleted = await remove(code);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal((await follow(code)).status, 404, "a deleted code stops resolving");
});

test("shorten: an unknown or malformed code is a 404, not a crash", { skip }, async () => {
  const { follow } = await app();

  assert.equal((await follow("zzzzzzz")).status, 404);
  assert.equal((await follow("not-a-code")).status, 404);
  assert.equal((await follow("%2e%2e%2f")).status, 404);
});

test("shorten: a name you do not hold cannot be attached to a link", { skip }, async () => {
  const { shorten } = await app();

  const res = await shorten({ url: "https://example.com/borrowed", name: "someone.eggs" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not registered|do not own/);
});
