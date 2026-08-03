// What a DNS record on a Moshpit name may say.
//
// Pure: no database, no request, no clock. Everything here is a decision about
// a string somebody typed into a form, and those decisions are the part worth
// testing exhaustively — a record that stores wrong is a name that resolves
// wrong, and the owner finds out from a visitor rather than from the form.
import { isIP } from "node:net";

import { blockedReason, parseTarget } from "./moshpit-gateway.mjs";
import { parseMoshpitName } from "./moshpit-name.mjs";

/**
 * The types a name may publish, in the order the form offers them.
 *
 * No A. The registry refuses IPv4 in "points at" for a reason that applies just
 * as hard here: IPv4 on a small host is leased, NATed or shared, so a name
 * pointed at one goes stale silently and nothing tells its owner. AAAA is the
 * address type on this network. The form says so rather than leaving an A
 * option that always fails.
 *
 * No SRV yet, and no NS: SRV needs a port, a weight and a priority to be worth
 * anything, and NS would hand a name's authority to a server the registry does
 * not run. Both are additions, not omissions to work around.
 */
export const RECORD_TYPES = ["AAAA", "CNAME", "TXT", "MX"];

/** What each type is for, next to the field rather than on a docs page. */
export const RECORD_HELP = {
  AAAA: { value: "IPv6 address", hint: "2606:4700:4700::1111 — the box serving this name" },
  CNAME: { value: "hostname or Moshpit name", hint: "box.example.com, or blue.eggs" },
  TXT: { value: "text", hint: "verification strings, keys, anything short" },
  MX: { value: "mail host", hint: "mx.example.com — with a priority, lowest wins" },
};

export const DEFAULT_TTL = 300;
/**
 * A minute is the floor because a TTL is a promise to every resolver that
 * cached the answer: below it, a name that moves is unreachable for longer than
 * the owner thinks, and above the ceiling a mistake outlives the day it was
 * made. A day is as long as anyone should have to wait to undo one.
 */
export const MIN_TTL = 60;
export const MAX_TTL = 86_400;

/**
 * TXT content, capped.
 *
 * DNS carries TXT as strings of at most 255 bytes each, so anything longer is
 * split across several — which is normal (DKIM keys are always split) and is
 * the resolver's job, not the owner's. The cap here is on the whole record, and
 * it is generous enough for a DKIM key and mean enough that nobody stores a
 * document in the registry.
 */
export const MAX_TXT_BYTES = 1024;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const MAX_PRIORITY = 65_535;

/** Uppercase a type, or null when it is not one this registry publishes. */
export function normalizeRecordType(input) {
  const type = String(input ?? "").trim().toUpperCase();
  return RECORD_TYPES.includes(type) ? type : null;
}

/**
 * A TTL in seconds, clamped rather than rejected.
 *
 * Nothing an owner can type into this field is a mistake worth refusing the
 * whole record over: 5 means "as short as you'll let me" and 99999999 means "as
 * long as you'll let me". Empty means the default, because most people have no
 * opinion and should not have to invent one.
 */
export function normalizeTtl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return DEFAULT_TTL;
  const ttl = Number.parseInt(raw, 10);
  if (!Number.isFinite(ttl)) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, ttl));
}

/**
 * A hostname on the right-hand side of a CNAME or an MX.
 *
 * A trailing dot is how a fully-qualified name is written and how half the
 * registrars on the clearnet expect it typed, so it is accepted and dropped
 * rather than being a validation error nobody can see the point of.
 */
function normalizeHostname(input) {
  const raw = String(input ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!raw) return null;
  // An address is not a hostname, and storing one here would publish a record
  // no resolver can follow. Caught explicitly so the error can say which field
  // it belonged in.
  if (isIP(raw)) return null;
  return HOSTNAME.test(raw) ? raw : null;
}

/**
 * Check one record and return the form to store.
 *
 * `{ ok: true, record: { type, value, ttl, priority } }`, or `{ ok: false,
 * error }` with a sentence that says what to do instead. The errors are the
 * product here: "not a valid record" tells an owner nothing about which of the
 * four fields they got wrong.
 */
