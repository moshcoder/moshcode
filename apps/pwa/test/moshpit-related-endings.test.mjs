// Where "Related endings" sends you.
//
// /n/<name> is the page for a name nobody has pointed anywhere yet, and its
// whole job is to answer "then where else could this live". It listed related
// endings as links into /pit?tab=theirs&q=<ending> — the operator's listing,
// with the name you actually typed dropped on the floor.
//
// The ending is the only part being offered as an alternative, so the label
// rides along: from scrambled.eggs, `.yolks` is /n/scrambled.yolks.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-related-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PUBLIC_ORIGIN = "https://app.example.test";
process.env.PIT_ORIGIN = "https://pit.example.test";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','u1','a@b.c',1)`);
  // An alias is an explicit statement that two endings belong together; shared
  // ownership is the weaker signal. Both land in "Related endings".
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('yolks','u1','a@b.c','eggs',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('omelette','u1','a@b.c',1)`);
  // A numeric ending, for the one combination that cannot be a name.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('187','u1','a@b.c',1)`);

  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','scrambled','u1',NULL,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','420','u1',NULL,1)`);

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

test("a related ending carries the name you are reading", skip, async () => {
  const { get } = await app();
  const res = await get("/n/scrambled.eggs");
  assert.equal(res.status, 200);

  assert.ok(res.body.includes('href="/n/scrambled.yolks"'), "the alias keeps the label");
  assert.ok(res.body.includes('href="/n/scrambled.omelette"'), "so does the co-owned ending");
});

test("it no longer detours through the operator's listing", skip, async () => {
  const { get } = await app();
  const res = await get("/n/scrambled.eggs");

  // The old destination, which answered a different question than the one the
  // visitor asked by typing a name.
  assert.ok(!res.body.includes("q=yolks"), "no /pit listing link for a joinable ending");
  assert.ok(!res.body.includes("q=omelette"));
});

test("names under this ending still link into /n/", skip, async () => {
  const { get } = await app();
  const res = await get("/n/scrambled.eggs");
  assert.ok(res.body.includes('href="/n/420.eggs"'), "the rest of the ending is unchanged");
});

test("every ending goes to /n/, with no exception", skip, async () => {
  const { get } = await app();
  // `420.187` is both halves numeric, which parseMoshpitName refuses as an
  // IPv4 literal — so this link answers 400. That is the deliberate choice:
  // one ending slipping out of the namespace into a search page is a worse
  // inconsistency than a link that says plainly it is not a name.
  const res = await get("/n/420.eggs");
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('href="/n/420.187"'), "no ending leaves /n/");
  assert.ok(res.body.includes('href="/n/420.yolks"'));
  assert.ok(!res.body.includes("q=187"), "the listing fallback is gone");
});

test("no related ending falls back to the pit listing", skip, async () => {
  const { get } = await app();
  const res = await get("/n/scrambled.eggs");
  assert.ok(!res.body.includes("tab=theirs"), "every related ending is a /n/ link");
});
