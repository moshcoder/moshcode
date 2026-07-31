// Selling names under a TLD you do not own: pricing, quoting, and settling a
// CoinPay purchase. The races here move real money, so they are the point.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-sales-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const SELLER = "user-seller";
const BUYER = "user-buyer";
const OTHER = "user-other";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[SELLER, "s@example.com"], [BUYER, "b@example.com"], [OTHER, "o@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  return import("../src/moshpit.mjs");
}

test("moshpit name sales", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const m = await boot();
  await m.registerTld({ tld: "whatever", userId: SELLER, ownerEmail: "s@example.com" });

  await t.test("a TLD starts closed for business", async () => {
    const q = await m.quoteName({ tld: "whatever", label: "foo", buyerId: BUYER });
    assert.equal(q.ok, false);
    assert.match(q.error, /not for sale/, "listing has to be an explicit act by the operator");
  });

  await t.test("only the operator can price their TLD", async () => {
    assert.equal((await m.setTldPrice({ tld: "whatever", userId: OTHER, priceUsd: 1 })).ok, false);
  });

  await t.test("a price must be a positive, plausible number", async () => {
    for (const bad of [0, -5, "abc", Infinity, NaN, 5_000_000]) {
      const r = await m.setTldPrice({ tld: "whatever", userId: SELLER, priceUsd: bad });
      assert.equal(r.ok, false, `${bad} should be refused`);
    }
    // A zero or negative price would let anyone drain the namespace for free.
    assert.equal((await m.getTldWithPrice("whatever")).price_usd, null);
  });

  await t.test("listing sets a price, rounded to cents", async () => {
    const r = await m.setTldPrice({ tld: "whatever", userId: SELLER, priceUsd: "12.345" });
    assert.equal(r.ok, true);
    assert.equal(r.priceUsd, 12.35);
    assert.equal((await m.getTldWithPrice("whatever")).price_usd, 12.35);
  });

  await t.test("a buyer gets a quote; the owner does not need one", async () => {
    const q = await m.quoteName({ tld: "whatever", label: "foo", buyerId: BUYER });
    assert.equal(q.ok, true);
    assert.equal(q.priceUsd, 12.35);

    const own = await m.quoteName({ tld: "whatever", label: "foo", buyerId: SELLER });
    assert.equal(own.ok, false, "the operator mints under their own TLD for nothing");
  });

  await t.test("paying hands the name to the buyer, not the seller", async () => {
    await m.openNamePurchase({ paymentId: "pay-1", tld: "whatever", label: "foo", userId: BUYER, amountUsd: 12.35 });
    const s = await m.settleNamePurchase("pay-1");
    assert.equal(s.ok, true);

    const name = await m.getName("whatever", "foo");
    assert.equal(name.user_id, BUYER);
    assert.equal((await m.resolveMoshpitName("foo.whatever")).name_registered, true);
  });

  await t.test("a redelivered webhook settles once", async () => {
    // CoinPay retries anything it never got an ack for.
    const again = await m.settleNamePurchase("pay-1");
    assert.equal(again.ok, false);
    assert.deepEqual((await m.listNames("whatever")).map((n) => n.label), ["foo"]);
  });

  await t.test("an unknown payment id settles nothing", async () => {
    assert.equal((await m.settleNamePurchase("pay-nope")).ok, false);
  });

  await t.test("a name already sold cannot be bought again", async () => {
    const q = await m.quoteName({ tld: "whatever", label: "foo", buyerId: OTHER });
    assert.equal(q.ok, false);
    assert.equal(q.taken, true);
  });

  await t.test("an open checkout holds the name against other buyers", async () => {
    await m.openNamePurchase({ paymentId: "pay-2", tld: "whatever", label: "held", userId: BUYER, amountUsd: 12.35 });
    const q = await m.quoteName({ tld: "whatever", label: "held", buyerId: OTHER });
    assert.equal(q.ok, false);
    assert.equal(q.taken, true, "so two people do not both pay for one name");
  });

  await t.test("an expired reservation releases the name", async () => {
    const later = Date.now() + m.RESERVATION_MS + 1000;
    const q = await m.quoteName({ tld: "whatever", label: "held", buyerId: OTHER, now: later });
    assert.equal(q.ok, true, "an abandoned checkout must not lock a name forever");
  });

  await t.test("losing the race after paying is recorded as a refund, not swallowed", async () => {
    // Someone else's purchase lands between checkout and confirmation.
    await m.openNamePurchase({ paymentId: "pay-3", tld: "whatever", label: "contested", userId: BUYER, amountUsd: 12.35 });
    await m.registerName({ tld: "whatever", label: "contested", userId: SELLER });

    const s = await m.settleNamePurchase("pay-3");
    assert.equal(s.ok, false);
    assert.equal(s.refundDue, true);

    const rows = await m.listNamePurchases(BUYER);
    assert.equal(rows.find((r) => r.id === "pay-3").status, "refund_due",
      "real money against a name they cannot have has to be visible");
    // ...and the name still belongs to whoever actually got it first.
    assert.equal((await m.getName("whatever", "contested")).user_id, SELLER);
  });

  await t.test("unlisting closes the TLD again", async () => {
    assert.equal((await m.setTldPrice({ tld: "whatever", userId: SELLER, priceUsd: null })).ok, true);
    assert.equal((await m.quoteName({ tld: "whatever", label: "new", buyerId: BUYER })).ok, false);
  });

  await t.test("the market lists other people's TLDs, not your own", async () => {
    await m.registerTld({ tld: "mine", userId: BUYER });
    const forBuyer = await m.listTldsNotOwnedBy(BUYER);
    assert.ok(forBuyer.some((t) => t.tld === "whatever"));
    assert.ok(!forBuyer.some((t) => t.tld === "mine"), "your own endings belong under Yours");
  });

  await t.test("for_sale narrows the market to what can actually be bought", async () => {
    await m.setTldPrice({ tld: "whatever", userId: SELLER, priceUsd: 3 });
    const buyable = await m.listTldsNotOwnedBy(BUYER, { forSale: true });
    assert.deepEqual(buyable.map((t) => t.tld), ["whatever"]);
  });
});
