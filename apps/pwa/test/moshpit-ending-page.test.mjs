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
  // An alias pointing at torklink, and an ending owned by somebody else: the
  // two sides of "related" and the thing that must not be called related.
  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u2','c@d.e',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('torlink','u1','a@b.c','torklink',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('stranger','u2','c@d.e',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('elsewhere','u2','c@d.e',1)`);
  // `www` twice and `docs` once, so "most-used first" has something to order.
  // Deliberately not under .bare, which has to stay empty for the empty case.
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('stranger','www','u2',NULL,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('elsewhere','www','u2',NULL,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('stranger','docs','u2',NULL,1)`);

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

// ---- the ending as a directory ----
//
// "Nothing lives under .eggs yet" was the whole page for a young ending: true,
// and nothing to do about it. The name page had answered the other two
// questions — what is near this, and what could go here — since it shipped;
// the ending page, which is where somebody actually decides, had neither.

test("an ending lists the endings related to it", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.match(body, /Related endings/);
  // Aliased to it, and owned by the same person: both are related.
  assert.match(body, /href="\/n\/torlink"/);
  assert.match(body, /href="\/n\/bare"/);
});

test("related endings link to the ending, not to a search", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  // There is no label to carry across on an ending's page, so each one goes to
  // its own page — which is a page now, and used to be a 400.
  assert.doesNotMatch(body, /href="\/pit\?tab=theirs/);
});

test("an ending held by somebody else is listed, but not as related", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.match(body, /More endings/);
  const related = body.slice(body.indexOf("Related endings"), body.indexOf("More endings"));
  assert.doesNotMatch(related, /href="\/n\/stranger"/, "a stranger's ending is not related");
  assert.match(body, /href="\/n\/stranger"/);
});

test("an ending never lists itself", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  assert.doesNotMatch(body, /href="\/n\/torklink"/, "the page you are on is not somewhere else to go");
});

test("an empty ending suggests names rather than stopping at 'nothing here'", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/bare");

  assert.match(body, /Nothing lives under \.bare yet/);
  // What the rest of the registry actually took, most-used first.
  assert.match(body, /www\.bare/);
  assert.match(body, /docs\.bare/);
});

test("a suggestion goes to the claim box with the name filled in", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/bare");

  // The same path the "See if it is free" form posts to, so the shortcut and
  // the form cannot disagree about what happens next.
  assert.match(body, /href="\/pit\?name=www\.bare"/);
});

test("a name already taken is never suggested", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/torklink");

  // `parked.torklink` exists; offering it would only ever answer "taken".
  assert.doesNotMatch(body, /href="\/pit\?name=parked\.torklink"/);
  assert.doesNotMatch(body, /href="\/pit\?name=pointed\.torklink"/);
});

test("the registry's own labels outrank the starter list", skip, async () => {
  const { get } = await app();
  const { body } = await get("/n/bare");

  const row = body.slice(body.indexOf("Still free under"), body.indexOf("Related endings"));
  // `www` is taken twice elsewhere and `docs` once, so www comes first — and
  // both beat a starter label nobody has taken.
  assert.ok(row.indexOf("www.bare") < row.indexOf("docs.bare"), row);
  assert.ok(row.indexOf("docs.bare") < row.indexOf("status.bare"), row);
});
