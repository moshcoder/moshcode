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
const CLASS_IN = 1;
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
  { registryBase = DEFAULT_REGISTRY_BASE, fetchImpl = fetch, timeoutMs = 4000 } = {},
) {
  const parsed = parseRegistryName(name);
  if (!parsed) return { status: "not-a-name", target: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${registryBase.replace(/\/+$/, "")}/api/moshpit/resolve?name=${encodeURIComponent(
      `${parsed.label}.${parsed.tld}`,
    )}`;
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return { status: "unreachable", target: null };
    const json = await res.json();
    const claimed =
      typeof json?.name_registered === "boolean" ? json.name_registered : json?.registered;
    if (typeof claimed !== "boolean") return { status: "unreachable", target: null };
    const target = typeof json.target === "string" && json.target ? json.target : null;
    if (target) return { status: "live", target };
    return { status: "parked", target: null, registered: claimed };
  } catch {
    return { status: "unreachable", target: null };
  } finally {
    clearTimeout(timer);
  }
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
    // Only address questions can be answered with an address; everything else
    // (MX, TXT, HTTPS) gets an honest empty NOERROR rather than a lie. It still
    // has to be looked up: a browser asks HTTPS/SVCB beside every A and AAAA,
    // and NXDOMAIN to that one denies the name for the whole page load.
    if (query.class === CLASS_IN) {
      const wantsAddress = query.type === TYPE_A || query.type === TYPE_AAAA;
      const policy = await answerPolicy(query.name, { ...options, wantsAddress }).catch(() => null);
      if (policy) ({ exists, address } = policy);
    }
    onQuery({ name: query.name, type: query.type, address });
    try {
      socket.send(buildResponse(query, msg, address, ttl, exists), rinfo.port, rinfo.address);
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
  --backend    linux only: systemd-resolved (default) or dnsmasq
  --port N     the bridge's port (Windows must use 53 — NRPT carries no port)

The registry speaks HTTP, not DNS, so nothing outside a browser can reach a
Moshpit name until this bridge is running and your resolver points at it.
\`enable\` edits system DNS and needs root (Administrator on Windows); it routes
only the Moshpit TLDs, so every other name keeps using your normal resolver.`;

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

export async function dnsCommand(args = [], out = console.log) {
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
    const target = "/etc/systemd/resolved.conf.d/moshpit.conf";
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
    const linuxBackend = flag("backend", "systemd-resolved");
    const wanted = requiredPort(platform, port);

    let tlds = [];
    try {
      tlds = await fetchTlds({ registryBase });
    } catch {
      // disable does not need the list on Linux, and on macOS a stale list is
      // better than refusing to clean up because the registry is unreachable.
      tlds = [];
    }

    // Decided before anything is written, because the routing config is written
    // first and the bridge is started after — so by the time a bad bridge is
    // visible, every lookup on the machine is already pointed at it.
    const safety = sub === "enable"
      ? await catchAllSafety({ port: wanted })
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

    if (dryRun) {
      out(`# ${sub} on ${platform} — nothing below has been run`);
      out(describePlan(plan));
      return 0;
    }

    // Checked before doing half of it: every step here needs root, and a
    // partial apply is worse than a clean refusal with the command to retry.
    if (plan.elevated && typeof process.getuid === "function" && process.getuid() !== 0) {
      out(`dns ${sub} edits system DNS and needs root.`);
      out(`  sudo moshcode dns ${sub}${rest.length ? " " + rest.join(" ") : ""}`);
      out("");
      out("or see exactly what it would do first:");
      out(`  moshcode dns ${sub} --dry-run`);
      return 1;
    }

    const applied = await applyPlan(plan);
    for (const r of applied.results) {
      const what = r.step.kind === "run" ? `${r.step.command} ${r.step.args.join(" ")}` : r.step.path;
      out(`  ${r.ok ? "ok  " : "FAIL"} ${r.step.kind.padEnd(6)} ${what}${r.ok ? "" : ` — ${r.error}`}`);
    }
    for (const note of plan.notes || []) out(`  note   ${note}`);

    if (sub === "enable") {
      const started = await startDaemon({ port: wanted, registryBase, entry: cliEntry() });
      out(started.alreadyRunning
        ? `  ok   bridge already running (pid ${started.pid})`
        : `  ok   bridge started on ${DEFAULT_HOST}:${wanted} (pid ${started.pid})`);
      out("");
      out(applied.ok
        ? `Moshpit names now resolve on this machine. Try: moshcode dns resolve ${tlds[0] ? `a.${tlds[0]}` : "<name>"}`
        : "Some steps failed — routing is incomplete. Re-run, or use --dry-run to see what was meant to happen.");
      out(`Routing covers the ${tlds.length} TLDs claimed right now. New ones do not route`);
      out("until you re-run this — there is no common suffix to match, so every TLD is listed.");
      out("Note: the bridge does not yet survive a reboot. Re-run `moshcode dns enable` after one.");
    } else {
      const stopped = await stopDaemon();
      out(stopped.stopped ? "  ok   bridge stopped" : `  ok   bridge was not running${stopped.reason ? ` (${stopped.reason})` : ""}`);
      out("");
      out("Moshpit TLDs are back to your normal resolver.");
    }
    return applied.ok ? 0 : 1;
  }

  if (sub === "status") {
    const platform = detectPlatform();
    const daemon = await daemonStatus();
    out(`platform   ${platform || process.platform}`);
    out(`bridge     ${daemon.running ? `running (pid ${daemon.pid})` : daemon.stale ? `NOT running — stale pidfile for ${daemon.pid}` : "not running"}`);

    // Routing is read off the filesystem rather than remembered, so a config
    // someone edited or removed by hand is reported as it actually is.
    const marker = platform === "macos" ? "/etc/resolver" : "/etc/systemd/resolved.conf.d/moshpit.conf";
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
