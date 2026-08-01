// What somebody typed, and what the namespace does with it.
//
// The parser is unit-tested on its own because three callers depend on it
// agreeing with itself: the live filter, the JSON API behind it, and the plain
// `?q=` page load for when the script never ran.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import { MAX_QUERY, tldQuery } from "../src/lib/moshpit-search.mjs";

test("search: a bare word matches anywhere in the name", () => {
  const q = tldQuery("eggs");
  assert.equal(q.like, "%eggs%");
  assert.equal(q.glob, false);
  // Anchoring would mean nothing matches until the last letter lands, which is
  // not what a filter box is for.
  assert.equal(q.exact, "eggs");
});

test("search: a star is a glob, anchored at both ends", () => {
  const q = tldQuery("def*");
  assert.equal(q.like, "def%");
  assert.equal(q.glob, true);
  // No exact hit to promote: a glob is already a shape, not a name.
  assert.equal(q.exact, "");
});

test("search: the leading dot people type is not part of the name", () => {
  assert.equal(tldQuery(".eggs").query, "eggs");
  assert.equal(tldQuery(".def*").like, "def%");
});

test("search: a run of stars asks the same question as one", () => {
  assert.equal(tldQuery("de**f").like, "de%f");
  assert.equal(tldQuery("de*f").like, "de%f");
});

test("search: nothing to filter on is no filter, not an empty result", () => {
  for (const raw of ["", "   ", null, undefined, ".", "***", "!!!"]) {
    assert.equal(tldQuery(raw), null, JSON.stringify(raw));
  }
});

test("search: LIKE wildcards cannot be smuggled in", () => {
  // % and _ mean something to LIKE and nothing in a TLD, so they are stripped
  // before the pattern is built rather than escaped after.
  assert.equal(tldQuery("100%").like, "%100%");
  assert.equal(tldQuery("a_b").like, "%ab%");
  assert.equal(tldQuery("a\\b").like, "%ab%");
});

test("search: a query cannot be longer than the name it is looking for", () => {
  const q = tldQuery("x".repeat(500));
  assert.equal(q.query.length, MAX_QUERY);
});

/* ---------- against the registry ---------- */

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pit-search-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);

  const mine = ["eggs", "eggsalad", "default", "defer", "undef", "yeah"];
  for (const tld of mine) {
    await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES (?,?,?,?)`, [tld, "u1", "a@b.c", 1]);
  }
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','blue','u1',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','green','u1',1)`);
  // Somebody else's, priced, and matching the same queries.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,price_usd,created_at) VALUES ('defcon','u2','x@y.z',4,1)`);

  const app = deps.express();
  app.use((req, _res, next) => {
    if (req.headers["x-test-user"]) req.user = { id: req.headers["x-test-user"], email: "a@b.c" };
    req.csrfToken = () => "csrf";
    next();
  });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (user) => async (p) => {
    const res = await fetch(`${base}${p}`, { headers: user ? { "x-test-user": user } : {} });
    const body = await res.text();
    return { status: res.status, body, json: () => JSON.parse(body) };
  };
  return { server, db, one: as("u1"), anon: as(null) };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };
const names = (payload) => payload.tlds.map((t) => t.tld);

test("api: a substring finds every ending carrying it", skip, async () => {
  const { one } = await app();
  const res = await one("/api/moshpit/tlds?q=eggs&scope=mine");
  assert.equal(res.status, 200);
  // Exact hit first, then shortest — not alphabetical, which would bury `.eggs`.
  assert.deepEqual(names(res.json()), ["eggs", "eggsalad"]);
});

test("api: a glob is anchored, so undef is not a def*", skip, async () => {
  const { one } = await app();
  const res = await one("/api/moshpit/tlds?q=def*&scope=mine");
  const found = names(res.json());
  assert.deepEqual(found.sort(), ["default", "defer"]);
  assert.ok(!found.includes("undef"), "undef does not start with def");
});

test("api: scope decides whose endings come back", skip, async () => {
  const { one } = await app();
  assert.ok(!names((await one("/api/moshpit/tlds?q=def*&scope=mine")).json()).includes("defcon"));
  assert.deepEqual(names((await one("/api/moshpit/tlds?q=def*&scope=theirs")).json()), ["defcon"]);
});

test("api: results carry what a row needs to render itself", skip, async () => {
  const { one } = await app();
  const [eggs] = (await one("/api/moshpit/tlds?q=eggs&scope=mine")).json().tlds;
  assert.equal(eggs.name_count, 2, "the count comes back on the row, not a query per row");
  assert.equal(eggs.mine, true);

  const [defcon] = (await one("/api/moshpit/tlds?q=defcon&scope=theirs")).json().tlds;
  assert.equal(defcon.price_usd, 4);
  assert.equal(defcon.mine, false);
});

test("api: filtering the public registry needs no session", skip, async () => {
  const { anon } = await app();
  const res = await anon("/api/moshpit/tlds?q=def*");
  assert.equal(res.status, 200);
  assert.ok(names(res.json()).includes("defcon"));
});

test("api: yours still needs a session", skip, async () => {
  const { anon } = await app();
  assert.equal((await anon("/api/moshpit/tlds?q=eggs&scope=mine")).status, 401);
});

test("api: no query is the whole list, exactly as before", skip, async () => {
  const { anon } = await app();
  const body = (await anon("/api/moshpit/tlds")).json();
  assert.ok(body.tlds.length >= 7, "unfiltered response is unchanged");
  assert.equal(body.query, undefined, "and carries no filter metadata");
});

test("pit: ?q= filters the page itself, for when the script never ran", skip, async () => {
  const { one } = await app();
  const { status, body } = await one("/pit?q=def*");
  assert.equal(status, 200);

  const drawn = [...body.matchAll(/<h3 class="acid">\.([a-z0-9]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(drawn.sort(), ["default", "defer"]);
  assert.match(body, /value="def\*"/, "the box holds what was filtered on");
});

test("pit: the filter survives paging and tab switches", skip, async () => {
  const { one } = await app();
  const { body } = await one("/pit?q=eggs");
  assert.match(body, /href="\/pit\?tab=theirs&q=eggs"/, "switching tabs keeps the query");
});
