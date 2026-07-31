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

  await t.test("an unclaimed ending quotes at the ending price", async () => {
    const q = await m.quoteTld({ tld: uniq(), buyerId: ALICE });
    assert.equal(q.ok, true);
    assert.equal(q.priceUsd, 5, "PRD 0005 §10.1, rounded to whole dollars");
    assert.equal(q.years, 1);
  });

  await t.test("multiple years multiply, up to the cap", async () => {
    assert.equal((await m.quoteTld({ tld: uniq(), buyerId: ALICE, years: 3 })).priceUsd, 15);
    assert.equal((await m.quoteTld({ tld: uniq(), buyerId: ALICE, years: 11 })).ok, false);
    assert.equal((await m.quoteTld({ tld: uniq(), buyerId: ALICE, years: 0 })).ok, false);
    assert.equal((await m.quoteTld({ tld: uniq(), buyerId: ALICE, years: 1.5 })).ok, false);
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

  await t.test("settling hands it over with a term", async () => {
    const tld = uniq();
    const id = pay();
    const now = Date.now();
    await m.openTldPurchase({ paymentId: id, tld, userId: ALICE, amountUsd: 5, now });

    const result = await m.settleTldPurchase(id, now);
    assert.equal(result.ok, true);

    const row = await m.getTldWithTerm(tld);
    assert.equal(row.user_id, ALICE);
    assert.equal(row.term_started_at, now);
    assert.equal(row.expires_at, now + m.TERM_MS, "one year");
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

  await t.test("renewing extends, and never shortens", async () => {
    const tld = uniq();
    const now = Date.now();
    const first = pay();
    await m.openTldPurchase({ paymentId: first, tld, userId: ALICE, amountUsd: 5, now });
    await m.settleTldPurchase(first, now);

    // Renewing early adds to what is left rather than throwing it away.
    const second = pay();
    await m.openTldPurchase({ paymentId: second, tld, userId: ALICE, amountUsd: 5, kind: "renew", now });
    await m.settleTldPurchase(second, now + 1000);

    assert.equal((await m.getTldWithTerm(tld)).expires_at, now + m.TERM_MS * 2);
  });

  await t.test("renewing a lapsed term runs from now, not from the past", async () => {
    const tld = uniq();
    const past = Date.now() - m.TERM_MS * 2;
    await run(
      `INSERT INTO moshpit_tlds (tld,user_id,created_at,term_started_at,expires_at) VALUES (?,?,?,?,?)`,
      [tld, ALICE, past, past, past + m.TERM_MS],
    );

    const id = pay();
    const now = Date.now();
    await m.openTldPurchase({ paymentId: id, tld, userId: ALICE, amountUsd: 5, kind: "renew", now });
    await m.settleTldPurchase(id, now);

    assert.equal((await m.getTldWithTerm(tld)).expires_at, now + m.TERM_MS, "not backdated");
  });

  await t.test("only the holder may renew", async () => {
    const tld = uniq();
    await m.registerTld({ tld, userId: ALICE });
    assert.match((await m.quoteRenewal({ tld, userId: BOB })).error, /do not own/);
    assert.equal((await m.quoteRenewal({ tld, userId: ALICE })).ok, true);
  });

  await t.test("an ending with no term recorded is not expired", async () => {
    // Every ending claimed before terms existed has a NULL expiry. Treating
    // that as expired would put a few hundred namespaces on a clock nobody
    // agreed to.
    const tld = uniq();
    await m.registerTld({ tld, userId: ALICE });
    const row = await m.getTldWithTerm(tld);

    assert.equal(row.expires_at, null);
    assert.equal(m.isExpired(row), false);
    assert.equal(m.isExpired({ expires_at: Date.now() - 1 }), true);
    assert.equal(m.isExpired({ expires_at: Date.now() + 1000 }), false);
  });
});
