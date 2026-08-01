// Paging the endings list.
//
// `/api/moshpit/tlds` answered with 200 rows and no indication that it had
// stopped. `?limit=` and `?offset=` were read on the `?q=` branch and ignored
// on every other, so asking for page two returned page one — which looks
// exactly like a registry that happens to hold 200 endings.
//
// The failure that shape produces is not a missing feature. A client reads
// "absent from the list" as "nobody has claimed it", and acts on it.
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
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pit-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

// More than the old ceiling, so the truncation this fixes is reachable.
const TOTAL = 260;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);

  // One timestamp across the whole batch, which is what a bulk claim actually
  // writes. `created_at` is then not a total order, and a pager that trusts it
  // alone repeats one ending and skips another at every page boundary.
  for (let i = 0; i < TOTAL; i++) {
    await run(
      `INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES (?,'u1','a@b.c',1)`,
      [`e${String(i).padStart(4, "0")}`],
    );
  }

  const key = (await createApiKey("u1", "cli")).plaintext;

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (p) => {
    const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${key}` } });
    return { status: res.status, json: await res.json() };
  };

  return { server, db, call };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("the endings list says how many there are", skip, async () => {
  const { call } = await app();

  const res = await call("/api/moshpit/tlds");
  assert.equal(res.status, 200);
  // The default page is unchanged. What is new is being told it is a page.
  assert.equal(res.json.tlds.length, 200);
  assert.equal(res.json.total, TOTAL, "a truncated list has to say so");
  assert.equal(res.json.limit, 200, "the limit reported is the one applied");
  assert.equal(res.json.offset, 0);
});

test("limit and offset are obeyed rather than read and dropped", skip, async () => {
  const { call } = await app();

  const first = await call("/api/moshpit/tlds?limit=10");
  assert.deepEqual(first.json.tlds.length, 10);

  const second = await call("/api/moshpit/tlds?limit=10&offset=10");
  assert.equal(second.json.offset, 10);
  assert.notDeepEqual(
    second.json.tlds.map((t) => t.tld),
    first.json.tlds.map((t) => t.tld),
    "page two used to be page one",
  );
});

test("paging the whole list loses nothing and repeats nothing", skip, async () => {
  const { call } = await app();

  // The tiebreak in the ORDER BY is what this actually tests: every ending
  // here shares one created_at, so without it the pages overlap.
  const seen = [];
  for (let offset = 0; offset < TOTAL; offset += 25) {
    const res = await call(`/api/moshpit/tlds?limit=25&offset=${offset}`);
    seen.push(...res.json.tlds.map((t) => t.tld));
  }
  assert.equal(seen.length, TOTAL);
  assert.equal(new Set(seen).size, TOTAL, "a page boundary inside a tie duplicates and skips");
});

test("a limit past the ceiling is capped, not honoured", skip, async () => {
  const { call } = await app();

  // Without a ceiling, `?limit=` is a way to ask for every row in the table,
  // which is the thing the pager exists to prevent.
  const res = await call("/api/moshpit/tlds?limit=999999");
  assert.equal(res.json.limit, 1000);
});

test("nonsense paging falls back rather than erroring or emptying", skip, async () => {
  const { call } = await app();

  for (const q of ["?limit=abc", "?limit=0", "?limit=-5", "?offset=-1", "?limit=&offset="]) {
    const res = await call(`/api/moshpit/tlds${q}`);
    assert.equal(res.status, 200, q);
    assert.equal(res.json.tlds.length, 200, `${q} should fall back to the default page`);
    assert.equal(res.json.offset, 0, q);
  }
});

test("your own endings still come back whole, and now carry a total", skip, async () => {
  const { call } = await app();

  // This is the one call that was already telling the truth. Adding a default
  // page size here would have turned the fix into the same bug somewhere else.
  const res = await call("/api/moshpit/tlds?mine=1");
  assert.equal(res.json.tlds.length, TOTAL, "unpaged by default, as before");
  assert.equal(res.json.total, TOTAL);
  assert.equal(res.json.limit, null);

  const paged = await call("/api/moshpit/tlds?mine=1&limit=30&offset=30");
  assert.equal(paged.json.tlds.length, 30, "and pages when asked to");
  assert.equal(paged.json.total, TOTAL);
});
