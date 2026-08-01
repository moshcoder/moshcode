// Whether a crawler can find the network.
//
// `/n/<name>` is the whole point of the pit being on the clearnet: a name
// nobody holds is a page somebody should be able to *find*. Before this there
// was no robots.txt, no sitemap and no canonical — the pages existed and
// nothing advertised them.
//
// Same harness as moshpit-pit-page.test.mjs: the real router against a
// throwaway libsql file, skipped cleanly when the PWA deps are not installed.
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
  deps = { express: require("express") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-crawl-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PUBLIC_ORIGIN = "https://pit.example.test";

const ORIGIN = "https://pit.example.test";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','scrambled','u1',NULL,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','poached','u1',NULL,1)`);

  const app = deps.express();
  app.use((req, _res, next) => { req.csrfToken = () => "csrf"; next(); });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
  };
  return { server, db, get };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("robots.txt invites crawlers to /n/ and points at the sitemap", skip, async () => {
  const { get } = await app();
  const { status, type, body } = await get("/robots.txt");

  assert.equal(status, 200);
  assert.match(type, /text\/plain/);
  assert.match(body, /^User-agent: \*/m);
  assert.match(body, /^Allow: \/n\//m);
  assert.match(body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, "m"));
  // The private half of the app has no business being indexed.
  assert.match(body, /^Disallow: \/api\//m);
});

test("the sitemap lists every registered name, and nothing that 400s", skip, async () => {
  const { get } = await app();
  const { status, type, body } = await get("/sitemap.xml");

  assert.equal(status, 200);
  assert.match(type, /xml/);
  assert.ok(body.includes(`<loc>${ORIGIN}/n/scrambled.eggs</loc>`), body);
  assert.ok(body.includes(`<loc>${ORIGIN}/n/poached.eggs</loc>`), body);
  assert.ok(body.includes(`<loc>${ORIGIN}/pit</loc>`), body);

  // `/n/eggs` is an ending, not a name — it 400s, so it must not be advertised.
  assert.ok(!body.includes(`<loc>${ORIGIN}/n/eggs</loc>`), "an ending is not a name");
});

test("a name's page canonicalises to itself and describes itself", skip, async () => {
  const { get } = await app();
  const { status, body } = await get("/n/scrambled.eggs");

  assert.equal(status, 200);
  assert.ok(body.includes(`<link rel="canonical" href="${ORIGIN}/n/scrambled.eggs">`), body.slice(0, 600));
  assert.match(body, /<meta name="description" content="scrambled\.eggs [^"]+">/);
  assert.ok(body.includes(`<meta property="og:url" content="${ORIGIN}/n/scrambled.eggs">`));
});

test("an unclaimed name still gets indexable head tags", skip, async () => {
  const { get } = await app();
  // Nobody holds `.chicken`, so this name is unregistered — and still a page
  // worth finding, which is the entire pitch.
  const { status, body } = await get("/n/hawaiian.chicken");

  assert.equal(status, 200);
  assert.ok(body.includes(`<link rel="canonical" href="${ORIGIN}/n/hawaiian.chicken">`));
  assert.match(body, /content="hawaiian\.chicken is unclaimed[^"]*"/);
});
