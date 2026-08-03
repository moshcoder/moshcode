// Moshpit names on the machine, not just in the browser.
//
// The registry speaks HTTP, not DNS: pit.moshcode.sh answers
// /api/moshpit/resolve?name=… and nothing is listening on port 53. That is why
// `curl https://california.oranges/` fails on a VPS while the TronBrowser
// extension can reach the same name — the extension redirects tabs, which is
// not resolution, and nothing outside a browser benefits from it.
//
// So this is a bridge: a tiny DNS server that answers A queries for Moshpit
// TLDs out of the registry's HTTP API, plus the resolver config that routes
// just those TLDs to it. Everything else on the machine keeps using the normal
// nameserver — the bridge is authoritative for claimed Moshpit TLDs and
// deliberately silent about anything else.
//
// The wire codec is pure and separate from the socket so the whole protocol is
// testable without binding a port.

import dgram from "node:dgram";
import { isIP } from "node:net";

export const DEFAULT_REGISTRY_BASE = "https://pit.moshcode.sh";
export const DEFAULT_PARKING_HOST = "moshcoding.com";
export const DEFAULT_PORT = 5354;
export const DEFAULT_HOST = "127.0.0.1";

export function parseDnsPort(input) {
  const raw = String(input ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// Short, because a name's target can change the moment its owner points it
// somewhere. A stale A record is the one failure mode users cannot debug.
export const DEFAULT_TTL = 30;

export const TYPE_A = 1;
export const TYPE_AAAA = 28;
export const TYPE_CNAME = 5;
export const TYPE_MX = 15;
export const TYPE_TXT = 16;
const CLASS_IN = 1;

/**
 * The question types answered out of the registry's record set, mapped to the
 * name the registry calls them.
 *
 * Address questions are not in here. They are answered from `target`, which the
 * registry keeps in step with the address records and which every build of this
 * bridge has read since before records existed — routing them through here
 * would change how a name already resolving today gets its answer, to arrive at
 * the same address.
 */
export const RECORD_TYPES = new Map([
  [TYPE_CNAME, "CNAME"],
  [TYPE_MX, "MX"],
  [TYPE_TXT, "TXT"],
]);

/**
 * What fits in a UDP answer without EDNS.
 *
 * 512 bytes is the floor every resolver accepts. Beyond it a datagram may be
 * dropped by a middlebox rather than delivered short, so the reply is trimmed
 * to what fits and marked truncated instead of being sent oversized and lost.
 */
export const UDP_SAFE_BYTES = 512;
const RCODE_OK = 0;
const RCODE_SERVFAIL = 2;
const RCODE_REFUSED = 5;
const RCODE_NXDOMAIN = 3;

/* ---------------------------------------------------------------- wire codec */

/** Encode a hostname as DNS labels. */
export function encodeName(name) {
  const labels = String(name).replace(/\.$/, "").split(".").filter(Boolean);
  const parts = labels.map((l) => {
    const b = Buffer.from(l, "ascii");
    if (b.length > 63) throw new Error(`label too long: ${l}`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/**
 * Read a QNAME starting at `offset`. Returns { name, offset } where offset is
 * the first byte AFTER the name. Compression pointers are rejected rather than
 * followed: they cannot legally appear in a question, and quietly accepting
 * them in a parser that only reads questions invites a pointer loop.
 */
export function decodeName(buf, offset) {
  const labels = [];
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error("truncated name");
    const len = buf[i];
    if (len === 0) return { name: labels.join("."), offset: i + 1 };
    if ((len & 0xc0) === 0xc0) throw new Error("compression pointer in question");
    i += 1;
    if (i + len > buf.length) throw new Error("truncated label");
    labels.push(buf.toString("ascii", i, i + len));
    i += len;
  }
}

/** Parse a query. Returns null for anything we should not try to answer. */
export function parseQuery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a query
  if (buf.readUInt16BE(4) !== 1) return null; // exactly one question
  let name;
  let offset;
  try {
    ({ name, offset } = decodeName(buf, 12));
  } catch {
    return null;
  }
  if (offset + 4 > buf.length) return null;
  return {
    id: buf.readUInt16BE(0),
    recursionDesired: !!(flags & 0x0100),
    name: name.toLowerCase(),
    type: buf.readUInt16BE(offset),
    class: buf.readUInt16BE(offset + 2),
    questionEnd: offset + 4,
  };
}

function header(id, { rcode, answers, recursionDesired }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(id, 0);
  // QR=1 (response), AA=1 (we are authoritative for the TLDs we serve), RD
  // echoed back per RFC 1035, RA=0 — we do not offer recursion for anything.
  buf.writeUInt16BE(0x8400 | (recursionDesired ? 0x0100 : 0) | rcode, 2);
  buf.writeUInt16BE(1, 4); // QDCOUNT — the question is echoed
  buf.writeUInt16BE(answers, 6);
  return buf;
}

function ipv4(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return Buffer.from(bytes);
}

/**
 * 16 bytes of AAAA rdata.
 *
 * `isIP` has already ruled on the grammar, so the work here is expanding what
 * the text form is allowed to leave out: the `::` run of zero groups, and the
 * trailing dotted-quad an IPv4-mapped address is written with.
 */
function ipv6(address) {
  const raw = String(address).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(raw) !== 6) return null;

  let text = raw;
  const mapped = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const octets = mapped[2].split(".").map(Number);
    text = `${mapped[1]}${(((octets[0] << 8) | octets[1]) >>> 0).toString(16)}:${(((octets[2] << 8) | octets[3]) >>> 0).toString(16)}`;
  }

  const [head, tail] = text.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const groups = text.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;

  const buf = Buffer.alloc(16);
  groups.forEach((group, i) => buf.writeUInt16BE(parseInt(group, 16), i * 2));
  return buf;
}

/**
 * TXT rdata: one or more length-prefixed strings.
 *
 * Split at 255 bytes because that is the largest a single DNS character-string
 * can be, and long TXT values are normal rather than exceptional — a DKIM key
 * does not fit in one and is always carried as several. A client joins them
 * back together, so the split is invisible above the wire.
 *
 * Split on bytes, not characters: a multi-byte character straddling the
 * boundary would be cut in half and neither piece would decode.
 */
export function rdataTxt(value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (!bytes.length) return Buffer.from([0]);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.subarray(i, i + 255);
    chunks.push(Buffer.concat([Buffer.from([chunk.length]), chunk]));
  }
  return Buffer.concat(chunks);
}

/** MX rdata: a 16-bit preference, then the exchange as labels. */
export function rdataMx(priority, value) {
  const preference = Buffer.alloc(2);
  preference.writeUInt16BE(Math.min(65_535, Math.max(0, Number(priority) || 0)), 0);
  return Buffer.concat([preference, encodeName(value)]);
}

/**
 * The rdata for one record from the registry, or null when it cannot be
 * encoded.
 *
 * Null rather than a throw: one malformed record must not take down the answer
 * for the ones beside it that are fine. The registry validates on the way in,
 * so this is the second line — it is reading data over HTTP from a service that
 * may be a different version than this bridge.
 */
export function encodeRdata(record) {
  try {
    if (record?.type === "TXT") return rdataTxt(record.value);
    if (record?.type === "MX") return rdataMx(record.priority, record.value);
    if (record?.type === "CNAME") return encodeName(record.value);
    if (record?.type === "AAAA") return ipv6(record.value);
    if (record?.type === "A") return ipv4(record.value);
  } catch {
    return null;
  }
  return null;
}

const TYPE_NUMBERS = new Map([["A", TYPE_A], ["CNAME", TYPE_CNAME], ["MX", TYPE_MX],
  ["TXT", TYPE_TXT], ["AAAA", TYPE_AAAA]]);

/**
 * A response carrying whole records rather than a bare address.
 *
 * Answers are fitted to `limit` and TC is set only if something was left out.
 * Dropping every answer the way capResponse does is right for a relayed reply
 * that cannot be re-cut, but here the answers are ours: a name with nine MX
 * records should hand back the seven that fit and say it was truncated, not
 * nothing at all — this bridge speaks UDP only, so a client that retries over
 * TCP finds no one listening.
 *
 * `exists` carries the same NODATA/NXDOMAIN distinction buildResponse draws: a
 * name with no TXT record still exists, and answering NXDOMAIN would deny it
 * for every other type at once.
 */
export function buildRecordResponse(query, buf, records = [], { ttl = DEFAULT_TTL, exists = true, limit = UDP_SAFE_BYTES } = {}) {
  const question = buf.subarray(12, query.questionEnd);
  const encoded = [];
  let dropped = false;
  let size = 12 + question.length;

  for (const record of records) {
    const rdata = encodeRdata(record);
    const type = TYPE_NUMBERS.get(record?.type);
    if (!rdata || !type) continue;
    const answer = Buffer.alloc(12);
    answer.writeUInt16BE(0xc00c, 0); // the question's name, by pointer
    answer.writeUInt16BE(type, 2);
    answer.writeUInt16BE(CLASS_IN, 4);
    // The record's own TTL when it has one. An owner who set 60 on an address
    // that moves meant it, and overriding it with the bridge's default would
    // quietly hold the old answer for longer than they asked.
    answer.writeUInt32BE(Number.isFinite(record.ttl) ? Math.max(0, Math.floor(record.ttl)) : ttl, 6);
    answer.writeUInt16BE(rdata.length, 10);

    if (size + answer.length + rdata.length > limit) { dropped = true; continue; }
    size += answer.length + rdata.length;
    encoded.push(answer, rdata);
  }

  const answers = encoded.length / 2;
  const head = header(query.id, {
    rcode: answers || exists ? RCODE_OK : RCODE_NXDOMAIN,
    answers,
    recursionDesired: query.recursionDesired,
  });
  if (dropped) head.writeUInt16BE(head.readUInt16BE(2) | 0x0200, 2); // TC
  return Buffer.concat([head, question, ...encoded]);
}

/**
 * Build an address-record response for the family the query asked for.
 *
 * Three outcomes, and the difference between the last two is the whole reason
 * this is not a one-liner. NXDOMAIN says the name does not exist, and a
 * resolver is entitled to apply that to every record type at once. A name
 * pointed at an IPv6 address *does* exist — it just has no A record — so the A
 * query every browser sends alongside the AAAA one has to come back NOERROR
 * with no answers. Answering NXDOMAIN there teaches the resolver the name is
 * gone and takes the AAAA lookup down with it.
 *
 * `exists` is that distinction on its own. Holding an address implies the name
 * exists, so it defaults to exactly that, but the reverse does not hold: a name
 * can exist and have no address to hand back — because the question was for a
 * type this bridge does not serve, or because the target is a hostname rather
 * than an address. Those are NODATA, not NXDOMAIN.
 */
export function buildResponse(query, buf, address, ttl = DEFAULT_TTL, exists = Boolean(address)) {
  const question = buf.subarray(12, query.questionEnd);
  const wantsV6 = query.type === TYPE_AAAA;
  const rdata = address ? (wantsV6 ? ipv6(address) : ipv4(address)) : null;

  if (!rdata) {
    return Buffer.concat([
      header(query.id, {
        // The name is here, we just have nothing to say for this question: NODATA.
        rcode: exists ? RCODE_OK : RCODE_NXDOMAIN,
        answers: 0,
        recursionDesired: query.recursionDesired,
      }),
      question,
    ]);
  }

  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0); // pointer to the question's name
  answer.writeUInt16BE(wantsV6 ? TYPE_AAAA : TYPE_A, 2);
  answer.writeUInt16BE(CLASS_IN, 4);
  answer.writeUInt32BE(ttl, 6);
  answer.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([
    header(query.id, { rcode: RCODE_OK, answers: 1, recursionDesired: query.recursionDesired }),
    question,
    answer,
    rdata,
  ]);
}

