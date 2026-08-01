// Typing a whole name into the claim box.
//
// The box was built for an ending (`eggs`) and reached registerTlds(), which
// rejects a dotted token — so `scrambled.eggs`, the thing people actually want,
// came back as "not a valid TLD". Holding a name is really two steps, and the
// form should do both rather than teaching the order to the visitor.
//
// Same harness as moshpit-pit-page.test.mjs: the real router against a
// throwaway libsql file, skipped cleanly when the PWA deps are not installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-claim-name-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ME = "u1";
const THEM = "u2";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const m = await import("../src/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id,email,display_name,created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id,email,display_name,created_at) VALUES ('u2','x@y.z','two',1)`);

  const app = deps.express();
  app.use(deps.express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.csrfToken = () => "csrf";
    req.user = { id: ME, email: "a@b.c" };
    next();
  });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** POST the claim form and hand back where it sent us, without following. */
  const claim = async (tld) => {
    const res = await fetch(`${base}/pit/claim`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tld }),
      redirect: "manual",
    });
    return { status: res.status, location: res.headers.get("location") || "" };
  };

  return { server, db, m, claim };
}

let booted = null;
const app = () => (booted ||= boot());
const uniq = () => `t${randomBytes(4).toString("hex")}`;

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("claim: a whole name under a free ending takes both", skip, async () => {
  const { claim, m } = await app();
  const tld = uniq();

  const { location } = await claim(`scrambled.${tld}`);

  // The flash names what they asked for, not the ending it had to take first.
  assert.match(location, /^\/pit\?/);
  const q = new URLSearchParams(location.slice("/pit?".length));
  assert.equal(q.get("ok"), `scrambled.${tld} is yours.`);
  assert.equal(q.get("tab"), "yours");

  assert.equal((await m.getTld(tld))?.user_id, ME, "the ending is claimed");
  assert.equal((await m.getName(tld, "scrambled"))?.user_id, ME, "the name is minted");
});

test("claim: a name under an ending you already hold just mints", skip, async () => {
  const { claim, m } = await app();
  const tld = uniq();
  await m.registerTld({ tld, userId: ME });

  const { location } = await claim(`poached.${tld}`);

  const q = new URLSearchParams(location.slice("/pit?".length));
  assert.equal(q.get("ok"), `poached.${tld} is yours.`);
  assert.equal((await m.getName(tld, "poached"))?.user_id, ME);
});

test("claim: someone else's ending goes to the card, and takes nothing", skip, async () => {
  const { claim, m } = await app();
  const tld = uniq();
  await m.registerTld({ tld, userId: THEM });

  const { location } = await claim(`fried.${tld}`);

  // landingFor() already decides whether that name is for sale, taken, or
  // simply unlisted — this must not answer that question a second time.
  assert.equal(location, `/pit?name=${encodeURIComponent(`fried.${tld}`)}`);
  assert.equal((await m.getTld(tld)).user_id, THEM, "not stolen");
  assert.equal(await m.getName(tld, "fried"), null, "no name minted under someone else's ending");
});

test("claim: a bare ending still behaves exactly as before", skip, async () => {
  const { claim, m } = await app();
  const tld = uniq();

  const { location } = await claim(tld);

  const q = new URLSearchParams(location.slice("/pit?".length));
  assert.ok(q.get("ok"), `expected a success flash, got ${location}`);
  assert.equal((await m.getTld(tld))?.user_id, ME);
  assert.deepEqual(await m.listNames(tld), [], "an ending on its own mints no names");
});

test("claim: a dotted token that is not a name is still refused", skip, async () => {
  const { claim } = await app();

  // Three labels is not a Moshpit name, so it must not silently become one.
  const { location } = await claim("a.b.c");
  const q = new URLSearchParams(location.slice("/pit?".length));
  assert.ok(q.get("err"), `expected a refusal, got ${location}`);
});
