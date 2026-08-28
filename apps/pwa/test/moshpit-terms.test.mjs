// Paying for an ending, and keeping it.
//
// Against a real throwaway libSQL database: the interesting behaviour is in
// conditional UPDATEs and a UNIQUE constraint, and a stub has neither.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-terms-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice";
const BOB = "user-bob";

test("ending terms", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "a@e.com"], [BOB, "b@e.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id,email,created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  const m = await import("../src/moshpit.mjs");
  const uniq = () => `e${randomBytes(4).toString("hex")}`;
  const pay = () => `pay-${randomBytes(6).toString("hex")}`;

  await t.test("an unclaimed ending quotes at the ending price, once", async () => {
    const q = await m.quoteTld({ tld: uniq(), buyerId: ALICE });
    assert.equal(q.ok, true);
    assert.equal(q.priceUsd, 5, "PRD 0005 §10.1, rounded to whole dollars");
    assert.equal(q.years, undefined, "there is no term to quote");
  });

  await t.test("there is no term to buy more of", async () => {
    // A quantity used to multiply the price. Passing one now is not an error
    // that needs naming, it is a field nothing reads -- what matters is that it
    // cannot quietly produce a different price.
    assert.equal((await m.quoteTld({ tld: uniq(), buyerId: ALICE, years: 3 })).priceUsd, 5);
    assert.equal((await m.quoteTld({ tld: uniq(), buyerId: ALICE, years: 11 })).priceUsd, 5);
    // And renewing is gone entirely rather than left as a no-op somebody could
    // still wire a checkout to.
    assert.equal(typeof m.quoteRenewal, "undefined");
    assert.equal(typeof m.MAX_TERM_YEARS, "undefined");
    assert.equal(typeof m.TERM_MS, "undefined");
  });

  await t.test("every refusal names itself", async () => {
    const held = uniq();
    await m.registerTld({ tld: held, userId: BOB });

    assert.match((await m.quoteTld({ tld: held, buyerId: ALICE })).error, /already registered/);
    assert.match((await m.quoteTld({ tld: held, buyerId: BOB })).error, /already yours/);
    assert.match((await m.quoteTld({ tld: "bank", buyerId: ALICE })).error, /reserved/);
    assert.match((await m.quoteTld({ tld: "a.b", buyerId: ALICE })).error, /not a valid TLD/);
  });

  await t.test("an open checkout holds the ending against other buyers", async () => {
    const tld = uniq();
    await m.openTldPurchase({ paymentId: pay(), tld, userId: ALICE, amountUsd: 5 });

    const q = await m.quoteTld({ tld, buyerId: BOB });
    assert.equal(q.ok, false);
    assert.equal(q.taken, true);
    assert.match(q.error, /in someone's checkout/);
  });

  await t.test("an expired reservation releases it", async () => {
    const tld = uniq();
    await m.openTldPurchase({ paymentId: pay(), tld, userId: ALICE, amountUsd: 5, now: Date.now() - m.RESERVATION_MS - 1000 });
    assert.equal((await m.quoteTld({ tld, buyerId: BOB })).ok, true);
  });

  await t.test("settling hands it over for good", async () => {
    const tld = uniq();
    const id = pay();
    const now = Date.now();
    await m.openTldPurchase({ paymentId: id, tld, userId: ALICE, amountUsd: 5, now });

    const result = await m.settleTldPurchase(id, now);
    assert.equal(result.ok, true);
    assert.equal(result.lifetime, true);

    const row = await m.getTldWithTerm(tld);
    assert.equal(row.user_id, ALICE);
    // The columns are gone, not merely unset: a NULL expiry somebody could
    // later populate is an annual term waiting to be switched back on.
    assert.equal("expires_at" in row, false);
    assert.equal("term_started_at" in row, false);
  });

  await t.test("the ledger still records what was sold", async () => {
    const tld = uniq();
    const id = pay();
    await m.openTldPurchase({ paymentId: id, tld, userId: ALICE, amountUsd: 5 });
    await m.settleTldPurchase(id);

    const row = (await m.listTldPurchases(ALICE, 50)).find((r) => r.id === id);
    assert.equal(row.kind, "register");
    assert.equal(row.years, 1);
    assert.equal(row.status, "cleared");
  });

  await t.test("a redelivered webhook does not settle twice", async () => {
    const tld = uniq();
    const id = pay();
    await m.openTldPurchase({ paymentId: id, tld, userId: ALICE, amountUsd: 5 });

    assert.equal((await m.settleTldPurchase(id)).ok, true);
    // CoinPay retries anything it never got an ack for.
    const again = await m.settleTldPurchase(id);
    assert.equal(again.ok, false);
    assert.match(again.error, /no pending purchase|already settled/);
  });

  await t.test("money against an ending taken first is a refund, not a shrug", async () => {
    const tld = uniq();
    const id = pay();
    await m.openTldPurchase({ paymentId: id, tld, userId: ALICE, amountUsd: 5 });
    await m.registerTld({ tld, userId: BOB }); // Bob claims it in the gap

    const result = await m.settleTldPurchase(id);
    assert.equal(result.ok, false);
    assert.equal(result.refundDue, true);
    const [row] = await m.listTldPurchases(ALICE, 50);
    assert.equal((await m.getTldWithTerm(tld)).user_id, BOB, "not taken from Bob");
    assert.ok(row, "the purchase is still on Alice's record");
  });

  await t.test("a renewal opened before the change is honoured, not refunded", async () => {
    // Nothing can create one of these any more, but a checkout opened before
    // endings went lifetime may still settle afterwards. The buyer is owed what
    // they were promised -- they keep the ending, and it now keeps itself.
    const tld = uniq();
    await m.registerTld({ tld, userId: ALICE });
    const id = pay();
    await run(
      `INSERT INTO moshpit_tld_purchases (id,tld,user_id,amount_usd,kind,status,years,created_at,reserved_until)
       VALUES (?,?,?,?, 'renew', 'pending', 1, ?, ?)`,
      [id, tld, ALICE, 5, Date.now(), Date.now() + 60_000],
    );

    const result = await m.settleTldPurchase(id);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.renewed, true);
    assert.equal(result.lifetime, true);
    assert.equal((await m.getTldWithTerm(tld)).user_id, ALICE);
    assert.equal((await m.listTldPurchases(ALICE, 50)).find((r) => r.id === id).status, "cleared");
  });

  await t.test("a renewal for an ending that changed hands is still a refund", async () => {
    const tld = uniq();
    await m.registerTld({ tld, userId: BOB });
    const id = pay();
    await run(
      `INSERT INTO moshpit_tld_purchases (id,tld,user_id,amount_usd,kind,status,years,created_at,reserved_until)
       VALUES (?,?,?,?, 'renew', 'pending', 1, ?, ?)`,
      [id, tld, ALICE, 5, Date.now(), Date.now() + 60_000],
    );

    const result = await m.settleTldPurchase(id);
    assert.equal(result.ok, false);
    assert.equal(result.refundDue, true);
  });

  await t.test("nothing expires any more", async () => {
    const tld = uniq();
    await m.registerTld({ tld, userId: ALICE });
    assert.equal(m.isExpired(await m.getTldWithTerm(tld)), false);
    // Including for a row that still carries a date from somewhere. The answer
    // is a permanent no, not a comparison against a column that no longer runs.
    assert.equal(m.isExpired({ expires_at: Date.now() - 1 }), false);
    assert.equal(m.isExpired(), false);
  });
});

