// What a stranger may offer for a name, and what a lease term actually means.
//
// The parked page is the one moment someone wants a name enough to say so, and
// until now every version of that moment ended in a sentence: "claimed but does
// not point anywhere", ".eggs is not for sale". The holder never heard that
// anybody asked. An offer is the missing half of that conversation.
//
// Deliberately free of any database, network or config import, for the same
// reason moshpit-name, moshpit-twin and moshpit-contact are: these are the
// rules, and the rules have to be checkable without a libSQL connection.
// src/moshpit.mjs owns storage and the routes own the pages.
import { randomBytes } from "node:crypto";

export const OFFER_KINDS = ["buy", "lease"];

/**
 * The statuses an offer can be in, and which of them are still a conversation.
 *
 * `unverified` is live in the sense that it can still become something, but the
 * holder has not been told it exists -- that is the whole point of it. Every
 * listing the holder sees starts at `open`.
 */
export const OFFER_STATUSES = [
  "unverified", "open", "countered", "accepted", "settling", "paid",
  "refund_due", "rejected", "withdrawn", "expired",
];

/** Statuses that can still change. Everything else is history. */
const LIVE_STATUSES = new Set(["unverified", "open", "countered", "accepted", "settling"]);

/** Statuses the clock is allowed to end. An accepted offer is waiting on money, not on a reply. */
const EXPIRABLE_STATUSES = new Set(["unverified", "open", "countered"]);

/**
 * Thirty days, then an unanswered offer stops being one.
 *
 * Long enough that a holder who checks the pit monthly still sees it, short
 * enough that a page does not accumulate a decade of stale numbers somebody
 * might act on. An accepted offer is exempt: the clock stops the moment both
 * sides agree, because from there the only thing outstanding is a payment.
 */
export const OFFER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The floor, and why there is one.
 *
 * Not a view about what a name is worth. A required, non-trivial number is the
 * cheapest filter there is on a form that anybody on the internet can submit:
 * it costs a real bidder nothing and it makes "offer $0 on all 18,000 endings"
 * an activity with a stated price attached.
 */
export const MIN_OFFER_USD = 1;

/** Matches MAX_LISTING_PRICE_USD in moshpit.mjs -- a bound against Infinity and 1e300, not a policy. */
export const MAX_OFFER_USD = 1_000_000_000;

/** One month to five years. Beyond that, somebody wants to buy the name. */
export const MIN_LEASE_MONTHS = 1;
export const MAX_LEASE_MONTHS = 60;

/** How long a message may be. Enough to explain who you are, not enough to be a payload. */
export const MAX_OFFER_MESSAGE = 1000;

/**
 * Money, or null when what arrived could never be an amount.
 *
 * Rounded to cents rather than accepted as typed. A float that carries more
 * precision than money does is a number that renders as $19.989999999999998
 * somewhere downstream, and it will be somewhere the holder is deciding whether
 * to accept.
 */
export function normalizeOfferAmount(input) {
  const raw = String(input ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100) / 100;
  if (cents < MIN_OFFER_USD || cents > MAX_OFFER_USD) return null;
  return cents;
}

/** A whole number of months inside the bounds, or null. */
export function normalizeLeaseMonths(input) {
  const raw = String(input ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const months = Number.parseInt(raw, 10);
  if (months < MIN_LEASE_MONTHS || months > MAX_LEASE_MONTHS) return null;
  return months;
}

export const normalizeOfferKind = (input) => {
  const kind = String(input ?? "").trim().toLowerCase();
  return OFFER_KINDS.includes(kind) ? kind : null;
};

/** Trimmed and capped. Empty becomes null, so "no message" is one value and not two. */
export function normalizeOfferMessage(input) {
  const text = String(input ?? "").trim().slice(0, MAX_OFFER_MESSAGE);
  return text || null;
}

/**
 * Ids and tokens.
 *
 * The verify token is the only one that is a secret: it arrives by mail and
 * clicking it is what turns an address into a verified one, so it is sized
 * against guessing rather than against collision.
 */
export const mintOfferId = () => `ofr_${randomBytes(9).toString("hex")}`;
export const mintVerifyToken = () => randomBytes(32).toString("base64url");

/**
 * When a term that starts now runs out.
 *
 * Calendar months, not thirty-day blocks, because "three months" is what the
 * two of them agreed and a tenant counting days off a calendar should reach the
 * same date we did. The clamp is the awkward case every month-arithmetic
 * implementation has to pick an answer for: one month from 31 January is 28
 * February, because the alternative is silently rolling into March and giving
 * away a day of somebody's term.
 */
export function leaseEndsAt(startsAt, months) {
  const start = new Date(startsAt);
  const target = new Date(start.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  target.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds());
  return target.getTime();
}

/**
 * What the two of them have actually agreed to, counter included.
 *
 * The counter is held beside the original rather than replacing it, so every
 * reader has to know which one is operative. This is that knowledge, in one
 * place -- a caller that reads `amount_usd` directly will charge the wrong
 * number the first time a holder counters.
 */
export function agreedTerms(offer) {
  if (!offer) return null;
  return {
    amountUsd: offer.counter_amount_usd ?? offer.amount_usd,
    months: offer.kind === "lease" ? (offer.counter_months ?? offer.lease_months) : null,
    countered: offer.counter_amount_usd !== null && offer.counter_amount_usd !== undefined,
  };
}

/**
 * The status an offer really has, which is not always the one in the column.
 *
 * Expiry is a date passing rather than a write happening, so a row can be
 * `open` and long dead. Every reader goes through here, and the sweep that
 * writes `expired` is a tidy-up rather than the thing that makes it true --
 * otherwise an offer would be live exactly as long as the sweep was broken.
 */
export function effectiveStatus(offer, now = Date.now()) {
  if (!offer) return null;
  if (EXPIRABLE_STATUSES.has(offer.status) && offer.expires_at <= now) return "expired";
  return offer.status;
}

/** Whether this offer is still something either side can act on. */
export const offerIsLive = (offer, now = Date.now()) => LIVE_STATUSES.has(effectiveStatus(offer, now));

/** Whether the holder is the one being waited on. */
export const awaitingHolder = (offer, now = Date.now()) => effectiveStatus(offer, now) === "open";

/** Whether the offerer is the one being waited on -- a counter to answer, or a bill to pay. */
export const awaitingOfferer = (offer, now = Date.now()) =>
  ["countered", "accepted"].includes(effectiveStatus(offer, now));

/**
 * Whether a lease is running right now.
 *
 * Read-time, like everything else here. A lease that ended an hour ago must
 * stop granting control the moment it ends, not the next time a sweep runs --
 * the alternative is a former tenant still able to repoint a name they no
 * longer rent.
 */
export const leaseIsActive = (lease, now = Date.now()) =>
  Boolean(lease) && lease.starts_at <= now && lease.expires_at > now;

/**
 * How an offer reads in one line, for a subject line or a list row.
 *
 * Money first, because that is what the holder is deciding about.
 */
export function describeOffer(offer) {
  const terms = agreedTerms(offer);
  if (!terms) return "";
  const name = offer.label ? `${offer.label}.${offer.tld}` : `.${offer.tld}`;
  const money = `$${terms.amountUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return offer.kind === "lease"
    ? `${money} to lease ${name} for ${terms.months} month${terms.months === 1 ? "" : "s"}`
    : `${money} to buy ${name}`;
}
