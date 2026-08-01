// What /pit is allowed to draw.
//
// The page ships no script and still locked browsers up: it rendered every
// ending the account held, and under each one a form per name, with no bound on
// either. At 50 endings x 100 names that was 3 MiB of HTML and 36k elements —
// enough to jam scrolling on its own, before the sticky blurred app bar
// repainted over it every frame.
//
// So these tests are about size, not correctness of content: a page that grows
// with the size of the namespace is the bug, and it comes back the moment
// somebody renders a list without a limit.
//
// Same harness as sessions.test.mjs: the real router against a throwaway libsql
// file, skipped cleanly when the PWA deps are not installed.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pit-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const TLDS = 50;
const NAMES = 100;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);

  // One timestamp across every ending, on purpose: that is what a bulk claim
  // writes, so `ORDER BY created_at DESC` alone is not a total order and paging
  // through it can repeat one row and drop another.
  const at = 1_700_000_000_000;
  for (let i = 0; i < TLDS; i++) {
    const tld = `tld${String(i).padStart(3, "0")}`;
    await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,created_at) VALUES (?,?,?,?,?)`,
      [tld, "u1", "a@b.c", null, at]);
    for (let n = 0; n < NAMES; n++) {
      await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES (?,?,?,?,?)`,
        [tld, `name${String(n).padStart(3, "0")}`, "u1", null, at]);
    }
  }
  // Somebody else's ending, so Theirs has a row and a count of its own.
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,alias_of,price_usd,created_at) VALUES (?,?,?,?,?,?)`,
    ["mine", "u2", "x@y.z", null, 3, at]);

  const app = deps.express();
  app.use(deps.express.urlencoded({ extended: false }));
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

/** Endings drawn as a panel heading on this page. */
const endings = (html) => [...html.matchAll(/<h3 class="acid">\.([a-z0-9]+)<\/h3>/g)].map((m) => m[1]);
const elements = (html) => (html.match(/<[a-z]/g) || []).length;

test("pit: the page does not grow with the size of the namespace", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/pit");
  assert.equal(status, 200);

  // 5000 names exist. The unbounded page rendered all of them; this one draws a
  // window. The ceiling is deliberately loose — it is a guard against "no limit
  // at all" coming back, not a pixel budget.
  assert.ok(elements(html) < 4000, `page drew ${elements(html)} elements`);
  assert.ok(html.length < 500 * 1024, `page was ${(html.length / 1024).toFixed(0)} KiB`);
  assert.ok(endings(html).length <= 20, `page drew ${endings(html).length} endings`);
});

test("pit: what is not drawn is stated rather than silently dropped", skip, async () => {
  const { get } = await app();
  const { html } = await get("/pit");

  // The count is the honest part: a page showing 10 of 100 names with no total
  // is indistinguishable from an account that holds 10 names.
  assert.match(html, /100 names/, "each ending reports how many names it holds");
  assert.match(html, /10 of 100 shown/, "and how many of them are on screen");
  assert.match(html, /page 1 of 3 · 50 endings/, "the pager states the total");
});

test("pit: paging covers every ending exactly once, even on tied timestamps", skip, async () => {
  const { get } = await app();
  const seen = [];
  for (const p of [1, 2, 3]) seen.push(...endings((await get(`/pit?page=${p}`)).html));

  assert.equal(seen.length, TLDS, "every ending appears");
  assert.equal(new Set(seen).size, TLDS, "and none appears twice");
});

test("pit: ?tld= opens one ending with more of it than the list shows", skip, async () => {
  const { get } = await app();
  const { status, html } = await get("/pit?tld=tld007");
  assert.equal(status, 200);

  assert.deepEqual(endings(html), ["tld007"], "only the ending asked for");
  // 100 names, all of them, because there is only one ending on the page.
  assert.match(html, /name099\.tld007/, "the whole ending is drawn");
  assert.doesNotMatch(html, /10 of 100 shown/, "nothing is being held back here");
});

test("pit: ?tld= is not a way to read an ending somebody else holds", skip, async () => {
  const { get } = await app();
  const { html } = await get("/pit?tld=mine");

  // Falls back to the normal paged view rather than opening u2's ending in the
  // panel that carries edit and release buttons.
  assert.ok(endings(html).length > 1, "did not focus another account's ending");
  assert.ok(!endings(html).includes("mine"), "and did not draw it among yours");
});

test("pit: an unreadable ?page= is page one, not an empty panel", skip, async () => {
  const { get } = await app();
  for (const q of ["?page=0", "?page=-3", "?page=banana", "?page="]) {
    const { html } = await get(`/pit${q}`);
    assert.equal(endings(html).length, 20, `${q} drew an empty or partial page`);
    assert.match(html, /page 1 of 3/, `${q} did not land on page one`);
  }
});