test("deleting a user takes their rows with them", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all } = await import("../src/db.mjs");
  const { randomBytes: rb } = await import("node:crypto");

  await t.test("foreign keys are actually on", async () => {
    // SQLite ignores every REFERENCES clause without this, per connection. The
    // cascades in the schema were decorative for as long as it was unset.
    assert.equal((await all("PRAGMA foreign_keys"))[0].foreign_keys, 1);
  });

  await t.test("names, pins and purchases follow the user out", async () => {
    const uid = `u${rb(4).toString("hex")}`;
    const tld = `fk${rb(4).toString("hex")}`;
    const now = Date.now();
    await run(`INSERT INTO users (id,email,created_at) VALUES (?,?,?)`, [uid, `${uid}@e.com`, now]);
    await run(`INSERT INTO moshpit_tlds (tld,user_id,created_at) VALUES (?,?,?)`, [tld, uid, now]);
    await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES (?,?,?,?)`, [tld, "a", uid, now]);
    await run(`INSERT INTO moshpit_name_pins (tld,label,pin,kind,user_id,created_at) VALUES (?,?,?,?,?,?)`,
      [tld, "a", "AAAA", "tls", uid, now]);

    const mine = async (table) =>
      (await all(`SELECT 1 FROM ${table} WHERE user_id = ?`, [uid])).length;
    assert.equal(await mine("moshpit_names"), 1);
    assert.equal(await mine("moshpit_name_pins"), 1);

    await run(`DELETE FROM users WHERE id = ?`, [uid]);

    // Orphans here are not cosmetic: a published key outliving its owner is a
    // key nobody can revoke.
    assert.equal(await mine("moshpit_names"), 0);
    assert.equal(await mine("moshpit_name_pins"), 0);
  });
});
