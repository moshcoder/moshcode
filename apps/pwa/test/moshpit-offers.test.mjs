// Offers on a parked name, and the leases some of them become.
//
// The behaviour under test is mostly about what does NOT happen: an offer does
// not reach a holder until the address is confirmed, an accepted offer does not
// move a name until money confirms, a tenant does not keep control after their
// term, and nobody but the holder ever sees what was offered.
//
// Same harness as moshpit-contact.test.mjs: the real router against a throwaway
// libsql file, skipped cleanly when the PWA deps are not installed. The pure
// rules run either way.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  agreedTerms,
  describeOffer,
  effectiveStatus,
  leaseEndsAt,
  leaseIsActive,
  normalizeLeaseMonths,
  normalizeOfferAmount,
  normalizeOfferKind,
  offerIsLive,
} from "../src/lib/moshpit-offer.mjs";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-offers-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PUBLIC_ORIGIN = "https://app.example.test";
process.env.PIT_ORIGIN = "https://pit.example.test";
delete process.env.RESEND_API_KEY;
delete process.env.FORWARDEMAIL_API_KEY;

/* ---- the rules, which need nothing ---- */

test("money is read the way people type it, and rounded to cents", () => {
  assert.equal(normalizeOfferAmount("$1,200"), 1200);
  assert.equal(normalizeOfferAmount(" 99.99 "), 99.99);
  assert.equal(normalizeOfferAmount("2500"), 2500);
});

