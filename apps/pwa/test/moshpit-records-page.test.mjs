// The DNS Records tab, and the API underneath it.
//
// The router against a throwaway libSQL file, same harness as
// moshpit-pit-page.test.mjs. What is worth checking over HTTP rather than
// against the module is the part the module cannot see: that the page draws the
// names you hold and not anyone else's, that the filter narrows it, that a
// bounded page says what it is not showing, and that the forms land back where
// you were with something readable to look at.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try { deps = { express: require("express") }; } catch { deps = null; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-records-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const V6 = "2606:4700:4700::1111";
const NAMES = 30;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);

  const at = 1_700_000_000_000;
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('eggs','u1','a@b.c',null,?)`, [at]);
  for (let i = 0; i < NAMES; i++) {
    await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs',?,'u1',null,?)`,
      [`name${String(i).padStart(2, "0")}`, at]);
  }
  // Somebody else's name, under an ending they hold. Nothing about it belongs
  // on u1's page.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES ('theirs','u2','x@y.z',null,?)`, [at]);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('theirs','secret','u2',null,?)`, [at]);

  const app = deps.express();
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.express.json());
  app.use((req, _res, next) => { req.csrfToken = () => "csrf"; req.user = { id: "u1", email: "a@b.c" }; next(); });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = async (p) => {
    const res = await fetch(`${base}${p}`);
    return { status: res.status, html: await res.text() };
  };
  const json = async (p, init) => {
    const res = await fetch(`${base}${p}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  // A form post, followed only as far as the redirect it answers with.
  const post = async (p, fields) => {
    const res = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };
  return { server, db, get, json, post };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

/** The names drawn as a card heading on the records page. */
const cards = (html) => [...html.matchAll(/<h3 class="acid">([a-z0-9.]+)<\/h3>/g)].map((m) => m[1]);
const elements = (html) => (html.match(/<[a-z]/g) || []).length;
/**
 * The records, without the copy-paste API examples underneath them.
 *
 * Those examples contain `mx.example.com` and an address, so asserting over the
 * whole page would find a record the page is only documenting how to add.
 */
const panel = (html) => html.split("publish records from a script")[0];
/** What `location:` came back with, as params. */
const params = (location) => new URLSearchParams(location.split("?")[1] ?? "");

test("records: the tab lists the names you hold, and only those", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/pit/records");
  assert.equal(status, 200);

  assert.ok(cards(html).length > 0, "drew no names at all");
  assert.ok(cards(html).every((n) => n.endsWith(".eggs")), "drew a name from another account");
  assert.doesNotMatch(html, /secret\.theirs/, "drew somebody else's name");
});

test("records: the strip carries a DNS Records tab, and it is the one showing", skip, async () => {
  const { get } = await app();
  const { html } = await get("/pit/records");
  assert.match(html, /class="pit-tab on"[^>]*>DNS Records/);
  // And the other tabs are still reachable from it.
  assert.match(html, /href="\/pit\?tab=yours/);
  assert.match(html, /href="\/pit\/dns"/);

  const pit = await get("/pit");
  assert.match(pit.html, /href="\/pit\/records[^"]*"[^>]*>DNS Records/, "/pit does not link to the new tab");
});

test("records: the page is bounded and says what it is not showing", skip, async () => {
  const { get } = await app();
  const { html } = await get("/pit/records");

  // 30 names, 25 to a page: the pager is the honest part.
  assert.ok(cards(html).length <= 25, `drew ${cards(html).length} names`);
  assert.match(html, /page 1 of 2/);
  assert.ok(elements(html) < 4000, `page drew ${elements(html)} elements`);

  const two = await get("/pit/records?page=2");
  assert.equal(cards(two.html).length, 5, "the second page did not hold the rest");
});

test("records: filtering narrows to a domain, an ending or a prefix", skip, async () => {
  const { get } = await app();

  const exact = await get("/pit/records?q=name07.eggs");
  assert.deepEqual(cards(exact.html), ["name07.eggs"]);

  const prefix = await get("/pit/records?q=name1*");
  assert.equal(cards(prefix.html).length, 10, "name10..name19");

  const none = await get("/pit/records?q=zzzznothing");
  assert.equal(cards(none.html).length, 0);
  assert.match(none.html, /No name of yours matches/);
});

test("records: publishing one from the form puts it on the page", skip, async () => {
  const { get, post } = await app();

  const added = await post("/pit/records", { name: "name00.eggs", type: "AAAA", value: V6, ttl: "300" });
  assert.equal(added.status, 302);
  assert.match(params(added.location).get("ok") ?? "", /name00\.eggs/);

  const html = panel((await get("/pit/records?q=name00.eggs")).html);
  assert.ok(html.includes(V6), "the record is not on the page");
  assert.match(html, /1 record\b/, "the count did not move");
  // And the name now resolves to it, which is the point of adding it.
  assert.match(html, /resolves to/);
});

test("records: a rejected record explains itself and keeps you where you were", skip, async () => {
  const { post } = await app();

  const refused = await post("/pit/records", { name: "name00.eggs", type: "AAAA", value: "203.0.113.9", q: "name0*", page: "1" });
  assert.equal(refused.status, 302);
  const back = params(refused.location);
  assert.match(back.get("err") ?? "", /IPv4/);
  assert.equal(back.get("q"), "name0*", "the filter was dropped on the way back");
});

test("records: a form post cannot publish under somebody else's name", skip, async () => {
  const { post, json } = await app();

  const refused = await post("/pit/records", { name: "secret.theirs", type: "TXT", value: "mine now" });
  assert.match(params(refused.location).get("err") ?? "", /do not own/);

  const after = await json("/api/moshpit/tlds/theirs/records?label=secret");
  assert.deepEqual(after.body.records, []);
});

test("records: withdrawing one takes it off the page", skip, async () => {
  const { get, post } = await app();

  await post("/pit/records", { name: "name01.eggs", type: "MX", value: "mx.example.com", priority: "10" });
  const before = panel((await get("/pit/records?q=name01.eggs")).html);
  assert.match(before, /mx\.example\.com/);

  const gone = await post("/pit/records/delete", { name: "name01.eggs", type: "MX", value: "mx.example.com" });
  assert.equal(gone.status, 302);
  const after = panel((await get("/pit/records?q=name01.eggs")).html);
  assert.doesNotMatch(after, /mx\.example\.com/);
  assert.match(after, /No records yet/);
});

test("records: the API publishes, reads back and withdraws", skip, async () => {
  const { json } = await app();
  const body = (o) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

  const added = await json("/api/moshpit/tlds/eggs/records", body({ label: "name02", type: "TXT", value: "v=spf1 -all" }));
  assert.equal(added.status, 201);
  assert.equal(added.body.record.type, "TXT");

  // Public: no key, because a record is published for strangers to act on.
  const read = await json("/api/moshpit/records?name=name02.eggs");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.records, [{ type: "TXT", value: "v=spf1 -all", ttl: 300 }]);
  assert.deepEqual(read.body.zone, ['name02.eggs.\t300\tIN\tTXT\t"v=spf1 -all"']);

  const removed = await json("/api/moshpit/tlds/eggs/records", {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "name02", type: "TXT", value: "v=spf1 -all" }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await json("/api/moshpit/records?name=name02.eggs")).status, 404);
});

test("records: a CNAME beside other records is a conflict, not a bad request", skip, async () => {
  const { json } = await app();
  const body = (o) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

  await json("/api/moshpit/tlds/eggs/records", body({ label: "name03", type: "AAAA", value: V6 }));
  const clash = await json("/api/moshpit/tlds/eggs/records", body({ label: "name03", type: "CNAME", value: "box.example.com" }));

  // The request was well formed; the state refused it. A 400 would send a
  // script off to fix input that has nothing wrong with it.
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /CNAME/);
});

test("records: resolve stays cheap unless the caller asks for the set", skip, async () => {
  const { json } = await app();

  const plain = await json("/api/moshpit/resolve?name=name00.eggs");
  assert.equal(plain.status, 200);
  assert.equal(plain.body.records, undefined, "every DNS query would pay for a lookup it did not ask for");
  assert.equal(plain.body.target, V6, "an old resolver still gets an address");

  const full = await json("/api/moshpit/resolve?name=name00.eggs&records=1");
  assert.deepEqual(full.body.records, [{ type: "AAAA", value: V6, ttl: 300 }]);
});
