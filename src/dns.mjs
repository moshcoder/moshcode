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
export function createServer(options = {}) {
  const {
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    ttl = DEFAULT_TTL,
    onQuery = () => {},
  } = options;
  const socket = dgram.createSocket("udp4");

  socket.on("message", async (msg, rinfo) => {
    const query = parseQuery(msg);
    if (!query) return; // malformed, or a response — say nothing at all
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
 * systemd-resolved drop-in routing just the Moshpit TLDs at the bridge.
 *
 * `~tld` is a routing-only domain: it sends queries for that suffix here
 * without making this resolver the default for anything else on the machine.
 */
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
  moshcode dns resolve <name> [--open]
                                 look a name up; --open opens a parked name in the Pit
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
    const name = rest[0];
    if (!name) {
      out("usage: moshcode dns resolve <name>");
      return 1;
    }
    const result = await resolveName(name, { registryBase });
    // A parked name has no page at its own address — the A record points at a
    // host that routes by Host and will not answer for it. The Pit does have a
    // page for it, so say so instead of printing an IP that goes nowhere.
    const pitUrl = result.status === "parked" ? pitNameUrl(name, registryBase) : null;
    const explain = {
      live: () => `${name} → ${result.target}`,
      parked: () => `${name} → ${pitUrl}  [parked — claimed but not pointed at an IP]`,
      unreachable: () => `${name} → NXDOMAIN  [registry unreachable — not parking a name we could not look up]`,
      "not-a-name": () => `${name} → NXDOMAIN  [not a Moshpit name: needs exactly one label and one TLD]`,
    };
    out(explain[result.status]());

    // Opt-in rather than automatic: `resolve` is also what scripts and pipes
    // call, and launching a browser out of a lookup would be a surprise.
    if (rest.includes("--open") && pitUrl) {
      if (canOpenBrowser()) {
        out(`opening ${pitUrl}`);
        openBrowser(pitUrl);
      } else {
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
    const server = await createServer({
      port,
      registryBase,
      parkingAddress: park,
      onQuery: ({ name, address }) => out(`  ${name} → ${address || "NXDOMAIN"}`),
    });
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

    if (sub === "enable" && !tlds.length) {
      out("no TLDs claimed yet — nothing to route");
      return 1;
    }

    let plan;
    try {
      plan = sub === "enable"
        ? enablePlan({ platform, tlds, port: wanted, linuxBackend })
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
      const routedCount = (conf.match(/~[a-z0-9-]+/g) || []).length;
      if (routedCount && routedCount !== known.length) {
        out("");
        out(`! routing covers ${routedCount} TLDs but ${known.length} are claimed — re-run \`sudo moshcode dns enable\``);
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
