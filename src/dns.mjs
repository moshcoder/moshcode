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

export const DEFAULT_REGISTRY_BASE = "https://pit.moshcode.sh";
export const DEFAULT_PARKING_HOST = "moshcoding.com";
export const DEFAULT_PORT = 5354;
export const DEFAULT_HOST = "127.0.0.1";

// Short, because a name's target can change the moment its owner points it
// somewhere. A stale A record is the one failure mode users cannot debug.
export const DEFAULT_TTL = 30;

const TYPE_A = 1;
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

/** Build an A-record response, or NXDOMAIN when `address` is null. */
export function buildResponse(query, buf, address, ttl = DEFAULT_TTL) {
  const question = buf.subarray(12, query.questionEnd);
  const rdata = address ? ipv4(address) : null;
  if (!rdata) {
    return Buffer.concat([
      header(query.id, { rcode: RCODE_NXDOMAIN, answers: 0, recursionDesired: query.recursionDesired }),
      question,
    ]);
  }
  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0); // pointer to the question's name
  answer.writeUInt16BE(TYPE_A, 2);
  answer.writeUInt16BE(CLASS_IN, 4);
  answer.writeUInt32BE(ttl, 6);
  answer.writeUInt16BE(4, 10);
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
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const [label, tld] = parts;
  if (!LABEL.test(label) || !LABEL.test(tld)) return null;
  return { label, tld };
}

/** The TLDs currently claimed in the Pit — what we route to this resolver. */
export async function fetchTlds({ registryBase = DEFAULT_REGISTRY_BASE, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${registryBase.replace(/\/+$/, "")}/api/moshpit/tlds`);
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  const json = await res.json();
  return (json?.tlds || [])
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
 * The address to answer with, or null for NXDOMAIN.
 *
 * Kept separate from the socket so the policy is testable on its own. A name we
 * could not look up gets NXDOMAIN rather than the parking address: a registry
 * outage must not silently redirect every name on the machine to a parking page.
 */
export async function answerFor(name, options = {}) {
  const { parkingAddress } = options;
  const result = await resolveName(name, options);
  if (result.status === "live") return result.target;
  if (result.status === "parked") return parkingAddress || null;
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
    // Only A/IN questions can be answered with an address; everything else
    // (AAAA, MX, TXT) gets an honest empty NOERROR/NXDOMAIN rather than a lie.
    if (query.type === TYPE_A && query.class === CLASS_IN) {
      address = await answerFor(query.name, options).catch(() => null);
    }
    onQuery({ name: query.name, type: query.type, address });
    try {
      socket.send(buildResponse(query, msg, address, ttl), rinfo.port, rinfo.address);
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
  moshcode dns start [--port N]  run the resolver in the foreground
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
  const port = Number(flag("port", DEFAULT_PORT));
  const registryBase = flag("registry", DEFAULT_REGISTRY_BASE);

  if (!sub || sub === "help" || sub === "--help") {
    out(USAGE);
    return 0;
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
    const park = result.status === "parked" ? await parkingAddress() : null;
    const explain = {
      live: () => `${name} → ${result.target}`,
      parked: () => `${name} → ${park || "(parking host unresolvable)"}  [parked — claimed but not pointed at an IP]`,
      unreachable: () => `${name} → NXDOMAIN  [registry unreachable — not parking a name we could not look up]`,
      "not-a-name": () => `${name} → NXDOMAIN  [not a Moshpit name: needs exactly one label and one TLD]`,
    };
    out(explain[result.status]());
    return result.status === "live" || result.status === "parked" ? 0 : 1;
  }

  if (sub === "start") {
    const park = await parkingAddress();
    if (!park) out("! parking host did not resolve — unpointed names will return NXDOMAIN");
    const server = await createServer({
      port,
      registryBase,
      parkingAddress: park,
      onQuery: ({ name, address }) => out(`  ${name} → ${address || "NXDOMAIN"}`),
    });
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