test("an offer below the floor or beyond the bound is not an offer", () => {
  // The floor is not a view about what a name is worth. It is what makes
  // "offer nothing on all 18,000 endings" cost something to say.
  for (const bad of ["", "0", "0.5", "-100", "abc", "1e400", "2000000000"]) {
    assert.equal(normalizeOfferAmount(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("a term is whole months inside the bounds", () => {
  assert.equal(normalizeLeaseMonths("12"), 12);
  assert.equal(normalizeLeaseMonths("1"), 1);
  assert.equal(normalizeLeaseMonths("60"), 60);
  for (const bad of ["0", "61", "1.5", "-3", "", "twelve"]) {
    assert.equal(normalizeLeaseMonths(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("an offer is to buy or to lease, and nothing else", () => {
  assert.equal(normalizeOfferKind("BUY"), "buy");
  assert.equal(normalizeOfferKind("lease"), "lease");
  assert.equal(normalizeOfferKind("rent"), null);
});

test("a term runs in calendar months, and the short-month case picks a side", () => {
  // One month from 31 January is 28 February. The alternative is rolling into
  // March, which quietly hands the tenant a day they did not pay for.
  const jan31 = Date.UTC(2026, 0, 31, 12, 0, 0);
  assert.equal(new Date(leaseEndsAt(jan31, 1)).toISOString().slice(0, 10), "2026-02-28");
  const mar15 = Date.UTC(2026, 2, 15, 9, 30, 0);
  assert.equal(new Date(leaseEndsAt(mar15, 12)).toISOString().slice(0, 10), "2027-03-15");
  assert.equal(new Date(leaseEndsAt(mar15, 3)).toISOString().slice(0, 10), "2026-06-15");
});

test("a counter is what is operative once it exists", () => {
  const offer = { kind: "lease", amount_usd: 100, lease_months: 3, counter_amount_usd: 250, counter_months: 12 };
  assert.deepEqual(agreedTerms(offer), { amountUsd: 250, months: 12, countered: true });

  const plain = { kind: "buy", amount_usd: 100, lease_months: null, counter_amount_usd: null, counter_months: null };
  assert.deepEqual(agreedTerms(plain), { amountUsd: 100, months: null, countered: false });
});

test("an offer expires by the clock, not by a sweep having run", () => {
  const now = Date.now();
  const stale = { status: "open", expires_at: now - 1000 };
  assert.equal(effectiveStatus(stale, now), "expired");
  assert.equal(offerIsLive(stale, now), false);

  // Accepted is exempt: from there the only thing outstanding is a payment, and
  // a bill does not stop being owed because thirty days went by.
  const agreed = { status: "accepted", expires_at: now - 1000 };
  assert.equal(effectiveStatus(agreed, now), "accepted");
  assert.equal(offerIsLive(agreed, now), true);
});

test("a lease is active only between its dates", () => {
  const now = Date.now();
  assert.equal(leaseIsActive({ starts_at: now - 1000, expires_at: now + 1000 }, now), true);
  assert.equal(leaseIsActive({ starts_at: now - 2000, expires_at: now - 1000 }, now), false);
  assert.equal(leaseIsActive({ starts_at: now + 1000, expires_at: now + 2000 }, now), false);
  assert.equal(leaseIsActive(null, now), false);
});

test("an offer reads as one line, money first", () => {
  assert.match(describeOffer({ kind: "buy", tld: "eggs", label: "blue", amount_usd: 2500 }), /^\$2,500 to buy blue\.eggs$/);
  assert.match(
    describeOffer({ kind: "lease", tld: "eggs", label: "blue", amount_usd: 300, lease_months: 1 }),
    /\$300 to lease blue\.eggs for 1 month$/,
  );
  assert.match(describeOffer({ kind: "buy", tld: "eggs", label: "", amount_usd: 40 }), /to buy \.eggs$/);
});

/* ---- storage and routes ---- */

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, get, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const moshpit = await import("../src/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('holder','holder@example.com',1)`);
  await run(`INSERT OR REPLACE INTO users (id,email,created_at) VALUES ('buyer','buyer@example.com',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','holder','holder@example.com',1)`);
  // Held and pointed somewhere: the "claimed but does not point anywhere" case
  // the offer form exists to replace.
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','blue','holder',NULL,1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,target,created_at) VALUES ('eggs','rent','holder',NULL,1)`);

  const app = deps.express();
  app.use(deps.express.json());
  app.use((req, _res, next) => { req.csrfToken = () => "csrf"; next(); });
  app.use((req, _res, next) => {
    const id = req.headers["x-test-user"];
    if (id) req.user = { id, email: `${id}@example.com` };
    next();
  });
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const getHtml = async (p, userId = null) => {
    const res = await fetch(`${base}${p}`, { headers: userId ? { "x-test-user": userId } : {} });
    return { status: res.status, body: await res.text() };
  };

  // Paying, without CoinPay: the two writes the checkout and the webhook would
  // have made, in the order they make them.
  const pay = async (offerId, buyerId, paymentId) => {
    await moshpit.openOfferPurchase({ offerId, paymentId, userId: buyerId });
    return moshpit.settleOfferPurchase(paymentId);
  };

  return { server, db, run, get, getHtml, moshpit, pay };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("an offer does not reach the holder until the address is confirmed", skip, async () => {
  const { moshpit } = await app();
  const made = await moshpit.makeOffer({
    tld: "eggs", label: "blue", kind: "buy", amount: "2500", email: "Buyer <buyer@example.com>",
    message: "I run a paint shop",
  });

  assert.equal(made.ok, true);
  assert.equal(made.offer.status, "unverified");
  assert.equal(made.offer.amount_usd, 2500);
  assert.equal(made.offer.offerer_email, "buyer@example.com");
  assert.equal(made.offer.holder_user_id, "holder");

  // This is the anti-spam property, and it is worth asserting rather than
  // trusting: an unverified offer is not merely unsent, it is not on the
  // holder's page at all.
  const theirs = await moshpit.listOffersForHolder("holder");
  assert.equal(theirs.length, 0);
});

test("confirming it is what puts it in front of the holder, and twice is fine", skip, async () => {
  const { moshpit } = await app();
  const [offer] = await moshpit.listOffersForEmail("buyer@example.com");

  const first = await moshpit.verifyOffer(offer.verify_token);
  assert.equal(first.ok, true);
  assert.equal(first.offer.status, "open");
  assert.ok(first.offer.verified_at);

  // Mail clients fetch links, and people click twice. A second confirmation is
  // a success that changes nothing, not a used-up token.
  const second = await moshpit.verifyOffer(offer.verify_token);
  assert.equal(second.ok, true);
  assert.equal(second.already, true);

  const theirs = await moshpit.listOffersForHolder("holder");
  assert.equal(theirs.length, 1);
});

test("a confirmation link that is not ours is refused", skip, async () => {
  const { moshpit } = await app();
  const result = await moshpit.verifyOffer("not-a-real-token");
  assert.equal(result.ok, false);
});

test("you cannot offer on what you already hold", skip, async () => {
  const { moshpit } = await app();
  const result = await moshpit.makeOffer({
    tld: "eggs", label: "blue", kind: "buy", amount: "10", email: "holder@example.com", userId: "holder",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /hold this name already/);
});

test("one standing offer per name per address — a second is a counter, not a new offer", skip, async () => {
  const { moshpit } = await app();
  const again = await moshpit.makeOffer({
    tld: "eggs", label: "blue", kind: "buy", amount: "3000", email: "buyer@example.com",
  });
  assert.equal(again.ok, false);
  assert.match(again.error, /already have an offer standing/);
});

test("an unminted name is offerable, because the operator can mint it", skip, async () => {
  const { moshpit } = await app();
  // The case the old page turned away with ".eggs is not for sale" — true, and
  // not the same as "you cannot have it".
  const target = await moshpit.offerTarget("eggs", "unminted");
  assert.equal(target.ok, true);
  assert.equal(target.registered, false);
  assert.equal(target.holderId, "holder");
});

test("an ending nobody holds is claimed, not offered on", skip, async () => {
  const { moshpit } = await app();
  const target = await moshpit.offerTarget("nobodyholdsthis", "");
  assert.equal(target.ok, false);
  assert.equal(target.claimable, true);
});

test("an ending can be bought and not rented", skip, async () => {
  const { moshpit } = await app();
  const result = await moshpit.makeOffer({
    tld: "eggs", label: "", kind: "lease", amount: "500", months: "12", email: "someone@example.com",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /bought, not leased/);
});

test("the holder can counter, and the counter is what gets paid", skip, async () => {
  const { moshpit } = await app();
  const [offer] = await moshpit.listOffersForHolder("holder");

  const countered = await moshpit.respondToOffer({
    id: offer.id, userId: "holder", action: "counter", counterAmount: "4000",
  });
  assert.equal(countered.ok, true);
  assert.equal(countered.offer.status, "countered");
  assert.equal(agreedTerms(countered.offer).amountUsd, 4000);
  // The original is kept beside it: a negotiation that rewrites its own history
  // is one neither side can check.
  assert.equal(countered.offer.amount_usd, 2500);

  const taken = await moshpit.answerCounter({
    id: offer.id, token: offer.verify_token, action: "accept",
  });
  assert.equal(taken.ok, true);
  assert.equal(taken.offer.status, "accepted");
});

test("only the holder answers an offer, and only the offerer answers a counter", skip, async () => {
  const { moshpit } = await app();
  const [offer] = await moshpit.listOffersForHolder("holder");

  const notYours = await moshpit.respondToOffer({ id: offer.id, userId: "buyer", action: "accept" });
  assert.equal(notYours.ok, false);
  assert.match(notYours.error, /not made to you/);

  const noToken = await moshpit.answerCounter({ id: offer.id, token: "wrong", action: "withdraw" });
  assert.equal(noToken.ok, false);
});

test("paying transfers the name, and leaves nothing of the seller's on it", skip, async () => {
  const { moshpit, run, get, pay } = await app();
  const [offer] = await moshpit.listOffersForHolder("holder");

  // The seller's fingerprints: a contact with a forwarding alias, a record, a
  // key, and a target. All four belong to the person selling the name.
  await moshpit.setContact({ tld: "eggs", label: "blue", userId: "holder", email: "holder@example.com" });
  const pointedBySeller = await moshpit.setNameTarget({
    tld: "eggs", label: "blue", userId: "holder", target: "2001:db8::9",
  });
  assert.equal(pointedBySeller.ok, true, JSON.stringify(pointedBySeller));
  await run(`INSERT INTO moshpit_records (tld,label,type,value,ttl,priority,user_id,created_at)
             VALUES ('eggs','blue','TXT','hello',300,NULL,'holder',1)`);

  const settled = await pay(offer.id, "buyer", "pay_transfer_1");
  assert.equal(settled.ok, true);
  assert.equal(settled.kind, "buy");

  const name = await moshpit.getName("eggs", "blue");
  assert.equal(name.user_id, "buyer");
  // Cleared, not inherited. A target names the seller's server; a guard address
  // forwards the buyer's mail to the seller.
  assert.equal(name.target, null);
  assert.equal(await get(`SELECT tld FROM moshpit_contacts WHERE tld='eggs' AND label='blue'`), undefined ?? null);
  assert.ok(!(await get(`SELECT tld FROM moshpit_records WHERE tld='eggs' AND label='blue'`)));
  assert.ok(!(await get(`SELECT tld FROM moshpit_name_pins WHERE tld='eggs' AND label='blue'`)));
});

test("settling twice moves nothing twice", skip, async () => {
  const { moshpit, pay } = await app();
  // CoinPay retries a webhook it never got an ack for. The second delivery has
  // to be a no-op rather than a second transfer.
  const again = await moshpit.settleOfferPurchase("pay_transfer_1");
  assert.equal(again.ok, false);
  assert.equal((await moshpit.getName("eggs", "blue")).user_id, "buyer");
});

test("a lease grants control without moving the name", skip, async () => {
  const { moshpit, pay } = await app();
  const made = await moshpit.makeOffer({
    tld: "eggs", label: "rent", kind: "lease", amount: "600", months: "6", email: "buyer@example.com",
  });
  await moshpit.verifyOffer(made.verifyToken);
  await moshpit.respondToOffer({ id: made.offer.id, userId: "holder", action: "accept" });
  const settled = await pay(made.offer.id, "buyer", "pay_lease_1");

  assert.equal(settled.ok, true, JSON.stringify(settled));
  assert.equal(settled.kind, "lease");

  // Ownership does not move. That is the whole difference from a sale.
  const name = await moshpit.getName("eggs", "rent");
  assert.equal(name.user_id, "holder");
  assert.equal(name.leased_to, "buyer");

  // The tenant can use it...
  const pointed = await moshpit.setNameTarget({ tld: "eggs", label: "rent", userId: "buyer", target: "2001:db8::20" });
  assert.equal(pointed.ok, true, JSON.stringify(pointed));
  assert.equal((await moshpit.resolveMoshpitName("rent.eggs")).target, "2001:db8::20");

  // ...and the holder cannot point it out from under them mid-term.
  const blocked = await moshpit.setNameTarget({ tld: "eggs", label: "rent", userId: "holder", target: "2001:db8::99" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /leased until/);
});

test("a leased name cannot be given up, sold or re-let mid-term", skip, async () => {
  const { moshpit } = await app();
  const released = await moshpit.releaseName({ tld: "eggs", label: "rent", userId: "holder" });
  assert.equal(released.ok, false);
  assert.match(released.error, /cannot give it up mid-term/);

  const relet = await moshpit.makeOffer({
    tld: "eggs", label: "rent", kind: "lease", amount: "900", months: "3", email: "third@example.com",
  });
  assert.equal(relet.ok, false);
  assert.match(relet.error, /is leased until/);
});

test("a lease ends on its date, with or without a sweep", skip, async () => {
  const { moshpit, run } = await app();
  // Wind the term back rather than waiting six months for it.
  await run(`UPDATE moshpit_leases SET expires_at = ? WHERE tld='eggs' AND label='rent'`, [Date.now() - 1000]);
  await run(`UPDATE moshpit_names SET leased_until = ? WHERE tld='eggs' AND label='rent'`, [Date.now() - 1000]);

  // Read-time: control is back with the holder immediately, and the tenant's
  // site stops being served — before anything has been round to tidy up.
  const resolution = await moshpit.resolveMoshpitName("rent.eggs");
  assert.equal(resolution.target, null, "a lapsed tenant's target must stop being served at once");

  const tenant = await moshpit.setNameTarget({ tld: "eggs", label: "rent", userId: "buyer", target: "2001:db8::21" });
  assert.equal(tenant.ok, false);

  const holder = await moshpit.setNameTarget({ tld: "eggs", label: "rent", userId: "holder", target: "2001:db8::1" });
  assert.equal(holder.ok, true);
});

test("the sweep takes the tenant's things off the name", skip, async () => {
  const { moshpit, run, get } = await app();
  await run(`INSERT INTO moshpit_records (tld,label,type,value,ttl,priority,user_id,created_at)
             VALUES ('eggs','rent','TXT','tenant',300,NULL,'buyer',1)`);

  const swept = await moshpit.endExpiredLeases();
  assert.equal(swept.reverted, 1);

  const name = await moshpit.getName("eggs", "rent");
  assert.equal(name.leased_to, null);
  assert.equal(name.target, null);
  assert.ok(!(await get(`SELECT tld FROM moshpit_records WHERE tld='eggs' AND label='rent'`)));

  // Idempotent: a reverted lease is not reverted again on the next hour's run.
  assert.equal((await moshpit.endExpiredLeases()).reverted, 0);
});

/* ---- the pages ---- */

test("a parked name offers a way to ask, instead of ending the conversation", skip, async () => {
  const { getHtml } = await app();
  const { status, body } = await getHtml("/n/unminted.eggs");

  assert.equal(status, 200);
  assert.match(body, /Make an offer/);
  assert.match(body, /action="\/pit\/offer"/);
  assert.match(body, /lease it/);
});

test("an ending's page takes offers too, and does not offer to rent it", skip, async () => {
  const { getHtml } = await app();
  const { body } = await getHtml("/n/.eggs");

  assert.match(body, /Make an offer/);
  assert.doesNotMatch(body, /lease it/);
});

test("the holder is not invited to bid on their own name", skip, async () => {
  const { getHtml } = await app();
  const { body } = await getHtml("/n/unminted.eggs", "holder");
  assert.doesNotMatch(body, /action="\/pit\/offer"/);
});

test("a visitor never sees what anyone offered", skip, async () => {
  const { getHtml } = await app();
  // Private negotiation is the product decision; this is the assertion that
  // keeps it true as the page changes.
  for (const route of ["/n/blue.eggs", "/n/.eggs", "/n/rent.eggs"]) {
    const { body } = await getHtml(route);
    assert.doesNotMatch(body, /2500|4000|I run a paint shop/, `${route} leaked an offer`);
  }
});

test("the offers tab shows the holder what was offered, and the visitor nothing", skip, async () => {
  const { getHtml } = await app();
  const mine = await getHtml("/pit/offers", "holder");
  assert.equal(mine.status, 200);
  assert.match(mine.body, /blue\.eggs|rent\.eggs/);

  const anon = await getHtml("/pit/offers");
  assert.match(anon.body, /Sign in to see what people have offered/);
  assert.doesNotMatch(anon.body, /I run a paint shop/);
});