/* ------------------------------------------------------------------ registry */

/** Names the registry can hold: exactly one label and one TLD. */
export function parseRegistryName(hostname) {
  const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".");
  if (parts.length !== 2) return null;
  // Letters and digits only, matching the registry. A dash is the cheapest way
  // to mint a look-alike of an ending someone else holds, and in a namespace
  // one level deep and first come first served there is nowhere to retreat to.
  // Keeping the rule here identical to the registry's matters more than the
  // rule itself: a name this bridge accepts and the registry rejects resolves
  // to a page that says it does not exist.
  const LABEL = /^[a-z0-9]{1,63}$/;
  const [label, tld] = parts;
  if (!LABEL.test(label) || !LABEL.test(tld)) return null;
  return { label, tld };
}

/** The TLDs currently claimed in the Pit — what we route to this resolver. */
/** The registry's own ceiling on one page. Asking for more just gets this. */
const TLD_PAGE = 1000;

/**
 * Every ending, paged.
 *
 * This used to take the first response and stop, which is a silent truncation:
 * the registry answers 200 by default and says so in `total`, but a list of 200
 * looks exactly like a complete list of 200. `.eggs` sat past that line, so
 * `dns install` wrote a config that quietly did not route it and the name did
 * not resolve — the failure looked like DNS, three layers from the cause.
 *
 * Paged to exhaustion against `total`, with the page count bounded so a
 * registry that misreports it cannot spin here forever.
 */
export async function fetchTlds({ registryBase = DEFAULT_REGISTRY_BASE, fetchImpl = fetch } = {}) {
  const base = `${registryBase.replace(/\/+$/, "")}/api/moshpit/tlds`;
  const seen = [];
  let offset = 0;
  let total = null;

  // A page that comes back empty ends it too, so a `total` that overstates the
  // rows on hand cannot loop.
  for (let page = 0; page < 64; page++) {
    const res = await fetchImpl(`${base}?limit=${TLD_PAGE}&offset=${offset}`);
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const json = await res.json();
    const rows = json?.tlds || [];
    if (!rows.length) break;

    seen.push(...rows);
    offset += rows.length;
    if (total === null && Number.isFinite(Number(json?.total))) total = Number(json.total);
    // No `total` at all means an older registry that cannot page — take what it
    // gave rather than walking off the end of it.
    if (total === null || offset >= total) break;
  }

  return seen
    .map((t) => (typeof t === "string" ? t : t?.tld))
    .filter((t) => typeof t === "string" && t)
    .map((t) => t.toLowerCase())
    .sort();
}

/**
 * What address a Moshpit name should resolve to.
 *
 * Three outcomes, and the middle one is the whole point of parking: a claimed
 * name with no target is NOT an error, it is a name waiting to be pointed
 * somewhere. Handing back the parking host means `curl california.oranges`
 * reaches a page that explains itself instead of failing to resolve.
 */
