// The clearnet twin: what a Moshpit name looks like on the legacy internet.
//
// `financial.advisors` has no answer in the public root and never will. No CA
// will issue for an ending ICANN does not delegate, so the name cannot carry a
// certificate and cannot be reached by anyone who has not installed a resolver.
// That is the whole ceiling on the namespace: people like the clean name and
// then hand out an ugly one anyway, because the ugly one is the one that works.
//
// A twin is the way out. `financial-advisors.net` can be registered, certified
// and reached by anybody, and the pit name is the identity it publishes under.
// The pit name stays canonical; the twin is transport.
//
// Deliberately free of any database import, for the same reason moshpit-name is:
// a client -- the tronbrowser.dev extension, the DNS bridge -- needs these rules
// too, and none of them have a libSQL connection. src/moshpit.mjs owns storage.
import { normalizeLabel, normalizeTld, parseMoshpitName } from "./moshpit-name.mjs";

/**
 * The endings a twin is offered under, in the order people want them.
 *
 * All three are unclaimed as Moshpit endings and reserved in RESERVED_TLDS, so
 * a twin can never collide with an ending somebody holds. That is not luck --
 * `com`, `net` and `org` were reserved precisely because they collide with the
 * legacy internet in ways that would only ever confuse, and this is the one
 * place where that collision is the point.
 */
export const TWIN_TLDS = ["com", "net", "org"];

/** A hostname label on the legacy internet, where -- unlike in the pit -- dashes are allowed. */
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalise a clearnet domain, or null when it could never be one.
 *
 * Forgiving about what arrives because the field is typed by hand and people
 * paste a URL with a path still on it. Strict in one place beyond DNS: the last
 * label must be alphabetic and at least two characters, which refuses
 * `1.2.3.4`. An address is a well-formed sequence of labels, and accepting one
 * here would mean recording a "domain" that has no registrar to expire at.
 */
export function normalizeDomain(input) {
  const raw = String(input ?? "").trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")  // a pasted URL
    .replace(/[/?#].*$/, "")                 // ...with a path on it
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");                    // and a root dot, sometimes
  if (!raw || raw.length > 253) return null;
  const labels = raw.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => DOMAIN_LABEL.test(l))) return null;
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1])) return null;
  return raw;
}

/**
 * `blue.eggs` + `net` -> `blue-eggs.net`, or null when it will not fit.
 *
 * A dot collapsing into a hyphen, and it is deterministic in BOTH directions
 * for one reason: a Moshpit label may not contain a hyphen. That rule exists to
 * stop look-alike squatting (see LABEL in moshpit-name.mjs) and this inherits it
 * for free -- a twin has exactly one hyphen in its stem, so it splits back into
 * exactly one `<label>.<tld>` with no lookup and no ambiguity.
 *
 * The length check is not pedantry. A DNS label is capped at 63 characters and
 * the stem is both halves of the pit name plus a hyphen, so a name well inside
 * Moshpit's own limits can have no representable twin at all. Better to say so
 * than to offer a domain no registrar will accept.
 */
export function clearnetTwin(input, tld = TWIN_TLDS[0]) {
  const parsed = parseMoshpitName(input);
  const suffix = normalizeTld(tld);
  if (!parsed || !suffix) return null;
  const stem = `${parsed.label}-${parsed.tld}`;
  if (stem.length > 63) return null;
  return normalizeDomain(`${stem}.${suffix}`);
}

/** Every twin worth offering for a name. Empty when the name is too long to have one. */
export function clearnetTwins(input, tlds = TWIN_TLDS) {
  return tlds.map((tld) => clearnetTwin(input, tld)).filter(Boolean);
}

/**
 * The other direction: `blue-eggs.net` -> `blue.eggs`.
 *
 * This is what lets someone who arrived at the twin discover the name it stands
 * for, without asking the registry anything.
 *
 * Only the registrable stem is read, so `www.blue-eggs.net` is the same twin
 * wearing a hostname. Exactly one hyphen and both halves valid Moshpit labels,
 * or null: a domain that merely happens to contain a dash is not a twin, and
 * guessing otherwise would name a pit name on behalf of someone who never asked
 * for one.
 *
 * A multi-label public suffix (`blue-eggs.co.uk`) reads the wrong stem here and
 * comes back null or wrong. Doing it properly needs the Public Suffix List,
 * which is a dependency this file exists to avoid -- so TWIN_TLDS is one label
 * only, and that is the constraint that keeps this honest rather than an
 * oversight to fix later.
 */
export function moshpitNameForTwin(input) {
  const domain = normalizeDomain(input);
  if (!domain) return null;
  const labels = domain.split(".");
  const stem = labels[labels.length - 2];
  const parts = stem.split("-");
  if (parts.length !== 2) return null;
  const label = normalizeLabel(parts[0]);
  const tld = normalizeTld(parts[1]);
  if (!label || !tld) return null;
  const name = `${label}.${tld}`;
  return parseMoshpitName(name) ? name : null;
}

/* ---- proving the twin is yours ---- */

/**
 * Where the proof lives: `_moshpit.blue-eggs.net  TXT  "v=moshpit1 ..."`.
 *
 * Underscore-prefixed so it can never collide with a host somebody wants to
 * serve, which is the convention every other TXT-based challenge settled on for
 * the same reason.
 */
