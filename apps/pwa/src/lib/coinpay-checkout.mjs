// CoinPay hosted checkout sessions + the webhook that settles them.
//
// Every sale (credit packs, Moshpit names, agreed offers and leases) goes
// through one POST /api/checkout/sessions call: the buyer is redirected to the
// session url, picks any coin the business accepts or PayPal, and CoinPay
// signs a webhook to /webhooks/coinpay. Purchase rows are keyed by the session
// id (cs_...), which CoinPay echoes on the webhook as data.checkout_session_id.
import { config } from "../config.mjs";

/** True when a hosted checkout can be created (the business key is set). */
export function checkoutConfigured() {
  return Boolean(config.coinpay.apiKey);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (e) => typeof e === "string" && e.length <= 254 && EMAIL.test(e.trim());

/** The buyer's email: the account's, else one posted with the form. */
export function checkoutEmail(req) {
  const own = req.user?.email;
  if (validEmail(own)) return String(own).trim().toLowerCase();
  const posted = req.body?.email;
  return validEmail(posted) ? String(posted).trim().toLowerCase() : "";
}

/** The request body for POST /api/checkout/sessions. Exported for tests. */
export function sessionBody({ amountUsd, description, email, accountId, metadata = {}, successUrl, cancelUrl }) {
  return {
    amount: Number(amountUsd),
    currency: "USD",
    description,
    customer_email: String(email).trim().toLowerCase(),
    account_id: String(accountId),
    property: config.coinpay.property,
    metadata: { app: "moshcode", site: config.coinpay.property, ...metadata },
    success_url: successUrl,
    cancel_url: cancelUrl || successUrl,
    expires_in_minutes: 60,
  };
}

/**
 * Create a hosted checkout session. Resolves { id, url }; throws with the
 * CoinPay error text on any non-2xx so callers can log it.
 */
export async function createCheckoutSession(opts, { fetchImpl = fetch } = {}) {
  if (!checkoutConfigured()) throw new Error("payments are not configured yet");
  if (!validEmail(opts.email)) throw new Error("an email is required to check out");
  if (!opts.accountId) throw new Error("an account id is required to check out");
  const r = await fetchImpl(`${config.coinpay.apiBase}/api/checkout/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${config.coinpay.apiKey}`,
    },
    body: JSON.stringify(sessionBody(opts)),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok || !body?.id || !body?.url) {
    throw new Error(`coinpay checkout ${r.status}: ${(body?.error || text || "").toString().slice(0, 300)}`);
  }
  return { id: body.id, url: body.url, methods: body.methods || [] };
}

const SETTLED = new Set(["confirmed", "forwarded", "completed", "paid"]);
// The status is the last segment of a dotted event name ("payment.confirmed"),
// matched as a whole word: "payment.unpaid" ends in "paid" and must not settle.
const SETTLED_EVENT = /(?:^|[.\-_/:])(?:confirmed|forwarded|completed|paid)$/i;

/**
 * Read a CoinPay webhook. The body is nested ({ id: evt_..., type, data: {...} })
 * and the top-level id is the EVENT id, so read data first and fall back to the
 * older flat shape. refs are every id a purchase row may be keyed by: the
 * checkout session id first, then the payment id.
 */
export function readWebhook(payload) {
  const d = payload?.data ?? payload ?? {};
  const type = String(payload?.type || payload?.event || "");
  const status = String(d?.status ?? "").toLowerCase();
  const refs = [d?.checkout_session_id, d?.payment_id ?? d?.id]
    .filter((v) => typeof v === "string" && v)
    .filter((v, i, a) => a.indexOf(v) === i);
  const paid = SETTLED.has(status) || (!status && SETTLED_EVENT.test(type));
  return { type, status, refs, paid, metadata: d?.metadata ?? payload?.metadata ?? {} };
}