export async function resolveName(
  name,
  { registryBase = DEFAULT_REGISTRY_BASE, fetchImpl = fetch, timeoutMs = 4000, records = false } = {},
) {
  const parsed = parseRegistryName(name);
  if (!parsed) return { status: "not-a-name", target: null, records: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `&records=1` only when the question needs the whole set. Every address
    // lookup on the machine comes through here, and the registry does a second
    // query to answer it — a browser opening a page must not pay for records it
    // will never read.
    const url = `${registryBase.replace(/\/+$/, "")}/api/moshpit/resolve?name=${encodeURIComponent(
      `${parsed.label}.${parsed.tld}`,
    )}${records ? "&records=1" : ""}`;
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { status: "unreachable", target: null };
    const json = await res.json();
    const claimed =
      typeof json?.name_registered === "boolean" ? json.name_registered : json?.registered;
    if (typeof claimed !== "boolean") return { status: "unreachable", target: null };
    // The `records` key appears only when it was asked for. Every caller that
    // wants an address deep-compares this shape, and an empty array they never
    // requested is a difference they would have to be taught to ignore.
    const found = records ? { records: Array.isArray(json.records) ? json.records : [] } : {};
    const target = typeof json.target === "string" && json.target ? json.target : null;
    if (target) return { status: "live", target, ...found };
    return { status: "parked", target: null, registered: claimed, ...found };
  } catch {
    return { status: "unreachable", target: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The records of one type a name publishes, and whether the name is here.
 *
 * Both halves matter and they are not the same question: a name with no MX
 * record still exists, so the answer is NODATA, while a name nobody holds is
 * NXDOMAIN. Collapsing them would let a missing MX deny the name's address too.
 */
export async function answerRecords(name, options = {}) {
  const { type } = options;
  const result = await resolveName(name, { ...options, records: true });
  const exists = result.status === "live" || result.status === "parked";
  if (!exists || !type) return { exists, records: [] };
  return { exists, records: (result.records || []).filter((r) => r?.type === type) };
}

/* -------------------------------------------------------------------- server */

/**
 * What to say about a name: whether it is here at all, and the address to
 * answer with when there is one.
 *
 * Kept separate from the socket so the policy is testable on its own. A name we
 * could not look up is not here rather than parked: a registry outage must not
 * silently redirect every name on the machine to a parking page.
 *
 * `wantsAddress` is false for the questions this bridge does not serve (TXT, MX,
 * HTTPS/SVCB). Those still need to know the name is here, because saying
 * NXDOMAIN to one question denies the name for every other one too.
 */
export async function answerPolicy(name, options = {}) {
  const { parkingAddress, wantsAddress = true } = options;
  const result = await resolveName(name, options);
  const exists = result.status === "live" || result.status === "parked";
  if (!exists || !wantsAddress) return { exists, address: null };
  if (result.status === "live") return { exists, address: targetAddress(result.target) };
  return { exists, address: parkingAddress || null };
}

/**
 * The address to answer with, or null when there is none.
 */
export async function answerFor(name, options = {}) {
  const { address } = await answerPolicy(name, options);
  return address;
}

/**
 * The bare address inside a stored target, or null when there isn't one.
 *
 * Targets are typed by hand and come back from the registry as `2606:...`,
 * `[2606:...]:8080`, `example.com`, or with a scheme still attached. A record
 * carries an address and nothing else, so the port is dropped here — a name
 * whose target names a non-default port cannot be served by the resolver path
 * at all, because there is no way to say "port 8080" in an A or AAAA record and
 * the browser will go to 80 regardless. A hostname target is null for the same
 * reason: turning it into an address would mean this bridge doing clearnet DNS.
 */
export function targetAddress(target) {
  const raw = String(target || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!raw) return null;

  const bracketed = raw.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/i);
  const host = bracketed ? bracketed[1] : raw;
  if (isIP(host)) return host;

  const at = host.lastIndexOf(":");
  if (at > 0 && /^\d+$/.test(host.slice(at + 1))) {
    const bare = host.slice(0, at);
    if (isIP(bare) === 4) return bare;
  }
  return null;
}

/**
 * Is an address question on this name worth a second look for a CNAME?
 *
 * True when the name is here and has no address to give. A CNAME is the one
 * thing that can still answer such a question, and finding out costs another
 * round trip to the registry — so it is asked only on the path that would
 * otherwise return nothing at all, never on a name that already has an address.
 */
export function mayHaveCname({ exists, address }) {
  return Boolean(exists) && !address;
}

/**
 * Start the bridge. Returns { port, address, close() }.
 *
 * `parkingAddress` is resolved once by the caller (an A record must carry an
 * IP, not a name) and passed in, so the server itself never does clearnet DNS.
 */
/* ------------------------------------------------------------------ abuse */

// An open forwarding resolver is a DDoS amplifier before it is anything else.
// The attack does not need a botnet: one host spoofs a victim's source address,
// sends a small query, and the resolver mails the large answer to the victim.
// Scanners find open resolvers within hours of them being reachable.
//
// That shape defeats most defences worth having. The source address is a lie,
// so blocking "the client" punishes the victim; there is no session to
// fingerprint and no user agent to read. What is left is limiting how much
// amplification any single query can buy, and bounding what one source can
// extract before we stop answering it.

/** The question type that exists to be abused. */
export const TYPE_ANY = 255;

/**
 * A query we will not answer, or null when it is fine.
 *
 * ANY asks for every record a name has and is the classic amplification lever:
 * a 30-byte question for a multi-kilobyte answer. Real clients stopped needing
 * it years ago, and RFC 8482 blesses refusing it outright.
 */
export function refusalReason(query) {
  if (!query) return null;
  if (query.type === TYPE_ANY) return "ANY is refused — RFC 8482";
  return null;
}

/**
 * What counts as "the same client" for the purposes of banning one.
 *
 * IPv6 is grouped by /64 and this is the whole reason the function exists. A
 * single v6 address is free to change: any host worth banning has a /64 at
 * minimum and often a /48, so a ban on one address is defeated by incrementing
 * it. fail2ban rules written per-address in a v4 world quietly stop working
 * when the traffic arrives over v6, and the failure is silent — the bans look
 * like they are being applied, and the abuse continues.
 *
 * IPv4 is the address itself. Widening to /24 would be the equivalent move,
 * but v4 is scarce enough to be shared: a /24 routinely spans unrelated
 * customers behind carrier NAT, so grouping there punishes the neighbours of
 * an abuser rather than the abuser.
 */
export function clientKey(address) {
  const raw = String(address ?? "").trim().toLowerCase();
  if (!raw) return "";
  // A v4-mapped v6 address is a v4 client arriving on a dual-stack socket.
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (isIP(raw) !== 6) return raw;

  // Expand to the first four groups — the /64 — without a full parse.
  const [head, tail = ""] = raw.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const groups = raw.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  if (groups.length < 4) return raw;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * fail2ban for a resolver: repeat offenders wait exponentially longer.
 *
 * A flat rate limit is a toll an attacker simply pays — they lose nothing by
 * being refused, and come straight back. Backoff changes the economics: each
 * time a source earns another strike its ban doubles, so a persistent source
 * spends most of its time banned while a client that misbehaves once is
 * inconvenienced for a minute.
 *
 * Strikes decay after a clean spell, so a bad afternoon does not follow a
 * client forever — without that, the ceiling is permanent and the first
 * mistake is unforgivable.
 *
 * Memory is bounded for the same reason the rate limiter's is: the key space
 * is attacker-controlled, so an unbounded map is the vulnerability rather than
 * the mitigation.
 */
export function createBanList({
  baseMs = 60_000,
  factor = 2,
  maxMs = 24 * 60 * 60 * 1000,
  forgetMs = 60 * 60 * 1000,
  maxClients = 10_000,
  now = () => Date.now(),
} = {}) {
  const records = new Map();

  const touch = (key, record) => {
    records.delete(key);
    if (records.size >= maxClients) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    records.set(key, record);
  };

  return {
    /** Record an offence and return the ban it earned. */
    strike(key) {
      const at = now();
      const previous = records.get(key);
      // A long clean spell wipes the slate; otherwise the count carries.
      const strikes = previous && at - previous.at < forgetMs ? previous.strikes + 1 : 1;
      const banMs = Math.min(maxMs, baseMs * factor ** (strikes - 1));
      const record = { strikes, at, until: at + banMs };
      touch(key, record);
      return { strikes, banMs, until: record.until };
    },

    /** Is this source currently serving a ban? */
    banned(key) {
      const record = records.get(key);
      return Boolean(record) && now() < record.until;
    },

    get size() {
      return records.size;
    },
  };
}

/**
 * Per-source token bucket.
 *
 * The bucket map is itself an attack surface and that is the part worth being
 * careful about: keyed by source address, with spoofed sources, an unbounded
 * map is a memory exhaustion bug wearing a rate limiter's clothes. So entries
 * are capped and the least recently seen are dropped when full — evicting a
 * legitimate client costs it one refilled bucket, while not evicting costs the
 * process.
 */
export function createRateLimiter({
  perSecond = 20,
  burst = 40,
  maxClients = 10_000,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();

  return {
    /** True when this source may be answered. */
    allow(key) {
      const at = now();
      let bucket = buckets.get(key);
      if (bucket) {
        // Refill for elapsed time, capped at the burst ceiling.
        bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 1000) * perSecond);
        bucket.at = at;
        // Re-inserting moves it to the end, which is what makes the Map's
        // insertion order usable as a least-recently-seen list.
        buckets.delete(key);
      } else {
        bucket = { tokens: burst, at };
        if (buckets.size >= maxClients) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      buckets.set(key, bucket);

      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    get size() {
      return buckets.size;
    },
  };
}

/**
 * Hold a UDP answer to a size, truncating rather than sending a huge datagram.
 *
 * Amplification is a ratio, so the ceiling on an answer is the ceiling on the
 * attack. A truncated answer sets TC, which tells a real client to ask again
 * over TCP — where the handshake makes a spoofed source address useless. So the
 * legitimate case is a retry and the abusive case is a dead end, which is the
 * asymmetry worth having.
 */
export function capResponse(reply, query, limit = 512) {
  if (!Buffer.isBuffer(reply) || reply.length <= limit) return reply;
  const header = reply.subarray(0, 12);
  const truncated = Buffer.from(header);
  truncated.writeUInt16BE(reply.readUInt16BE(2) | 0x0200, 2); // TC
  truncated.writeUInt16BE(0, 6); // no answers survive the cut
  truncated.writeUInt16BE(0, 8);
  truncated.writeUInt16BE(0, 10);
  return Buffer.concat([truncated, reply.subarray(12, query.questionEnd)]);
}

/**
 * Send a query to an upstream nameserver and hand back its answer verbatim.
 *
 * Deliberately a byte proxy rather than a parse-and-rebuild. We forward
 * question types this bridge has no opinion about — SVCB, SRV, DNSKEY,
 * whatever arrives — and re-encoding them would mean implementing the whole
 * record space correctly to avoid corrupting answers we only need to relay.
 */
export function forwardQuery(msg, upstream, { timeoutMs = 3000 } = {}) {
  const [address, portText] = String(upstream).split("#");
  const port = Number(portText) || 53;
  return new Promise((resolve) => {
    const socket = dgram.createSocket(isIP(address) === 6 ? "udp6" : "udp4");
    let settled = false;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.on("message", (reply) => { clearTimeout(timer); finish(reply); });
    socket.on("error", () => { clearTimeout(timer); finish(null); });
    try {
      socket.send(msg, port, address);
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * Is this a name we are authoritative for?
 *
 * The gate that makes catch-all routing safe. With `Domains=~.` every lookup
 * on the machine arrives here, and `google.com` is two labels exactly like
 * `blue.eggs` is — so parsing alone would have us answer for the clearnet.
 * Only an ending someone has actually claimed is ours; everything else is
 * forwarded untouched.
 *
 * An unknown ending set means "not ours" rather than "ours". Failing that way
 * round costs a Moshpit name that does not resolve until the registry answers
 * again; the other way round costs the whole internet on that machine.
 */
export function isOurs(name, tldSet) {
  if (!(tldSet instanceof Set) || tldSet.size === 0) return false;
  const parsed = parseRegistryName(name);
  return Boolean(parsed) && tldSet.has(parsed.tld);
}

export function createServer(options = {}) {
  const {
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    ttl = DEFAULT_TTL,
    onQuery = () => {},
    onError = () => {},
    // Empty by default, which keeps the old behaviour exactly: with no
    // upstreams there is nothing to forward to, so the bridge stays the
    // narrow per-ending resolver it has always been and answers only for
    // names it is authoritative for.
    upstreams = [],
    tldSet = null,
    forwardTimeoutMs = 3000,
    // Off by default: a loopback bridge has one client and rate limiting it is
    // pure cost. These matter when the socket is reachable by strangers, which
    // is a deployment choice rather than a default.
    rateLimit = null,
    maxResponseBytes = 0,
    // Banning is layered on the rate limit rather than replacing it: the limit
    // decides what an offence is, the ban decides how long it costs.
    ban = null,
  } = options;
  const limiter = rateLimit ? createRateLimiter(rateLimit) : null;
  const bans = ban ? createBanList(ban) : null;
  // The socket family follows the address we were asked to bind, so the caller
  // decides by choosing a host rather than by passing a flag.
  //
  // `ipv6Only: false` is what makes `::` serve both families from one socket:
  // the kernel accepts IPv4 clients on it and reports them as `::ffff:1.2.3.4`,
  // which `socket.send` understands, so the reply path needs no special case.
  // Without it a v6 bind is v6-only and every IPv4 client silently gets nothing.
  //
  // The default stays 127.0.0.1, so a machine that upgrades keeps exactly the
  // loopback-only v4 listener it had. Serving other hosts is a deliberate act.
  const socket = isIP(host) === 6
    ? dgram.createSocket({ type: "udp6", ipv6Only: false, reuseAddr: true })
    : dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", async (msg, rinfo) => {
    const query = parseQuery(msg);
    if (!query) return; // malformed, or a response — say nothing at all

    // REFUSED rather than silence, for both guards below. A dropped packet
    // costs a real client a full resolver timeout before it tries elsewhere,
    // and costs an attacker nothing — they were not waiting for the answer.
    const refuse = () => {
      try {
        socket.send(
          Buffer.concat([
            header(query.id, { rcode: RCODE_REFUSED, answers: 0, recursionDesired: query.recursionDesired }),
            msg.subarray(12, query.questionEnd),
          ]),
          rinfo.port,
          rinfo.address,
        );
      } catch { /* client vanished */ }
    };

    const refusal = refusalReason(query);
    if (refusal) {
      onQuery({ name: query.name, type: query.type, address: null, refused: refusal });
      return refuse();
    }
    // Grouped by /64 for v6, so moving within a prefix does not shake a ban.
    const source = clientKey(rinfo.address);

    if (bans?.banned(source)) {
      onQuery({ name: query.name, type: query.type, address: null, refused: "banned" });
      return refuse();
    }
    if (limiter && !limiter.allow(source)) {
      const earned = bans?.strike(source);
      onQuery({
        name: query.name,
        type: query.type,
        address: null,
        refused: earned ? `banned ${Math.round(earned.banMs / 1000)}s (strike ${earned.strikes})` : "rate limit",
      });
      return refuse();
    }

    // Catch-all routing puts every lookup on the machine through here. Anything
    // that is not an ending someone has claimed belongs to the ordinary
    // internet and is relayed byte for byte, including question types this
    // bridge has no opinion about.
    if (upstreams.length && !isOurs(query.name, tldSet)) {
      let relayed = null;
      for (const upstream of upstreams) {
        relayed = await forwardQuery(msg, upstream, { timeoutMs: forwardTimeoutMs });
        if (relayed) break;
      }
      onQuery({ name: query.name, type: query.type, address: null, forwarded: true });
      try {
        // SERVFAIL, not NXDOMAIN, when every upstream is silent: "I could not
        // find out" is retried elsewhere, "it does not exist" gets cached and
        // the name stays broken after the network comes back.
        socket.send(
          relayed
            ? (maxResponseBytes ? capResponse(relayed, query, maxResponseBytes) : relayed)
            : Buffer.concat([
            header(query.id, { rcode: RCODE_SERVFAIL, answers: 0, recursionDesired: query.recursionDesired }),
            msg.subarray(12, query.questionEnd),
          ]),
          rinfo.port,
          rinfo.address,
        );
      } catch {
        /* client vanished */
      }
      return;
    }

    let address = null;
    let exists = false;
    let reply = null;

    // Three shapes of question now. CNAME, MX and TXT are answered from the
    // record set; addresses are answered from `target` as they always have
    // been; everything else (HTTPS/SVCB and the rest) still gets an honest
    // empty NOERROR rather than a lie — a browser asks HTTPS beside every A and
    // AAAA, and NXDOMAIN to that one denies the name for the whole page load.
    const wanted = query.class === CLASS_IN ? RECORD_TYPES.get(query.type) : null;
    if (wanted) {
      const found = await answerRecords(query.name, { ...options, type: wanted }).catch(() => null);
      exists = Boolean(found?.exists);
      reply = buildRecordResponse(query, msg, found?.records || [], {
        ttl, exists, limit: maxResponseBytes || UDP_SAFE_BYTES,
      });
    } else if (query.class === CLASS_IN) {
      const wantsAddress = query.type === TYPE_A || query.type === TYPE_AAAA;
      const policy = await answerPolicy(query.name, { ...options, wantsAddress }).catch(() => null);
      if (policy) ({ exists, address } = policy);
      // A name that is here with no address to give may still have published a
      // CNAME, which is the one record that can answer an address question.
      // Handing it back lets the client chase the name through its own
      // resolver — the only party here that may do clearnet DNS — instead of
      // getting the NODATA that made a pointed name look broken.
      if (wantsAddress && mayHaveCname(policy || {})) {
        const found = await answerRecords(query.name, { ...options, type: "CNAME" }).catch(() => null);
        if (found?.records?.length) {
          reply = buildRecordResponse(query, msg, found.records, {
            ttl, exists, limit: maxResponseBytes || UDP_SAFE_BYTES,
          });
        }
      }
    }
    onQuery({ name: query.name, type: query.type, address });
    try {
      socket.send(reply || buildResponse(query, msg, address, ttl, exists), rinfo.port, rinfo.address);
    } catch {
      /* client vanished — nothing useful to do */
    }
  });

  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => {
      // The rejector belongs to the bind and only to the bind. Left attached it
      // stays the socket's one error listener for the life of the resolver, so
      // the first error after bind called reject() on an already-settled
      // promise — swallowed, no line logged, while onQuery logs every ordinary
      // query — and the second found no listener at all and took the process
      // down. `dns start` runs in the foreground until Ctrl-C, so that is the
      // one command whose whole job is to stay up. The sibling parking server
      // already drops its rejector this way (parking-http.mjs).
      socket.removeListener("error", reject);
      // Removing it is not enough on its own: with no listener the *first*
      // error would now be the fatal one. A resolver outlives the transient
      // failures of the interface underneath it, so report and keep serving.
      socket.on("error", (err) => onError(err));
      const addr = socket.address();
      resolve({
        port: addr.port,
        address: addr.address,
        close: () => new Promise((done) => socket.close(done)),
      });
    });
  });
}

/* ------------------------------------------------------- system integration */

/**
 * Does the bridge on this port actually forward what is not ours?
 *
 * The question that matters before writing catch-all routing, and the one the
 * previous check never asked. It verified that upstreams were discoverable —
 * a fact about the machine — and inferred from that the bridge would forward.
 * On a box where the bridge is the only global nameserver, that inference is
 * the difference between "Moshpit names do not resolve" and "nothing does".
 *
 * `dns enable` writes the routing config before starting the bridge, and a
 * bridge already listening is left alone with "bridge already running" — so an
 * older build, or one started without upstreams, keeps the port while the new
 * routing sends it every lookup on the machine. That is exactly how a desktop
 * loses DNS.
 *
 * The probe name has three labels on purpose. A two-label name is a Moshpit
 * name to any build: an older bridge answers it with the parking address, an
 * answer, which would read as working forwarding. Three labels cannot be a
 * Moshpit name, so only a bridge that forwards can produce an answer at all.
 */
export const CLEARNET_PROBE = "pit.moshcode.sh";

export function probeForwarding({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  name = CLEARNET_PROBE,
  timeoutMs = 2000,
} = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(isIP(host) === 6 ? "udp6" : "udp4");
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closing */ }
      resolve(answer);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    socket.on("message", (reply) => {
      clearTimeout(timer);
      // An answer at all is the signal: rcode 0 with at least one record.
      const ok = reply.length > 12
        && (reply.readUInt16BE(2) & 0x000f) === 0
        && reply.readUInt16BE(6) > 0;
      finish(ok);
    });
    socket.on("error", () => { clearTimeout(timer); finish(false); });

    const head = Buffer.alloc(12);
    head.writeUInt16BE(0x7e57, 0);
    head.writeUInt16BE(0x0100, 2);
    head.writeUInt16BE(1, 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(TYPE_A, 0);
    tail.writeUInt16BE(CLASS_IN, 2);
    try {
      socket.send(Buffer.concat([head, encodeName(name), tail]), port, host);
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

/**
 * Whether catch-all routing is safe to write right now.
 *
 * Two conditions, and both are about this machine at this moment rather than
 * about the build that is installed:
 *
 *   - upstreams exist to forward to, and
 *   - either no bridge holds the port (so `dns enable` starts ours, which
 *     forwards), or the one holding it demonstrably forwards.
 *
 * Anything else falls back to per-ending routing. That routing is worse — it
 * truncates, silently — but its worst case is Moshpit names not resolving,
 * where catch-all against a bridge that cannot forward takes the machine off
 * the internet. Between a feature that does not work and a desktop that cannot
 * reach anything, the choice is not close.
 */
export async function catchAllSafety({ host = DEFAULT_HOST, port = DEFAULT_PORT, probe = probeForwarding } = {}) {
  const upstreams = await discoverUpstreams();
  if (!upstreams.length) {
    return { safe: false, upstreams, why: "no upstream nameservers found to forward to" };
  }
  if (await probe({ host, port, name: CLEARNET_PROBE })) {
    return { safe: true, upstreams, why: "the running bridge forwards" };
  }
  // Nothing listening is fine: enable starts ours next, and ours forwards.
  const held = await probe({ host, port, name: "a.eggs" });
  if (!held) return { safe: true, upstreams, why: "no bridge is running yet — this one will be ours" };

  return {
    safe: false,
    upstreams,
    why: "a bridge is already running on this port and does not forward — stop it first, then re-run",
  };
}

/**
 * The upstreams this machine was using before we touched anything.
 *
 * Read once, before routing is switched, because afterwards resolv.conf may
 * point at us and the real servers are no longer discoverable from it. An
 * empty result is the signal to leave routing per-ending: catch-all with
 * nowhere to forward is every lookup on the box failing, not just Moshpit ones.
 */
export const UPSTREAM_SOURCES = [
  // systemd-resolved's own uplink file, and the only one with real servers in
  // it on a systemd machine. /etc/resolv.conf there is a stub pointing at
  // 127.0.0.53 — which this drops as loopback, correctly, and which left
  // discovery empty on exactly the platform catch-all routing was built for.
  // The fallback to per-ending routing kept those machines safe and kept the
  // feature permanently out of reach; reading only /etc/resolv.conf was the bug.
  "/run/systemd/resolve/resolv.conf",
  "/etc/resolv.conf",
];

export async function discoverUpstreams(readImpl) {
  const read = readImpl || (async (path) => {
    const { readFile } = await import("node:fs/promises");
    return readFile(path, "utf8");
  });

  for (const source of UPSTREAM_SOURCES) {
    const found = parseUpstreams(await read(source).catch(() => ""));
    // First file with a non-loopback server wins. A stub resolv.conf yields
    // nothing and we move on rather than concluding there are no upstreams.
    if (found.length) return found;
  }
  return [];
}

/**
 * The routing suffixes the resolver actually accepted.
 *
 * Not the same question as what we wrote, which is the whole point. Writing a
 * config is not the same as the resolver honouring it, and systemd-resolved
 * caps how many search domains it will take: handed 4586 it accepted 1090
 * alphabetically, rejected the rest one journal line at a time with "Argument
 * list too long", and reported success. Status compared what it had written
 * against what the registry claimed, saw the same number twice, and said
 * everything was fine while 76% of endings did not resolve.
 *
 * So this asks the resolver instead of the file.
 */
export function parseResolvectlDomains(text) {
  const seen = new Set();
  for (const match of String(text ?? "").matchAll(/~([a-z0-9-]+)/gi)) {
    seen.add(match[1].toLowerCase());
  }
  return [...seen];
}

/**
 * What routing the running resolver has, or null when we cannot ask it.
 *
 * Null is "unknown", never "none": a machine using dnsmasq, or not systemd at
 * all, has no resolvectl and must not be told its routing is missing.
 */
export async function acceptedDomains(runner) {
  const run = runner || (async () => {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile("resolvectl", ["domain"], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? null : String(stdout)));
    });
  });
  const output = await run().catch(() => null);
  return output === null || output === undefined ? null : parseResolvectlDomains(output);
}

/**
 * Whether the resolver kept everything it was given, and what it dropped.
 *
 * `missing` is capped in what callers print, not here — the whole list is the
 * evidence, and an ending that is absent is exactly the thing someone is
 * searching the output for.
 */
export function routingShortfall(written, accepted) {
  if (!Array.isArray(accepted)) return null;
  const have = new Set(accepted);
  const missing = written.filter((tld) => !have.has(tld));
  return { written: written.length, accepted: accepted.length, missing };
}

/**
 * systemd-resolved drop-in routing just the Moshpit TLDs at the bridge.
 *
 * `~tld` is a routing-only domain: it sends queries for that suffix here
 * without making this resolver the default for anything else on the machine.
 */
/* ------------------------------------------------- catch-all routing */

/**
 * Route every lookup here, instead of naming each claimed ending.
 *
 * The per-ending form does not scale and fails silently when it stops. Listing
 * 4586 endings on one `Domains=` line made systemd-resolved take them
 * alphabetically until it hit its own cap, reject the remaining 3496 with
 * "Argument list too long" one line at a time in the journal, and report
 * success. Names past the cut were configured on disk and absent from the
 * resolver, so `moshcode dns resolve` answered and `curl` did not — with
 * nothing in between to say why. Every new ending anyone claims makes that
 * worse.
 *
 * `~.` is one entry that never grows. The cost is that this bridge now sees
 * every lookup on the machine, so it has to be a resolver rather than an
 * oracle: anything that is not a claimed Moshpit name is forwarded upstream
 * untouched, and any failure forwards too. Breaking DNS for the whole box is a
 * far worse outcome than failing to resolve a Moshpit name.
 */
export function resolvedCatchAllConf({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return [
    "# Written by `moshcode dns install`. Sends every lookup to the local",
    "# bridge, which answers Moshpit endings and forwards the rest upstream.",
    "#",
    "# Routing each ending by name instead does not survive the registry",
    "# growing: systemd-resolved caps how many search domains it accepts and",
    "# drops the rest with no error a caller can see.",
    "[Resolve]",
    `DNS=${host}:${port}`,
    "Domains=~.",
    "",
  ].join("\n");
}

/** The dnsmasq equivalent: one upstream for everything. */
export function dnsmasqCatchAllConf({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return [
    "# Written by `moshcode dns install`.",
    "# no-resolv so dnsmasq does not also inherit the upstreams from",
    "# /etc/resolv.conf, which on a machine running this bridge may point back",
    "# here and loop.",
    "no-resolv",
    `server=${host}#${port}`,
    "",
  ].join("\n");
}

/**
 * The machine's real nameservers, for the bridge to forward to.
 *
 * Loopback entries are dropped: once routing points at this bridge, whatever
 * wrote 127.0.0.53 into resolv.conf is the thing sending us the query, and
 * forwarding back to it is a loop that ends in a timeout rather than an answer.
 */
export function parseUpstreams(resolvConf) {
  const out = [];
  for (const line of String(resolvConf ?? "").split("\n")) {
    const m = line.match(/^\s*nameserver\s+(\S+)/i);
    if (!m) continue;
    const address = m[1].replace(/%.*$/, "");
    if (!isIP(address)) continue;
    if (/^127\./.test(address) || address === "::1") continue;
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

export function resolvedConf(tlds, { host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return [
    "# Written by `moshcode dns install`. Routes Moshpit TLDs to the local",
    "# bridge; every other name keeps using your normal resolver.",
    "[Resolve]",
    `DNS=${host}:${port}`,
    `Domains=${tlds.map((t) => `~${t}`).join(" ")}`,
    "",
  ].join("\n");
}

/** The dnsmasq equivalent, for machines not running systemd-resolved. */
export function dnsmasqConf(tlds, { host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return [
    "# Written by `moshcode dns install`.",
    ...tlds.map((t) => `server=/${t}/${host}#${port}`),
    "",
  ].join("\n");
}

/* --------------------------------------- switching DNS without breaking DNS */

// `dns enable` repoints every lookup on the machine. Four phases, in this
// order, because each one exists for a way the previous arrangement failed on a
// real box: refuse when the machine is already in a state where the switch
// cannot work, keep what was there before touching it, prove the machine can
// still resolve afterwards, and put it back when the proof fails. The last one
// is the load-bearing one — without it `enable` can leave a desktop with no
// resolver at all, and no working DNS with which to look up how to fix it.

export const RESOLVED_DROPIN_DIR = "/etc/systemd/resolved.conf.d";
export const MOSHPIT_DROPIN = `${RESOLVED_DROPIN_DIR}/moshpit.conf`;

/**
 * The suffix every backup written here gets, and why it is not `.conf`.
 *
 * systemd-resolved globs `*.conf` in the drop-in directory, so `moshpit.bak.conf`
 * would be a *second* file setting `DNS=` — the exact state the preflight below
 * refuses to run into. A suffix that sorts outside the glob is inert. macOS has
 * the same shape of problem for a different reason: it reads /etc/resolver by
 * filename, so a backup there routes a domain nobody will ever ask for.
 */
export const BACKUP_SUFFIX = ".moshcode-backup";

export function backupPath(path) {
  return `${path}${BACKUP_SUFFIX}`;
}

/**
 * The nameservers a resolved drop-in sets, if any.
 *
 * `DNS=` with an empty value is systemd's reset — it clears what earlier
 * drop-ins assigned rather than adding a server — so it is not a conflict and
 * must not read as one. Commented-out lines are not matched at all: `^\s*DNS`
 * cannot start with `#`.
 */
export function dropinNameservers(content) {
  const out = [];
  for (const line of String(content ?? "").split("\n")) {
    const m = line.match(/^\s*DNS\s*=\s*(\S.*?)\s*$/i);
    if (m) out.push(...m[1].split(/\s+/));
  }
  return out;
}

/**
 * Any drop-in other than ours that names a nameserver.
 *
 * Two files each setting `DNS=` do not compete — systemd-resolved appends them
 * into one global list and rotates between them, and having rotated away from a
 * server that failed it never rotates back. So a single restart of the bridge
 * moves every query on the machine to the other server, permanently. That
 * server answers NXDOMAIN for every Moshpit name, which means DNS looks
 * completely healthy while the entire namespace this command exists to serve is
 * dead, with nothing anywhere reporting a failure.
 *
 * A DigitalOcean.conf left by the cloud image did this three times in one
 * afternoon and was misdiagnosed as a bridge bug each time. Guessing which
 * server should win is not this command's call to make, so it names the file
 * and stops.
 *
 * `duplicate` is the exception, and it is common: a drop-in naming only the
 * bridge we are about to point at is not a second server, because there is
 * nothing for the resolver to rotate to. Blocking on it would refuse to run on
 * every machine an earlier installer set up by hand. It is still a second file
 * that `dns disable` will not remove, which is worth saying and not worth
 * stopping for.
 */
export function conflictingDropins(files, { ours = "moshpit.conf", bridge = null } = {}) {
  const out = [];
  for (const file of files || []) {
    const name = String(file?.name ?? "");
    if (name === ours || !name.endsWith(".conf")) continue;
    const servers = dropinNameservers(file.content);
    if (!servers.length) continue;
    out.push({ name, servers, duplicate: Boolean(bridge) && servers.every((s) => s === bridge) });
  }
  return out;
}

export async function readDropins({ dir = RESOLVED_DROPIN_DIR, readdir, read } = {}) {
  const list = readdir || (async (d) => {
    const { readdir: rd } = await import("node:fs/promises");
    return rd(d);
  });
  const readOne = read || (async (p) => {
    const { readFile: rf } = await import("node:fs/promises");
    return rf(p, "utf8");
  });
  // A missing directory is a machine that does not use resolved drop-ins, not
  // an error worth stopping an enable over.
  const names = await list(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    if (!String(name).endsWith(".conf")) continue;
    files.push({ name: String(name), content: await readOne(`${dir}/${name}`).catch(() => "") });
  }
  return files;
}

/**
 * UDP sockets that are listening, as `ss -lnup` sees them.
 *
 * The process column only carries an owner when the caller can see it; `enable`
 * runs as root, so on the run that matters the pid is there. Parsed rather than
 * grepped because the pid is the only thing that distinguishes our own bridge
 * from a stranger holding the same port.
 */
export function parseUdpListeners(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const m = fields[3].match(/^(.*):(\d+)$/);
    if (!m) continue;
    const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    out.push({
      address: m[1].replace(/^\[/, "").replace(/\]$/, ""),
      port: Number(m[2]),
      pid: owner ? Number(owner[2]) : null,
      process: owner ? owner[1] : null,
    });
  }
  return out;
}

const defaultUdpListeners = async () => {
  const { execFile } = await import("node:child_process");
  const text = await new Promise((resolve) => {
    execFile("ss", ["-lnup"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
  return parseUdpListeners(text);
};

/**
 * Someone else on the bridge's port.
 *
 * A stale bridge from an older build is the case this is for, and it wins two
 * different ways depending on how each side bound. Bound to the same address we
 * want, it takes the port and ours cannot bind at all — and `startDaemon`
 * spawns detached with stdio ignored, so that bind failure is invisible and
 * `enable` still prints "bridge started". Bound to 127.0.0.1 while ours holds
 * 0.0.0.0, the kernel delivers to the more specific socket, so ours is running,
 * healthy and receiving nothing. Either way the routing we just wrote points
 * every lookup on the machine at a process we did not start, which answers
 * NOERROR with zero answers and eats the query.
 *
 * That took DNS down twice in one day. `catchAllSafety` cannot see it: it
 * probes the port and gets an answer either way.
 *
 * A holder whose pid matches the bridge we already recorded is ours and fine.
 * An unattributable holder — no pid visible — is only accepted when a bridge of
 * ours is recorded as running, because then it is very likely that same one;
 * with nothing of ours running there is no reading under which it is ours.
 */
export function portHolder(listeners, { host = DEFAULT_HOST, port = DEFAULT_PORT, ourPid = null } = {}) {
  const wildcards = new Set(["0.0.0.0", "::", "*"]);
  for (const l of listeners || []) {
    if (l.port !== port) continue;
    if (l.address !== host && !wildcards.has(l.address)) continue;
    if (ourPid && l.pid === ourPid) continue;
    if (!l.pid && ourPid) continue;
    return l;
  }
  return null;
}

/**
 * Everything that has to be true of the machine before the routing is written.
 *
 * Both checks refuse rather than guess. The states they find are ones where
 * writing the config produces a machine that reports success and cannot
 * resolve, which is strictly worse than not running at all — so the answer is a
 * named file, a named pid, and a stop.
 */
export async function preflightEnable({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  ourPid = null,
  // Only meaningful for the systemd-resolved backend. A dnsmasq machine may
  // carry a resolved.conf.d it does not use, and blocking on it would be a
  // refusal over a file that has no effect on anything.
  checkDropins = true,
  dropins = readDropins,
  listeners = defaultUdpListeners,
  forwards = probeForwarding,
} = {}) {
  const blockers = [];

  const dropinFiles = checkDropins ? conflictingDropins(await dropins(), { bridge: `${host}:${port}` }) : [];
  const duplicates = dropinFiles.filter((f) => f.duplicate);
  const conflicts = dropinFiles.filter((f) => !f.duplicate);
  for (const c of conflicts) {
    blockers.push({
      kind: "conflicting-dropin",
      lines: [
        `${RESOLVED_DROPIN_DIR}/${c.name} also sets DNS= (${c.servers.join(" ")})`,
        "  systemd-resolved appends both into one list and rotates between them, and never",
        "  rotates back to a server that failed — so one bridge restart sends every lookup",
        "  on this machine to that server for good. It answers NXDOMAIN for Moshpit names,",
        "  so nothing looks broken and the whole namespace is gone.",
        `  Move it aside, or re-run with --force to accept that.`,
      ],
    });
  }

  // Owning the port is not the offence — eating queries is. A bridge someone
  // started by hand holds the port with no pidfile to prove it is ours, and it
  // is perfectly good; refusing on identity alone would make --force the normal
  // way to run this command, which is how a safety check stops being one. So
  // the holder is asked the same clearnet question `catchAllSafety` asks, and
  // only a holder that cannot answer it is a blocker.
  const holder = portHolder(await listeners().catch(() => []), { host, port, ourPid });
  const holderForwards = holder ? await forwards({ host, port, name: CLEARNET_PROBE }).catch(() => false) : false;
  if (holder && !holderForwards) {
    const who = holder.pid ? `pid ${holder.pid}${holder.process ? ` (${holder.process})` : ""}` : "owner not visible";
    blockers.push({
      kind: "port-holder",
      lines: [
        `something is already listening on ${holder.address}:${holder.port} and does not forward — ${who}`,
        "  it is not the bridge this command started, and the routing below would hand it",
        "  every lookup on the machine. A stale bridge answers NOERROR with no answers,",
        "  which is indistinguishable from working DNS until nothing resolves.",
        `  Stop it (kill ${holder.pid || "<pid>"}), or re-run with --force to accept that.`,
      ],
    });
  }

  return { ok: blockers.length === 0, blockers, conflicts, duplicates, holder, holderForwards };
}

const defaultSleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/**
 * Does this machine still resolve?
 *
 * Two names, and both must answer. The Moshpit one proves the bridge is
 * reachable through the routing that was just written; the clearnet one proves
 * it is *forwarding* rather than swallowing, and that is the check that matters
 * — its failure is what "you broke my DNS" means to the person whose machine it
 * is. A run that only checked Moshpit names would call a box that cannot reach
 * the internet a success.
 *
 * Resolution goes through the system resolver rather than straight at the
 * bridge, deliberately: the bridge answering on 5354 is not the claim being
 * made. The claim is that a normal lookup on this machine works.
 *
 * Retried because systemd-resolved takes a moment to be ready after a restart,
 * and a rollback triggered by that gap would undo a switch that was fine.
 */
export async function verifyResolution({
  moshpit = null,
  clearnet = CLEARNET_PROBE,
  resolve = (name) => dnsPromises.resolve4(name),
  attempts = 4,
  delayMs = 400,
  sleep = defaultSleep,
} = {}) {
  const wanted = [
    ...(moshpit ? [{ name: moshpit, kind: "moshpit" }] : []),
    { name: clearnet, kind: "clearnet" },
  ];
  const checks = [];
  for (const { name, kind } of wanted) {
    let ok = false;
    let error = "no answer";
    for (let attempt = 0; attempt < attempts && !ok; attempt++) {
      if (attempt) await sleep(delayMs);
      try {
        const answers = await resolve(name);
        // An empty answer counts as failure. NOERROR with no records is exactly
        // what a resolver that has swallowed the query returns, and treating it
        // as success is how the silent version of this outage stayed silent.
        ok = Array.isArray(answers) ? answers.length > 0 : Boolean(answers);
        if (!ok) error = "answered, with no records";
      } catch (err) {
        error = err?.code || err?.message || String(err);
      }
    }
    checks.push({ name, kind, ok, error: ok ? null : error });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

const defaultReadMaybe = async (path) => {
  const { readFile: rf } = await import("node:fs/promises");
  return rf(path, "utf8").catch(() => null);
};

/**
 * Apply a routing plan, prove it worked, and put the machine back if it did not.
 *
 * The contents of every file the plan overwrites are read first and held, and
 * also copied to disk next to the original — in memory is what the rollback
 * uses, on disk is what is left for a person to find if this process is killed
 * between the write and the restart. A failed backup copy is therefore reported
 * and not fatal; the rollback does not depend on it.
 *
 * A failed *apply* rolls back for the same reason a failed verification does.
 * Half-written routing is the state this whole function exists to make
 * impossible, and "some steps failed, good luck" was the previous answer to it.
 *
 * Restoring the files is not enough on its own — the resolver read them at
 * start — so the plan's own `run` steps are replayed afterwards. Windows writes
 * no files and undoes its NRPT rules with different commands entirely, which is
 * why the caller can hand in its own `rollbackSteps`.
 */
export async function applyWithRollback(plan, {
  apply = applyPlan,
  runner,
  read = defaultReadMaybe,
  verify = async () => ({ ok: true, checks: [] }),
  rollbackSteps = plan.steps.filter((s) => s.kind === "run"),
} = {}) {
  const opts = runner ? { runner } : {};
  const targets = plan.steps.filter((s) => s.kind === "write").map((s) => s.path);
  const before = new Map();
  for (const path of targets) before.set(path, await read(path));

  const backups = targets
    .filter((path) => before.get(path) !== null && before.get(path) !== undefined)
    .map((path) => ({
      kind: "write",
      path: backupPath(path),
      content: before.get(path),
      why: `keep the previous ${path} until this run is known to have worked`,
    }));
  const saved = backups.length ? await apply({ steps: backups }, opts) : { ok: true, results: [] };

  const applied = await apply(plan, opts);
  const verified = applied.ok
    ? await verify()
    : { ok: false, checks: [], skipped: "not attempted — the routing was not fully applied" };

  if (verified.ok) {
    // Nothing left to protect, and a stray backup in a config directory is its
    // own hazard on both of the platforms this writes to.
    if (backups.length) await apply({ steps: backups.map((b) => ({ kind: "remove", path: b.path, why: "the run succeeded" })) }, opts);
    return { saved, applied, verified, rolledBack: null, backups: [] };
  }

  const restores = targets.map((path) => (before.get(path) === null || before.get(path) === undefined
    ? { kind: "remove", path, why: "there was no file here before this run" }
    : { kind: "write", path, content: before.get(path), why: "put back what was here before this run" }));
  const rolledBack = await apply({ steps: [...restores, ...rollbackSteps] }, opts);

  // Kept when the rollback itself failed: then the backup is the only copy of
  // the machine's previous configuration, and its path is worth printing.
  if (rolledBack.ok && backups.length) {
    await apply({ steps: backups.map((b) => ({ kind: "remove", path: b.path, why: "the original is back in place" })) }, opts);
  }
  return { saved, applied, verified, rolledBack, backups: rolledBack.ok ? [] : backups.map((b) => b.path) };
}

/* ----------------------------------------------------------------- the verb */

import { promises as dnsPromises } from "node:dns";
import { canOpenBrowser, openBrowser } from "./open-url.mjs";
import { createParkingServer, DEFAULT_PARKING_HTTP_PORT } from "./parking-http.mjs";
// Re-exported: the Pit URL moved to its own module so the parking responder can
// use it without importing this one back.
export { pitNameUrl } from "./pit-url.mjs";
import { pitNameUrl } from "./pit-url.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyPlan, daemonStatus, describePlan, detectPlatform, disablePlan, enablePlan,
  requiredPort, startDaemon, stopDaemon,
} from "./dns-system.mjs";

/** The parking host's address — an A record has to carry an IP, not a name. */
export async function parkingAddress(host = DEFAULT_PARKING_HOST, lookup = dnsPromises.resolve4) {
  try {
    const [ip] = await lookup(host);
    return ip || null;
  } catch {
    return null;
  }
}

const USAGE = `moshcode dns — resolve Moshpit names on this machine

  moshcode dns enable            run the bridge and route Moshpit TLDs to it
  moshcode dns disable           stop it and remove the routing
  moshcode dns status            what is running, what is routed, does it work

  moshcode dns tlds              list the TLDs claimed in the Pit
  moshcode dns resolve <name>    show what a name resolves to, and why
  moshcode dns resolve <name> [--open] [--json]
                                 look a name up; --open opens a parked name in the Pit
                                 --json prints one stable document for scripts
  moshcode dns start [--port N]  run the resolver in the foreground
                                 also serves parked names over HTTP so \`curl <name>\`
                                 lands on the Pit; --parking-port N, --no-parking-http
  moshcode dns install [--write] print the resolver config without applying it

  --dry-run    with enable/disable: print exactly what would be done
  --force      with enable: proceed past a preflight refusal (a second drop-in
               setting DNS=, or a stranger already on the bridge's port)
  --backend    linux only: systemd-resolved (default) or dnsmasq
  --port N     the bridge's port (Windows must use 53 — NRPT carries no port)

The registry speaks HTTP, not DNS, so nothing outside a browser can reach a
Moshpit name until this bridge is running and your resolver points at it.
\`enable\` edits system DNS and needs root (Administrator on Windows). It refuses
to start from a machine where the switch cannot work, keeps a copy of whatever
it overwrites, checks that both a Moshpit name and a clearnet name still resolve
afterwards, and puts everything back if either one does not.`;

function resolveArgument(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--registry" || arg === "--port") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--registry=") || arg.startsWith("--port=") || arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

export async function dnsCommand(args = [], out = console.log, deps = {}) {
  const {
    // Injected so the decision logic in `enable` — refuse, apply, verify, roll
    // back — is testable without a resolver, a root shell or a machine whose
    // DNS is a real thing to break.
    tlds: fetchTldsImpl = fetchTlds,
    safety: catchAllSafetyImpl = catchAllSafety,
    preflight = preflightEnable,
    applyWith = applyWithRollback,
    verify = verifyResolution,
    bridgeStatus = daemonStatus,
    startBridge = startDaemon,
    stopBridge = stopDaemon,
    uid = typeof process.getuid === "function" ? process.getuid() : 0,
  } = deps;
  const [sub, ...rest] = args;
  const flag = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
  };
  const registryBase = flag("registry", DEFAULT_REGISTRY_BASE);

  if (!sub || sub === "help" || sub === "--help") {
    out(USAGE);
    return 0;
  }

  const portIndex = rest.indexOf("--port");
  const rawPort = portIndex >= 0 ? rest[portIndex + 1] : DEFAULT_PORT;
  const port = parseDnsPort(rawPort);
  if (port === null) {
    out(`--port needs a decimal integer from 1 to 65535, got ${JSON.stringify(rawPort)}`);
    return 1;
  }

  if (sub === "tlds") {
    const tlds = await fetchTlds({ registryBase });
    out(tlds.length ? tlds.map((t) => `.${t}`).join("\n") : "no TLDs claimed yet");
    return 0;
  }

  if (sub === "resolve") {
    const name = resolveArgument(rest);
    if (!name) {
      out("usage: moshcode dns resolve <name>");
      return 1;
    }
    const result = await resolveName(name, { registryBase });
    // A parked name has no page at its own address — the A record points at a
    // host that routes by Host and will not answer for it. The Pit does have a
    // page for it, so say so instead of printing an IP that goes nowhere.
    const pitUrl = result.status === "parked" ? pitNameUrl(name, registryBase) : null;
    const asJson = rest.includes("--json");
    const explain = {
      live: () => `${name} → ${result.target}`,
      parked: () => `${name} → ${pitUrl}  [parked — claimed but not pointed at an IP]`,
      unreachable: () => `${name} → NXDOMAIN  [registry unreachable — not parking a name we could not look up]`,
      "not-a-name": () => `${name} → NXDOMAIN  [not a Moshpit name: needs exactly one label and one TLD]`,
    };
    if (asJson) {
      out(JSON.stringify({
        name,
        status: result.status,
        target: result.target,
        pitUrl,
      }, null, 2));
    } else {
      out(explain[result.status]());
    }

    // Opt-in rather than automatic: `resolve` is also what scripts and pipes
    // call, and launching a browser out of a lookup would be a surprise.
    if (rest.includes("--open") && pitUrl) {
      if (canOpenBrowser()) {
        if (!asJson) out(`opening ${pitUrl}`);
        openBrowser(pitUrl);
      } else if (!asJson) {
        out("(no browser to open here — copy the URL above)");
      }
    }
    return result.status === "live" || result.status === "parked" ? 0 : 1;
  }

  if (sub === "start") {
    // Serve parked names ourselves when we can. The public parking host routes
    // by Host header and 404s a name it has never heard of, so pointing at
    // loopback — where the responder below is listening — is the difference
    // between `curl <name>` resolving and `curl <name>` working.
    const parkingPortIndex = rest.indexOf("--parking-port");
    const rawParkingHttpPort = parkingPortIndex >= 0 ? rest[parkingPortIndex + 1] : DEFAULT_PARKING_HTTP_PORT;
    const parkingHttpPort = parseDnsPort(rawParkingHttpPort);
    if (parkingHttpPort === null) {
      out(`--parking-port needs a decimal integer from 1 to 65535, got ${JSON.stringify(rawParkingHttpPort)}`);
      return 1;
    }
    let parking = null;
    if (!rest.includes("--no-parking-http")) {
      try {
        parking = await createParkingServer({
          port: parkingHttpPort,
          registryBase,
          onRequest: ({ host: h, target }) => out(`  ${h} → ${target}`),
        });
      } catch (err) {
        const why = err?.code === "EACCES"
          ? `needs privileges to bind port ${parkingHttpPort}`
          : err?.code === "EADDRINUSE"
            ? `port ${parkingHttpPort} is already in use`
            : err?.message || String(err);
        out(`! parked names will not serve over HTTP — ${why}`);
        out(`  (run with sudo, or pass --parking-port N and point your client at it)`);
      }
    }

    // Loopback when we are answering for parked names; otherwise the public
    // parking host, which is all there ever was.
    const park = parking ? parking.address : await parkingAddress();
    if (!park) out("! parking host did not resolve — unpointed names will return NXDOMAIN");
    // Without these the bridge answers only for endings it is authoritative
    // for, which is correct for per-ending routing and fatal for catch-all.
    const upstreams = await discoverUpstreams();
    const tldSet = new Set(await fetchTlds({ registryBase }).catch(() => []));
    if (upstreams.length) out(`forwarding non-Moshpit lookups to ${upstreams.join(", ")}`);
    else out("! no upstreams found in /etc/resolv.conf — this bridge can only answer Moshpit names");

    // The same two error codes the parking server above already explains, on
    // the port this command exists to bind. Without this they arrived as an
    // unhandled rejection — bin/moshcode calls main() with no top-level catch —
    // so a busy port answered with a node:dgram stack trace. This one is fatal
    // where the parking server's is not, so it ends the command rather than
    // carrying on: the shape serve.mjs uses for a step it cannot complete.
    let server;
    try {
      server = await createServer({
        port,
        registryBase,
        parkingAddress: park,
        upstreams,
        tldSet,
        onQuery: ({ name, address }) => out(`  ${name} → ${address || "NXDOMAIN"}`),
        onError: (err) => out(`! resolver socket error — ${err?.message || err}`),
      });
    } catch (err) {
      const why = err?.code === "EACCES"
        ? `needs privileges to bind port ${port}`
        : err?.code === "EADDRINUSE"
          ? `port ${port} is already in use`
          : err?.message || String(err);
      out(`! resolver could not start — ${why}`);
      out(err?.code === "EACCES"
        ? "  (run with sudo, or pass --port N and point your resolver there)"
        : `  (stop what is on port ${port}, or pass --port N and point your resolver there)`);
      // Opened before the bind was attempted, so it is listening right now. The
      // crash used to close it by killing the process; returning cannot, and an
      // orphaned listener holds the event loop open — the command would hang on
      // a busy port instead of exiting.
      await parking?.close();
      return 1;
    }
    if (parking) out(`parked names → http://${parking.address}:${parking.port} → ${registryBase}/n/<name>`);
    out(`moshpit resolver on ${server.address}:${server.port} (registry ${registryBase})`);
    out("point your resolver here with: moshcode dns install");
    return new Promise(() => {}); // foreground until Ctrl-C
  }

  if (sub === "install") {
    const tlds = await fetchTlds({ registryBase });
    if (!tlds.length) {
      out("no TLDs claimed yet — nothing to route");
      return 1;
    }
    const conf = resolvedConf(tlds, { port });
    const target = MOSHPIT_DROPIN;
    if (rest.includes("--write")) {
      try {
        await writeFile(target, conf);
        out(`wrote ${target}`);
        out("now run: sudo systemctl restart systemd-resolved");
        return 0;
      } catch (err) {
        out(`could not write ${target}: ${err.message}`);
        out("(needs root — rerun with sudo, or install the config by hand below)");
      }
    }
    out(`# ${target}`);
    out(conf);
    out("# ...or, for dnsmasq:");
    out(dnsmasqConf(tlds, { port }));
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    const platform = detectPlatform();
    if (!platform) {
      out(`unsupported platform: ${process.platform}`);
      return 1;
    }
    const dryRun = rest.includes("--dry-run");
    const force = rest.includes("--force");
    const linuxBackend = flag("backend", "systemd-resolved");
    const wanted = requiredPort(platform, port);

    let tlds = [];
    try {
      tlds = await fetchTldsImpl({ registryBase });
    } catch {
      // disable does not need the list on Linux, and on macOS a stale list is
      // better than refusing to clean up because the registry is unreachable.
      tlds = [];
    }

    // Phase 1, and it runs before every other question is asked — including the
    // forwarding probe, whose answer means nothing while a stranger holds the
    // port it is probing.
    let cleared = { ok: true, blockers: [] };
    if (sub === "enable") {
      const recorded = await bridgeStatus().catch(() => ({ pid: null, running: false }));
      cleared = await preflight({
        port: wanted,
        ourPid: recorded.running ? recorded.pid : null,
        checkDropins: platform === "linux" && linuxBackend === "systemd-resolved",
      });
      out(cleared.ok
        ? `preflight  clear — no competing DNS= drop-in, nothing eating queries on ${DEFAULT_HOST}:${wanted}`
        : "preflight  BLOCKED");
      // Said out loud rather than passed over: a bridge nothing here started is
      // about to be handed every lookup on the machine, and the one line saying
      // so is what makes that a decision instead of a surprise.
      if (cleared.holder && cleared.holderForwards) {
        out(`  note  ${DEFAULT_HOST}:${wanted} is held by pid ${cleared.holder.pid || "?"}, which this run did not start — it forwards, so it is being used as-is`);
      }
      for (const dup of cleared.duplicates || []) {
        // Not a blocker, but `dns disable` removes moshpit.conf and nothing
        // else, so this file is what makes a disabled machine still route.
        out(`  note  ${RESOLVED_DROPIN_DIR}/${dup.name} already points at this bridge — \`dns disable\` will not remove it`);
      }
      for (const blocker of cleared.blockers) {
        out("");
        for (const line of blocker.lines) out(`  ${line}`);
      }
      out("");
      // A dry run still says what it found and still describes the rest, which
      // is the point of asking for one while a machine is in this state.
      if (!cleared.ok && !force && !dryRun) {
        out("Refusing to switch this machine's DNS into a state it cannot resolve out of.");
        out("Nothing has been changed.");
        return 1;
      }
      if (!cleared.ok && force) out("--force: proceeding anyway.");
    }

    // Decided before anything is written, because the routing config is written
    // first and the bridge is started after — so by the time a bad bridge is
    // visible, every lookup on the machine is already pointed at it.
    const safety = sub === "enable"
      ? await catchAllSafetyImpl({ port: wanted })
      : { safe: false, upstreams: [] };
    if (sub === "enable") {
      out(safety.safe
        ? `routing every lookup here — ${safety.why}`
        : `routing each ending by name — ${safety.why}`);
      if (!safety.safe && safety.upstreams.length) {
        out("  (that list is capped by the resolver and silently truncated; catch-all is the fix,");
        out("   but not at the price of this machine's DNS)");
      }
      out("");
    }

    if (sub === "enable" && !tlds.length) {
      out("no TLDs claimed yet — nothing to route");
      return 1;
    }

    let plan;
    try {
      plan = sub === "enable"
        ? enablePlan({ platform, tlds, port: wanted, linuxBackend, upstreams: safety.safe ? safety.upstreams : [] })
        : disablePlan({ platform, tlds, linuxBackend });
    } catch (err) {
      out(err.message);
      return 1;
    }

    // The name whose resolution proves the bridge is answering, alongside the
    // clearnet one that proves it is forwarding.
    const moshpitProbe = tlds[0] ? `a.${tlds[0]}` : null;
    // Restoring files is not a rollback on Windows: NRPT rules are not files,
    // so the undo is the disable plan's commands rather than the enable plan's.
    const undoSteps = platform === "windows" ? disablePlan({ platform, tlds, linuxBackend }).steps : undefined;

    if (dryRun) {
      out(`# ${sub} on ${platform} — nothing below has been run`);
      out(describePlan(plan));
      if (sub === "enable") {
        // The three phases that have no plan steps of their own. Printed
        // because "what would this do to my machine" has to include the part
        // that undoes it, and because a dry run is how someone decides whether
        // to hand this command root.
        out("");
        out("verify  (both must answer, through this machine's own resolver)");
        if (moshpitProbe) out(`          ${moshpitProbe}    # a Moshpit name — the bridge is reachable`);
        out(`          ${CLEARNET_PROBE}    # clearnet — the bridge forwards rather than swallows`);
        out("");
        out("rollback  (only if verify fails)");
        for (const step of plan.steps.filter((s) => s.kind === "write")) {
          out(`          restore ${step.path}, or remove it if this run created it`);
        }
        for (const step of undoSteps || plan.steps.filter((s) => s.kind === "run")) {
          out(`          run     ${step.command} ${step.args.join(" ")}`);
        }
      }
      return 0;
    }

    // Checked before doing half of it: every step here needs root, and a
    // partial apply is worse than a clean refusal with the command to retry.
    if (plan.elevated && uid !== 0) {
      out(`dns ${sub} edits system DNS and needs root.`);
      out(`  sudo moshcode dns ${sub}${rest.length ? " " + rest.join(" ") : ""}`);
      out("");
      out("or see exactly what it would do first:");
      out(`  moshcode dns ${sub} --dry-run`);
      return 1;
    }

    const report = (results) => {
      for (const r of results) {
        const what = r.step.kind === "run" ? `${r.step.command} ${r.step.args.join(" ")}` : r.step.path;
        out(`  ${r.ok ? "ok  " : "FAIL"} ${r.step.kind.padEnd(6)} ${what}${r.ok ? "" : ` — ${r.error}`}`);
      }
    };

    if (sub === "disable") {
      const applied = await applyPlan(plan);
      report(applied.results);
      for (const note of plan.notes || []) out(`  note   ${note}`);
      const stopped = await stopBridge();
      out(stopped.stopped ? "  ok   bridge stopped" : `  ok   bridge was not running${stopped.reason ? ` (${stopped.reason})` : ""}`);
      out("");
      out("Moshpit TLDs are back to your normal resolver.");
      return applied.ok ? 0 : 1;
    }

    // The bridge comes up before the routing points at it. The old order wrote
    // the config, restarted the resolver, and started the daemon afterwards —
    // which on catch-all routing is a window where every lookup on the machine
    // goes to a port with nothing behind it. It also left nothing to verify
    // against: there is no answer to ask for until the bridge exists.
    const started = await startBridge({ port: wanted, registryBase, entry: cliEntry() });
    out(started.alreadyRunning
      ? `  ok   bridge already running (pid ${started.pid})`
      : `  ok   bridge started on ${DEFAULT_HOST}:${wanted} (pid ${started.pid})`);

    const outcome = await applyWith(plan, {
      verify: () => verify({ moshpit: moshpitProbe }),
      rollbackSteps: undoSteps,
    });
    report(outcome.applied.results);
    for (const note of plan.notes || []) out(`  note   ${note}`);

    for (const check of outcome.verified.checks) {
      out(`  ${check.ok ? "ok  " : "FAIL"} verify ${check.name} (${check.kind})${check.ok ? "" : ` — ${check.error}`}`);
    }
    if (outcome.verified.skipped) out(`  --   verify ${outcome.verified.skipped}`);
    if (outcome.saved && !outcome.saved.ok) {
      // Not fatal: the rollback restores from what was read into memory before
      // anything was written. The on-disk copy only matters if this process is
      // killed mid-run, which is worth one line and not worth refusing over.
      out("  warn backup copy could not be written — an interrupted run would need manual repair");
    }

    if (!outcome.rolledBack) {
      out("");
      out(`Moshpit names now resolve on this machine. Try: moshcode dns resolve ${moshpitProbe || "<name>"}`);
      out(`Routing covers the ${tlds.length} TLDs claimed right now. New ones do not route`);
      out("until you re-run this — there is no common suffix to match, so every TLD is listed.");
      out("Note: the bridge does not yet survive a reboot. Re-run `moshcode dns enable` after one.");
      return 0;
    }

    out("");
    report(outcome.rolledBack.results);
    // Started by this run and no longer routed to, so leaving it would be a
    // process holding 5354 that the next enable's preflight refuses to run past.
    if (started.started) {
      const stopped = await stopBridge();
      if (stopped.stopped) out("  ok   remove bridge started by this run");
    }
    out("");
    const failed = outcome.verified.checks.filter((c) => !c.ok).map((c) => c.name);
    out(outcome.applied.ok
      ? `Verification failed — ${failed.join(" and ")} did not resolve after the switch.`
      : "Some routing steps failed, so the switch was never complete.");
    if (outcome.rolledBack.ok) {
      out("Rolled back: this machine's DNS is exactly as it was before this command ran.");
    } else {
      out("! the rollback did not fully succeed — this machine's DNS needs attention now.");
      for (const path of outcome.backups) out(`  the previous config is at ${path}`);
      out("  restore it, then: systemctl restart systemd-resolved");
    }
    return 1;
  }

  if (sub === "status") {
    const platform = detectPlatform();
    const daemon = await daemonStatus();
    out(`platform   ${platform || process.platform}`);
    out(`bridge     ${daemon.running ? `running (pid ${daemon.pid})` : daemon.stale ? `NOT running — stale pidfile for ${daemon.pid}` : "not running"}`);

    // Routing is read off the filesystem rather than remembered, so a config
    // someone edited or removed by hand is reported as it actually is.
    const marker = platform === "macos" ? "/etc/resolver" : MOSHPIT_DROPIN;
    const routed = platform === "linux" ? existsSync(marker) : platform === "macos" ? existsSync(marker) : null;
    out(`routing    ${routed === null ? "(check NRPT: Get-DnsClientNrptRule)" : routed ? `configured (${marker})` : "not configured"}`);

    // The state worth shouting about: names are pointed at a bridge that is not
    // there, so every Moshpit name fails instead of falling through.
    if (routed && !daemon.running) {
      out("");
      out("! routing is in place but the bridge is not running — Moshpit names will fail.");
      out("  fix with: sudo moshcode dns enable     undo with: sudo moshcode dns disable");
    }

    const known = await fetchTlds({ registryBase }).catch(() => null);
    const probe = known
      ? await resolveName(`probe.${known[0] || "moshpit"}`, { registryBase }).catch(() => null)
      : null;
    out(probe ? `registry   reachable — ${known.length} TLDs claimed` : "registry   unreachable");

    // Routing is a snapshot: the TLD list is enumerated at enable time because
    // arbitrary endings share no suffix to match on. Drift is silent otherwise
    // — a name claimed after you enabled simply does not resolve.
    if (routed && known && platform === "linux") {
      const conf = await readFile(marker, "utf8").catch(() => "");
      const written = [...new Set((conf.match(/~[a-z0-9-]+/g) || []).map((t) => t.slice(1).toLowerCase()))];
      if (written.length && written.length !== known.length) {
        out("");
        out(`! routing covers ${written.length} TLDs but ${known.length} are claimed — re-run \`sudo moshcode dns enable\``);
      }

      // The check that was missing. Comparing the file against the registry
      // compares two things we control and agrees with itself; the resolver is
      // the one that gets a vote, and it silently declines to take them all.
      const shortfall = routingShortfall(written, await acceptedDomains());
      if (shortfall && shortfall.missing.length) {
        out("");
        out(`! wrote ${shortfall.written} endings, the resolver accepted ${shortfall.accepted} — ${shortfall.missing.length} are not routed`);
        out(`  missing: ${shortfall.missing.slice(0, 8).join(" ")}${shortfall.missing.length > 8 ? ` … and ${shortfall.missing.length - 8} more` : ""}`);
        out("  systemd-resolved caps how many search domains it takes and drops the rest:");
        out("    journalctl -u systemd-resolved | grep 'Argument list too long'");
        out("  a name in that list answers `moshcode dns resolve` and fails `curl`.");
      }
    }
    return 0;
  }

  out(`unknown: dns ${sub}\n\n${USAGE}`);
  return 1;
}

/** The CLI's own entry point, so the daemon re-invokes this same binary. */
function cliEntry() {
  return fileURLToPath(new URL("../bin/moshcode.mjs", import.meta.url));
}
