// The migration that removes endings colliding with real top-level domains.
//
// Run once, against production, deleting rows people paid for. That is not a
// thing to merge on the strength of having read it, so it is executed here
// against a fixture with the real schema and the real 1438-entry list, and the
// outcome asserted.
//
// The failure being guarded against is not "it errors". It is "it removes one
// row too many", which on this table means taking someone's ending away, and
// which nothing downstream would notice.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

const MIGRATION = new URL("../src/migrations/019_moshpit_revoke_real_tlds.sql", import.meta.url);

/** The runner splits on `;` at end of line; this must match it exactly. */
const statements = (sql) => sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE moshpit_tlds (
      tld TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_email TEXT, owner_key TEXT, alias_of TEXT, created_at INTEGER NOT NULL, price_usd REAL);
    CREATE TABLE moshpit_tld_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, tld TEXT NOT NULL, user_id TEXT NOT NULL,
      action TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE moshpit_offers (id TEXT PRIMARY KEY, tld TEXT NOT NULL);
    INSERT INTO users (id) VALUES ('u1'),('u2');
  `);
  const rows = [
    // Real top-level domains. `sh` is the one that started this: sold for $2,
    // and it is where the registry itself lives.
    ["sh", "u2", 2], ["ai", "u1", 500], ["dev", "u2", null], ["com", "u1", 1],
    // Punycode is how an IDN appears on the wire, so it has to match too.
    ["xn--p1ai", "u1", null],
    // Moshpit's own. These must survive untouched.
    ["hacker", "u1", null], ["2600", "u1", 2], ["eggs", "u1", null],
    ["moshpit", "u1", null], ["42", "u2", null],
  ];
  const insert = db.prepare(
    `INSERT INTO moshpit_tlds (tld,user_id,owner_email,owner_key,alias_of,created_at,price_usd)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const [tld, user, price] of rows) insert.run(tld, user, `${user}@x.test`, null, null, 1700000000000, price);
  db.exec(`INSERT INTO moshpit_offers (id,tld) VALUES ('o1','sh')`);
  return db;
}

async function applied() {
  const db = fixture();
  for (const stmt of statements(await readFile(MIGRATION, "utf8"))) db.exec(stmt);
  return db;
}

const column = (db, sql) => db.prepare(sql).all().map((r) => Object.values(r)[0]).sort();

test("every real top-level domain is removed, punycode included", async () => {
  const db = await applied();
  assert.deepEqual(column(db, "SELECT tld FROM moshpit_tlds_removed"), ["ai", "com", "dev", "sh", "xn--p1ai"]);
});

test("Moshpit's own endings are untouched", async () => {
  const db = await applied();
  // The whole risk of this migration in one assertion.
  assert.deepEqual(column(db, "SELECT tld FROM moshpit_tlds"), ["2600", "42", "eggs", "hacker", "moshpit"]);
});

test("rows are archived, not dropped — owner and price survive", async () => {
  // Selling an ending took money. The directory row is the only record of who
  // holds what, so a hard delete would destroy the thing a refund would be
  // computed from.
  const db = await applied();
  const row = db.prepare("SELECT * FROM moshpit_tlds_removed WHERE tld = 'sh'").get();
  assert.equal(row.user_id, "u2");
  assert.equal(row.owner_email, "u2@x.test");
  assert.equal(row.price_usd, 2);
  assert.equal(row.created_at, 1700000000000);
  assert.match(row.reason, /real IANA top-level domain/);
  assert.ok(row.removed_at > 1700000000000, "removed_at is set to now, not copied");
});

test("the append-only log gains a revocation for each one", async () => {
  // `moshpit_tld_log` is the record; the directory is a cache of it. A claim
  // that stopped existing with nothing logged would read as never having been
  // made.
  const db = await applied();
  assert.deepEqual(
    column(db, "SELECT tld FROM moshpit_tld_log WHERE action = 'revoke'"),
    ["ai", "com", "dev", "sh", "xn--p1ai"],
  );
});

test("nothing cascades — an offer against a revoked ending survives", async () => {
  const db = await applied();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM moshpit_offers").get().n, 1);
});

test("the scratch table is cleaned up", async () => {
  const db = await applied();
  const n = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_iana_real_tlds'").get().n;
  assert.equal(n, 0, "a leftover table would be re-used, and stale, on the next migration");
});

test("running it twice removes nothing further", async () => {
  // The runner tracks applied files, so this should never happen — but a
  // migration that is not idempotent is one bad `_migrations` row away from
  // deleting a second set of endings.
  const db = await applied();
  const sql = await readFile(MIGRATION, "utf8");
  for (const stmt of statements(sql)) db.exec(stmt);
  assert.deepEqual(column(db, "SELECT tld FROM moshpit_tlds"), ["2600", "42", "eggs", "hacker", "moshpit"]);
  assert.deepEqual(column(db, "SELECT tld FROM moshpit_tlds_removed"), ["ai", "com", "dev", "sh", "xn--p1ai"]);
});