export function normalizeRecord({ type: typeInput, value: valueInput, ttl: ttlInput, priority: priorityInput, name = null }) {
  const type = normalizeRecordType(typeInput);
  if (!type) return { ok: false, error: `pick a record type — ${RECORD_TYPES.join(", ")}` };

  const ttl = normalizeTtl(ttlInput);
  const raw = String(valueInput ?? "").trim();
  if (!raw) return { ok: false, error: `an ${type} record needs ${RECORD_HELP[type].value}` };

  if (type === "AAAA") {
    // parseTarget so that a pasted `[2606:4700::1111]` or a bracketed
    // host:port is understood; a port is then refused, because DNS carries an
    // address and has nowhere to put one.
    const parsed = parseTarget(raw);
    const host = parsed?.host ?? raw;
    if (parsed && parsed.port !== 80) {
      return { ok: false, error: "a AAAA record carries an address, not a port — drop the :port" };
    }
    if (isIP(host) === 4) {
      return { ok: false, error: "IPv4 addresses are not accepted — publish an AAAA record with an IPv6 address, or a CNAME to a hostname" };
    }
    if (isIP(host) !== 6) return { ok: false, error: "not an IPv6 address" };
    const why = blockedReason(host);
    if (why) return { ok: false, error: `that address is ${why} — a record has to point somewhere reachable from the public internet` };
    return { ok: true, record: { type, value: host.toLowerCase(), ttl, priority: null } };
  }

  if (type === "CNAME") {
    const host = normalizeHostname(raw);
    if (!host) {
      return isIP(raw)
        ? { ok: false, error: "a CNAME points at a name, not an address — use AAAA for an address" }
        : { ok: false, error: "not a usable hostname" };
    }
    // A name pointing at itself is a loop every resolver has to break, and the
    // registry is the only place that can see it is one.
    if (name && host === String(name).toLowerCase()) {
      return { ok: false, error: "a CNAME cannot point at the name it is on" };
    }
    return { ok: true, record: { type, value: host, ttl, priority: null } };
  }

  if (type === "MX") {
    const host = normalizeHostname(raw);
    if (!host) return { ok: false, error: "an MX record points at a mail host by name, not by address" };
    const priority = normalizePriority(priorityInput);
    if (priority === null) return { ok: false, error: `priority has to be a whole number from 0 to ${MAX_PRIORITY}` };
    return { ok: true, record: { type, value: host, ttl, priority } };
  }

  // TXT. Quotes are how the content is written in a zone file and how most
  // registrars show it back, so they come off rather than being stored as part
  // of the string and published as `"v=spf1 ..."` with the quotes inside.
  let text = raw;
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  // Control characters cannot be written into a zone file and a newline in
  // particular is how one record becomes two.
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, error: "TXT content cannot contain control characters or newlines" };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (!bytes) return { ok: false, error: "a TXT record needs some text" };
  if (bytes > MAX_TXT_BYTES) return { ok: false, error: `TXT content is limited to ${MAX_TXT_BYTES} bytes — this is ${bytes}` };
  return { ok: true, record: { type: "TXT", value: text, ttl, priority: null } };
}

/** A whole number priority in range, or null when it is not one. */
function normalizePriority(input) {
  const raw = String(input ?? "").trim();
  // Unset is 10: the conventional priority of a lone mail exchanger, and the
  // number every worked example on the internet uses.
  if (!raw) return 10;
  if (!/^\d+$/.test(raw)) return null;
  const priority = Number.parseInt(raw, 10);
  return priority <= MAX_PRIORITY ? priority : null;
}

/**
 * Why this record may not join the ones already on the name, or null.
 *
 * CNAME is exclusive by the shape of DNS itself: it means "this name is really
 * that name", so anything published beside it is an answer that contradicts it.
 * Resolvers handle the contradiction differently, which is worse than either
 * behaviour — so it is refused here, where the reason can be explained, rather
 * than left to be discovered as a name that works on one network and not
 * another.
 */
export function recordConflict(record, existing = []) {
  const others = existing.filter((r) => !(r.type === record.type && r.value === record.value));
  if (record.type === "CNAME") {
    if (others.length) {
      return "a CNAME has to be the only record on a name — remove the others first, or point them somewhere else";
    }
    return null;
  }
  if (others.some((r) => r.type === "CNAME")) {
    return `${record.value} already has a CNAME, and a CNAME cannot share a name with other records — remove it first`;
  }
  return null;
}

/**
 * The address a resolver that only understands "points at" should be handed.
 *
 * The bridge, the DoH server and the gateway all read a single `target`, and
 * they predate records by a year. Rather than teach every one of them about a
 * record set on the same day the records land, the registry keeps answering the
 * question they ask: the name's explicit target if it has one, else the first
 * address it publishes.
 *
 * Explicit target first, because it is the field an owner edited most recently
 * on the tab that has always existed, and having a record silently override it
 * would be the surprising half of the two.
 */
export function effectiveTarget(target, records = []) {
  if (target) return target;
  const aaaa = records.find((r) => r.type === "AAAA");
  if (aaaa) return aaaa.value;
  const cname = records.find((r) => r.type === "CNAME");
  return cname ? cname.value : null;
}

/**
 * A record as one line of a zone file.
 *
 * The pit's whole DX pitch is that these are real records rather than a
 * proprietary pointer, and the cheapest way to prove it is to show them in the
 * notation everybody already reads.
 */
export function zoneLine(name, record) {
  const rdata = record.type === "MX" ? `${record.priority} ${record.value}`
    : record.type === "TXT" ? `"${record.value.replace(/"/g, '\\"')}"`
    : record.value;
  return `${name}.\t${record.ttl}\tIN\t${record.type}\t${rdata}`;
}

/** Is this a Moshpit name rather than a clearnet one? Used only for a hint. */
export function isMoshpitTarget(value) {
  return Boolean(parseMoshpitName(value));
}