export const TWIN_PROOF_HOST = "_moshpit";

/** The name to query for a domain's proof record. */
export function twinProofName(domain) {
  const d = normalizeDomain(domain);
  return d ? `${TWIN_PROOF_HOST}.${d}` : null;
}

/** A challenge token: 16 random bytes as hex, checked so a malformed one cannot half-match. */
export function normalizeTwinToken(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(raw) ? raw : null;
}

/**
 * The TXT record a domain publishes to be backfilled onto a name.
 *
 * One record doing two jobs, deliberately. Publishing it proves control of the
 * domain, because only its holder can put a record there -- and the same record
 * IS the reverse pointer, the thing that lets a client arriving at
 * `blue-eggs.net` learn it is `blue.eggs` in the pit. Two separate records
 * would have allowed a domain to prove itself and then never advertise the
 * name, and that is precisely the state in which nobody ever finds out the
 * clean name exists. Adoption is the point; a proof nobody can read is half a
 * feature.
 *
 * The token binds the pair in the direction the name's owner cannot fake.
 * Without it, publishing `name=someone.else` would assert a link to a name you
 * do not hold; with it, the assertion is only good against the challenge the
 * registry issued to that name's actual owner.
 */
export function twinProof({ name, token }) {
  const parsed = parseMoshpitName(name);
  const t = normalizeTwinToken(token);
  return parsed && t ? `v=moshpit1 name=${parsed.label}.${parsed.tld} token=${t}` : null;
}

/**
 * Read a proof record back, or null when it is not one.
 *
 * Fields are read by key rather than by position: a TXT record gets edited by
 * hand in a registrar's web form, and order is the first thing to change.
 * Unknown fields are ignored so the format can grow one without every
 * already-published record turning invalid on the day it does.
 */
export function parseTwinProof(txt) {
  const fields = new Map(
    String(txt ?? "").trim().split(/\s+/)
      .map((f) => {
        const eq = f.indexOf("=");
        return eq > 0 ? [f.slice(0, eq).toLowerCase(), f.slice(eq + 1)] : null;
      })
      .filter(Boolean),
  );
  if (fields.get("v") !== "moshpit1") return null;
  const parsed = parseMoshpitName(fields.get("name"));
  const token = normalizeTwinToken(fields.get("token"));
  if (!parsed || !token) return null;
  return { name: `${parsed.label}.${parsed.tld}`, token };
}

/**
 * Does any of a domain's TXT records prove this name?
 *
 * Takes the whole set because that is what a resolver returns, and because a
 * domain in real use carries several: an SPF record, somebody else's challenge,
 * a previous proof left behind after a rotation. One match among them is the
 * answer. Requiring the set to contain nothing else would fail on every domain
 * that is actually being used for anything.
 *
 * Compared plainly rather than in constant time, and that is considered: a
 * challenge token is not a secret we hold and they guess. It is a value we hand
 * to the name's owner and then read back out of public DNS, where anyone can
 * already see it.
 */
export function twinProofMatches(txtRecords, { name, token }) {
  const want = twinProof({ name, token });
  if (!want) return false;
  const expected = parseTwinProof(want);
  for (const record of txtRecords ?? []) {
    // A TXT record longer than 255 bytes arrives from DNS split into chunks and
    // resolvers hand those back as an array per record. Joining is what
    // reassembles the value the operator actually typed.
    const value = Array.isArray(record) ? record.join("") : record;
    const proof = parseTwinProof(value);
    if (proof && proof.name === expected.name && proof.token === expected.token) return true;
  }
  return false;
}

/* ---- what a backfill costs, and when it lapses ---- */

/**
 * What backfilling a name costs per year, on top of the name itself.
 *
 * $12, which is roughly a `.com` at cost. This is not a margin business: the
 * reason to sell it is that a pit name nobody outside the pit can reach is a
 * name people admire and do not buy, and the twin is what turns the namespace
 * from a curiosity into something you would put on a business card.
 *
 * Quoted as one number covering the registration rather than a fee plus a
 * pass-through, so the buyer is told the thing they actually pay.
 */
export const TWIN_PRICE_USD = 12;

/**
 * How long before the registrar's expiry a twin stops being served.
 *
 * A lapsed domain does not fail closed. It fails into whoever catches the drop,
 * and it fails invisibly: the pit goes on handing out a name that now resolves
 * to a stranger, under a proof record that stranger may delete at their
 * leisure. So the link is dropped on our clock, ahead of theirs.
 *
 * A week, because a renewal in flight should not be punished for being slow,
 * and because the alternative failure -- a twin that goes dark while its owner
 * still holds the domain -- is one an owner can see and fix, where the other
 * one is not.
 */
export const TWIN_UNLINK_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is a verified twin still good at this instant?
 *
 * Read at query time rather than swept by a job. A sweep that has not run yet
 * is a window in which the registry serves a link it has already decided is
 * dead, and the whole point of the lead time is that there is no such window.
 */
export function twinIsLive(twin, now = Date.now()) {
  if (!twin || twin.status !== "verified") return false;
  if (twin.expires_at === null || twin.expires_at === undefined) return true;
  return now < twin.expires_at - TWIN_UNLINK_LEAD_MS;
}
