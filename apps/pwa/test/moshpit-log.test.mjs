// Publishing the allocation log.
//
// `moshpit_tlds` is a cache and `moshpit_tld_log` is the record — that was
// decided when the table was written, and then nothing could read it. There was
// no route, so "the directory can be mirrored and served by anyone" described
// the schema and not the product: the only copy of the order in which names
// were allocated lived in one database, behind one login.
//
// What is tested here is the part a mirror depends on. Not that the endpoint
// answers, but that following `?since=` from zero to caught-up yields every
// entry exactly once, in the order the writer wrote them — because a mirror
// that drops one entry or reorders two disagrees with the registry about who
// claimed a name first, which is the single fact this table exists to settle.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-log-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const m = await import("../src/moshpit.mjs");

  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }

  // Written through the model rather than straight into the table, so what is
  // being paged is a log the registry actually produced.
  await m.registerTld({ tld: "eggs", userId: ALICE, ownerEmail: "alice@example.com" });
  await m.registerTld({ tld: "chicken", userId: BOB, ownerEmail: "bob@example.com" });
  for (let i = 0; i < 30; i++) {
    await m.registerName({ tld: "eggs", label: `n${String(i).padStart(3, "0")}`, userId: ALICE });
  }

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

  // No credentials anywhere in here, on purpose. Every call this file makes is
  // the call a stranger's mirror makes.
  const call = async (p) => {
    const res = await fetch(`${base}${p}`);
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

test("the log is readable by someone with no account", skip, async () => {
  const { call } = await app();

  // A log only the operator can read settles nothing: the reason to publish the
  // order is so a claim can be checked by someone who does not trust us.
  const res = await call("/api/moshpit/log");
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 32, "two endings and thirty names");
  assert.equal(res.json.entries.length, 32);
  assert.equal(res.json.since, 0);
  assert.equal(res.json.next, null, "a page that holds everything is caught up");
});

test("entries arrive in seq order, and say what happened", skip, async () => {
  const { call } = await app();
  const { entries } = (await call("/api/moshpit/log")).json;

  const seqs = entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "order is the whole product");
  assert.equal(new Set(seqs).size, seqs.length);

  assert.deepEqual(
    entries.slice(0, 2).map((e) => [e.tld, e.action]),
    [["eggs", "register"], ["chicken", "register"]],
    "the first two claims, in the order they were made",
  );
  assert.ok(entries.some((e) => e.action === "name:n000"), "mints are in the log too, not only claims");
  assert.ok(entries.every((e) => Number.isInteger(e.at)));
});

test("since is exclusive, so a mirror can resume from what it stored", skip, async () => {
  const { call } = await app();
  const all = (await call("/api/moshpit/log")).json.entries;

  const after = await call(`/api/moshpit/log?since=${all[4].seq}`);
  assert.equal(after.json.since, all[4].seq);
  assert.equal(after.json.entries[0].seq, all[5].seq, "exclusive: the entry you already have is not resent");
  assert.deepEqual(after.json.entries.map((e) => e.seq), all.slice(5).map((e) => e.seq));

  // Past the end is empty rather than an error, and stays caught up.
  const beyond = await call(`/api/moshpit/log?since=${all[all.length - 1].seq}`);
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.json.entries, []);
  assert.equal(beyond.json.next, null);
});

test("following next from zero replays the log exactly once", skip, async () => {
  const { call } = await app();

  // This is the mirror, written out. If it can drop or duplicate an entry, two
  // copies of the registry can disagree about who was first.
  const seen = [];
  let since = 0;
  for (let guard = 0; guard < 50; guard++) {
    const res = await call(`/api/moshpit/log?since=${since}&limit=7`);
    seen.push(...res.json.entries);
    if (res.json.next === null) break;
    assert.ok(res.json.next > since, "a cursor that does not advance is an infinite loop");
    since = res.json.next;
  }

  assert.equal(seen.length, 32);
  assert.equal(new Set(seen.map((e) => e.seq)).size, 32, "no entry replayed");
  const direct = (await call("/api/moshpit/log")).json.entries;
  assert.deepEqual(seen.map((e) => e.seq), direct.map((e) => e.seq), "paged and whole agree on order");
});

test("next is a cursor, not a page number", skip, async () => {
  const { call } = await app();

  const res = await call("/api/moshpit/log?limit=7");
  assert.equal(res.json.entries.length, 7);
  assert.equal(res.json.limit, 7);
  assert.equal(res.json.next, res.json.entries[6].seq, "resume from the last entry handed over");
  assert.equal(res.json.total, 32, "a page says how much log there is, not how much it holds");
});

test("the owning account is linkable but not identified", skip, async () => {
  const { call } = await app();
  const { entries } = (await call("/api/moshpit/log")).json;

  const body = JSON.stringify(entries);
  assert.ok(!body.includes(ALICE) && !body.includes(BOB), "ownership is public; the account behind it is not");
  assert.ok(!body.includes("alice@example.com"));

  const eggs = entries.find((e) => e.tld === "eggs");
  const chicken = entries.find((e) => e.tld === "chicken");
  assert.match(eggs.owner, /^[0-9a-f]{16}$/);
  assert.notEqual(eggs.owner, chicken.owner, "two owners have to be distinguishable");

  // Stable, or "these forty names are held by one account" stops being checkable
  // from the log alone.
  assert.equal(entries.filter((e) => e.owner === eggs.owner).length, 31);
});

test("paging arguments are capped and nonsense falls back", skip, async () => {
  const { call } = await app();

  const huge = await call("/api/moshpit/log?limit=999999");
  assert.equal(huge.json.limit, 1000, "without a ceiling, ?limit= asks for the whole table");

  for (const q of ["?limit=abc", "?limit=0", "?limit=-5", "?since=-1", "?since=abc", "?limit=&since="]) {
    const res = await call(`/api/moshpit/log${q}`);
    assert.equal(res.status, 200, q);
    assert.equal(res.json.entries.length, 32, `${q} should fall back to the default page`);
    assert.equal(res.json.since, 0, q);
  }
});
