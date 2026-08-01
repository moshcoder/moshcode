// `/n/<ending>` — an ending, not a name.
//
// `/n/torklink` and `/n/.torklink` both answered "not a Moshpit name", which is
// true of the string and useless about the registry: `.torklink` is one of
// thousands of endings somebody holds, with names under it. The dead end was
// also why the sitemap could not list endings.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-ending-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PUBLIC_ORIGIN = "https://app.example.test";
process.env.PIT_ORIGIN = "https://pit.example.test";

const PIT = "https://pit.example.test";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u1','a@b.c',1)`);
  // An ending somebody holds, with a price and names under it.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,price_usd,created_at) VALUES ('torklink','u1','a@b.c',5,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('torklink','pointed','u1','203.0.113.9',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('torklink','parked','u1',NULL,1)`);
  // An ending held with nothing under it, to prove the empty case reads right.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('bare','u1','a@b.c',1)`);
  // .seo points at .rank — the relationship an ending's page has to show.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('rank','u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('seo','u1','a@b.c','rank',1)`);
  // Somebody else's ending, so "related" cannot just mean "every ending".
  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u2','x@y.z',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('theirs','u2','x@y.z',1)`);

  const app = deps.express();
  app.use((req, _res, next) => { req.csrfToken = () => "csrf"; next(); });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, body: await res.text() };
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

test("an ending gets a page instead of \"not a Moshpit name\"", skip, async () => {
  const { get } = await app();
  const { status, body } = await get("/n/torklink");

  assert.equal(status, 200);
  assert.doesNotMatch(body, /not a Moshpit name/);
  assert.match(body, /<h1 class="acid">\.torklink<\/h1>/);
});

test("a leading dot is how people write endings, and is accepted", skip, async () => {
  const { get } = await app();
  const { status, body } = await get("/n/.torklink");

  assert.equal(status, 200);
  assert.match(body, /<h1 class="acid">\.torklink<\/h1>/);
});

test("the page lists what lives under the ending, split by whether it points anywhere", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.match(body, /href="\/n\/pointed\.torklink"/);
  assert.match(body, /203\.0\.113\.9/);
  assert.match(body, /href="\/n\/parked\.torklink"/);
  assert.match(body, /Claimed, not pointed anywhere/);
});

test("the price is shown, because it is what a visitor can act on", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.match(body, /\$5/);
  // And a box to pick a name under it, rather than a dead end.
  assert.match(body, /placeholder="yourname\.torklink"/);
});

test("an ending with nothing under it says so", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/bare");

  assert.match(body, /Nothing lives under \.bare yet/);
  // Not for sale → no buy box promising something quoteName would refuse.
  assert.doesNotMatch(body, /placeholder="yourname\.bare"/);
});

test("the ending page canonicalises to the pit host", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.ok(body.includes(`<link rel="canonical" href="${PIT}/n/torklink">`), body.slice(0, 700));
  assert.ok(!body.includes("app.example.test"), "the app host is the duplicate, not the original");
});

test("an ending nobody holds is still not a page", skip, async () => {
  const { get } = await app();
  const { status, body } = await get("/n/nobodyholdsthis");

  // Otherwise every typo under /n/ becomes an indexable page.
  assert.equal(status, 400);
  assert.match(body, /not a Moshpit name/);
});

test("a real name still resolves as a name, not an ending", skip, async () => {
  const { get } = await app();
  // The parked one: a pointed name proxies to its target, which is a different
  // path and would 502 against an address nothing is listening on.
  const { status, body } = await get("/n/parked.torklink");

  assert.equal(status, 200);
  assert.match(body, /parked\.torklink/);
  assert.doesNotMatch(body, /<h1 class="acid">\.torklink<\/h1>/, "this is the name's page");
});

test("the sitemap now lists endings as well as names", skip, async () => {
  const { get } = await app();
  const { body } = await get("/sitemap.xml");

  assert.ok(body.includes(`<loc>${PIT}/n/torklink</loc>`), "endings resolve now, so advertise them");
  assert.ok(body.includes(`<loc>${PIT}/n/pointed.torklink</loc>`));
});

test("an ending shows what points at it", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/rank");

  // `.seo → .rank` is a real relationship and was invisible from either side.
  assert.match(body, /Pointed here by/);
  assert.match(body, /href="\/n\/seo"/);
});

test("an ending shows where it points", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/seo");

  assert.match(body, /href="\/n\/rank"/);
  assert.match(body, /names here resolve under that ending/);
});

test("related endings are the owner's others, not the whole namespace", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/rank");

  assert.match(body, /Related endings/);
  assert.match(body, /href="\/n\/torklink"/, "same owner");
  assert.doesNotMatch(body, /href="\/n\/theirs"/, "somebody else's ending is not related");
});

test("an ending is not listed as related to itself, nor twice", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/rank");

  const selfLinks = (body.match(/href="\/n\/rank"/g) || []).length;
  assert.equal(selfLinks, 0, "the page you are on is not a link to itself");
  // .seo is already named as a pointer; it must not repeat under Related.
  const seoLinks = (body.match(/href="\/n\/seo"/g) || []).length;
  assert.equal(seoLinks, 1, "shown once, as a pointer");
});

test("the page states the public facts about the ending", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.match(body, /2 names/);
  assert.match(body, /1 pointed somewhere/);
  assert.match(body, /\$5 a name/);
  assert.match(body, /claimed \d{4}-\d{2}-\d{2}/);
});

test("an ending nobody sells says so rather than showing a price", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/bare");

  assert.match(body, /0 names/);
  assert.match(body, /not for sale/);
});

test("owner email is never put on a page built to be crawled", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  // The registry API exposes it; that is not a reason to make it indexable.
  assert.doesNotMatch(body, /a@b\.c/);
});

test("the pointer count reads as English at one and at many", skip, async () => {
  const { get } = await app();

  // .rank has exactly one ending pointing at it, which read "1 ending point
  // here" — the noun was pluralised and the verb was not.
  assert.match((await get("/n/rank")).body, /1 ending points here/);

  // A second pointer flips both halves.
  const { run } = await import("../src/db.mjs");
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('serp','u1','a@b.c','rank',1)`);
  assert.match((await get("/n/rank")).body, /2 endings point here/);
});
