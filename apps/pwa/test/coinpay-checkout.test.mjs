// Unit tests for the CoinPay hosted checkout helper (session body + webhook read).
import assert from "node:assert/strict";
import test from "node:test";

process.env.COINPAY_API_KEY = "cp_live_unit";
process.env.COINPAY_API_BASE = "https://coinpay.test";
const { sessionBody, readWebhook, createCheckoutSession, checkoutEmail } = await import("../src/lib/coinpay-checkout.mjs");

test("sessionBody carries email, account id, property and metadata", () => {
  const b = sessionBody({
    amountUsd: 20, description: "x", email: " A@B.co ", accountId: "u1",
    metadata: { kind: "moshpit_name", tld: "pit", label: "foo" }, successUrl: "https://app.moshcode.sh/pit",
  });
  assert.equal(b.amount, 20);
  assert.equal(b.currency, "USD");
  assert.equal(b.customer_email, "a@b.co");
  assert.equal(b.account_id, "u1");
  assert.equal(b.property, "app.moshcode.sh");
  assert.equal(b.cancel_url, "https://app.moshcode.sh/pit");
  assert.equal(b.expires_in_minutes, 60);
  assert.deepEqual(b.metadata, { app: "moshcode", site: "app.moshcode.sh", kind: "moshpit_name", tld: "pit", label: "foo" });
  assert.equal("blockchain" in b, false);
});

test("createCheckoutSession posts with the Bearer key and returns id + url", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ success: true, id: "cs_1", url: "https://coinpay.test/checkout/cs_1" }), { status: 201 });
  };
  const ses = await createCheckoutSession({ amountUsd: 5, description: "d", email: "a@b.co", accountId: "u1", successUrl: "s" }, { fetchImpl });
  assert.deepEqual({ id: ses.id, url: ses.url }, { id: "cs_1", url: "https://coinpay.test/checkout/cs_1" });
  assert.equal(seen.url, "https://coinpay.test/api/checkout/sessions");
  assert.equal(seen.init.headers.authorization, "Bearer cp_live_unit");
});

test("createCheckoutSession surfaces CoinPay errors and refuses a missing email", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "MISSING_ACCOUNT_ID" }), { status: 400 });
  await assert.rejects(createCheckoutSession({ amountUsd: 5, email: "a@b.co", accountId: "u1" }, { fetchImpl }), /400: MISSING_ACCOUNT_ID/);
  await assert.rejects(createCheckoutSession({ amountUsd: 5, email: "", accountId: "u1" }, { fetchImpl }), /email/);
});

test("readWebhook reads the nested payload first and ignores the event id", () => {
  const w = readWebhook({ id: "evt_x_1", type: "payment.confirmed", data: { payment_id: "p1", status: "confirmed", checkout_session_id: "cs_1" } });
  assert.deepEqual(w.refs, ["cs_1", "p1"]);
  assert.equal(w.paid, true);
  assert.equal(readWebhook({ type: "payment.forwarded", data: { payment_id: "p1", status: "forwarded" } }).paid, true);
  assert.equal(readWebhook({ type: "payment.expired", data: { payment_id: "p1", status: "expired" } }).paid, false);
  assert.equal(readWebhook({ type: "payment.unpaid", data: { id: "p1" } }).paid, false);
  // Flat legacy shape still reads.
  const flat = readWebhook({ payment_id: "p2", status: "confirmed" });
  assert.deepEqual(flat.refs, ["p2"]);
  assert.equal(flat.paid, true);
});

test("checkoutEmail prefers the account email, else a posted one", () => {
  assert.equal(checkoutEmail({ user: { email: "Me@X.io" }, body: { email: "o@x.io" } }), "me@x.io");
  assert.equal(checkoutEmail({ user: { email: null }, body: { email: "o@x.io" } }), "o@x.io");
  assert.equal(checkoutEmail({ user: { email: null }, body: {} }), "");
});
