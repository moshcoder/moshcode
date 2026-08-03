// Serving a Moshpit name over the clearnet.
//
// A name resolves to a `target` its owner typed in, and this fetches that and
// hands the result back — so `pit.moshcode.sh/n/blue.eggs` shows whatever
// blue.eggs points at, from a browser that has never heard of Moshpit.
//
// The target is attacker-controlled. That is the whole security problem here:
// anyone who can claim a name can point it at an address of their choosing and
// make this server fetch it, from inside whatever network this server is in.
// Pointed at 169.254.169.254 that is cloud credentials; pointed at 127.0.0.1 or
// a 10.x address it is every internal service the box can reach, returned to
// the person who asked. So the target is checked against the ranges that are
// not the public internet, and a hostname is checked *after* resolution rather
// than before, because "internal.example.com" is a public-looking name that can
// resolve anywhere.
//
// The check is a deny-list of the reserved ranges rather than an allow-list of
// public ones, which is the weaker shape — but the alternative is enumerating
// the entire public internet. The ranges below are the ones IANA reserves, and
// anything unparseable is refused rather than assumed routable.

import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** How long the origin has to answer before the gateway gives up on it. */
export const ORIGIN_TIMEOUT_MS = 10_000;

/** Enough for a page; a gateway is not a file host. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const V4_BLOCKED = [
  ["0.0.0.0", 8, "this host"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local — cloud metadata lives here"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

/** Why this address may not be fetched, or null when it may. */
export function blockedReason(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return "unparseable address";
    for (const [base, bits, why] of V4_BLOCKED) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((value & mask) === (ipv4ToInt(base) & mask)) return why;
    }
    return null;
  }
  if (version === 6) {
    const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (v6 === "::" || v6 === "::1") return "loopback";
    if (v6.startsWith("fe80")) return "link-local";
    // fc00::/7 — unique local addresses.
    if (/^f[cd]/.test(v6)) return "unique local";
    if (v6.startsWith("ff")) return "multicast";
    // An IPv4-mapped address would otherwise skip every rule above.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockedReason(mapped[1]);
    return null;
  }
  return "not an IP address";
}

/**
 * Split a target into host and port.
 *
 * Targets are typed by hand into a text field, so they arrive as bare IPs,
 * host:port, and occasionally with a scheme already on the front.
 */
export function parseTarget(target) {
  const raw = String(target || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!raw) return null;

  const bracketed = raw.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/i);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : 80 };

  // A bare IPv6 literal has colons but no port; only split on the last colon
  // when what follows is digits and what precedes is not itself IPv6.
  if (isIP(raw) === 6) return { host: raw, port: 80 };

  const index = raw.lastIndexOf(":");
  if (index > 0 && /^\d+$/.test(raw.slice(index + 1))) {
    const port = Number(raw.slice(index + 1));
    if (port < 1 || port > 65535) return null;
    return { host: raw.slice(0, index), port };
  }
  return { host: raw, port: 80 };
}

/** A hostname target: dotted, and every label a legal DNS label. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Bracket an IPv6 host so it can go in a URL.
 *
 * `http://2606:4700::1111:80/` is not a URL — the colons in the address are
 * indistinguishable from the port separator, and `new URL` rejects it. Every
 * place that turns a target back into a URL has to go through here.
 */
export function urlHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** The origin URL to fetch, with an IPv6 host bracketed. */
export function originUrl({ host, port }) {
  return `http://${urlHost(host)}:${port}`;
}

/**
 * Validate what an owner typed into "points at", and return the form to store.
 *
 * IP literals must be IPv6. An A record is a commitment to an address that a
 * name's owner usually does not own for long — IPv4 on a small host is leased,
 * NATed, or shared, and a name pointed at one goes stale silently. Every host
 * worth pointing a Moshpit name at has a stable /64 to spare, so the registry
 * asks for the address that will still be theirs next month. Hostnames stay
 * allowed: the address behind them is someone else's problem to keep current.
 *
 * Empty is not an error. A name with no target is a name waiting to be pointed,
 * which is the state every name starts in and a state owners return it to.
 */
export function normalizeTarget(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: true, target: null };

  const parsed = parseTarget(raw);
  if (!parsed) return { ok: false, error: "not a usable target" };

  const version = isIP(parsed.host);
  if (version === 4) {
    return {
      ok: false,
      error: "IPv4 addresses are not accepted — point the name at an IPv6 address, or at a hostname",
    };
  }

  if (version === 6) {
    const why = blockedReason(parsed.host);
    if (why) return { ok: false, error: `that address is ${why} — a target has to be reachable from the public internet` };
    // Stored bare when it is just an address, so anything reading the column
    // gets something it can use as an address without unwrapping it first.
    // Brackets appear only when a port forces them to.
    return { ok: true, target: parsed.port === 80 ? parsed.host.toLowerCase() : `[${parsed.host.toLowerCase()}]:${parsed.port}` };
  }

  if (!HOSTNAME.test(parsed.host)) return { ok: false, error: "not a usable target" };
  const host = parsed.host.toLowerCase();
  return { ok: true, target: parsed.port === 80 ? host : `${host}:${parsed.port}` };
}

/**
 * Is this target safe to fetch, and at what address?
 *
 * A hostname is resolved here and every address it returns is checked, because
 * one A record pointing somewhere public does not make the others safe.
 */
export async function checkTarget(target, { resolve = dns.lookup } = {}) {
  const parsed = parseTarget(target);
  if (!parsed) return { ok: false, error: "not a usable target" };

  if (isIP(parsed.host)) {
    const why = blockedReason(parsed.host);
    return why
      ? { ok: false, error: `target is ${why}` }
      : { ok: true, host: parsed.host, port: parsed.port, origin: originUrl(parsed), addresses: [parsed.host] };
  }

  let addresses;
  try {
    addresses = await resolve(parsed.host, { all: true });
  } catch {
    return { ok: false, error: "target does not resolve" };
  }
  if (!addresses?.length) return { ok: false, error: "target does not resolve" };

  for (const { address } of addresses) {
    const why = blockedReason(address);
    if (why) return { ok: false, error: `target resolves to ${why}` };
  }
  return {
    ok: true,
    host: parsed.host,
    port: parsed.port,
    origin: originUrl(parsed),
    addresses: addresses.map((a) => a.address),
  };
}

/**
 * Fetch an origin, honouring the Host header.
 *
 * This deliberately does not use fetch(). `Host` is a forbidden header name in
 * the fetch spec, so undici drops it without a word and sends the authority
 * from the URL instead — the origin was being asked for the *target*, never for
 * the Moshpit name. A box that virtual-hosts the name then fell through to
 * whatever its default vhost is, and if that redirects to HTTPS the gateway
 * forwarded a 301 (with the Location stripped, since only content-type is
 * copied) — the "301 to nowhere" that made pointed names look broken.
 *
 * node:http lets Host be set, which is the entire reason it is here.
 */
export function fetchOrigin({ host, port, path, headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path, method: "GET", headers }, (response) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      response.on("data", (chunk) => {
        size += chunk.length;
        // Stop reading rather than buffer an unbounded body from a target the
        // person who claimed the name chose.
        if (size > maxBytes) { truncated = true; response.destroy(); return; }
        chunks.push(chunk);
      });
      const done = () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: truncated ? Buffer.alloc(0) : Buffer.concat(chunks),
        truncated,
      });
      response.on("end", done);
      response.on("close", done); // fires instead of "end" on the destroy above
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => {
      // Named so the caller can tell a slow origin from an unreachable one.
      request.destroy(Object.assign(new Error("origin timed out"), { name: "AbortError" }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * The pin for a certificate: SHA-256 over its SubjectPublicKeyInfo, base64.
 *
 * The public key rather than the whole certificate, so an origin can renew or
 * re-issue without the registry entry going stale — the only question a pin
 * asks is "is this the same key I was promised".
 *
 * This is the RFC 7469 format, byte-identical to what setup-origin.sh publishes
 * and to what an operator gets from
 *   openssl x509 -pubkey -noout | openssl pkey -pubin -outform der |
 *     openssl dgst -sha256 -binary | base64
 * so nobody has to take our word for a mismatch.
 */
export function pinFromCertificate(certificate) {
  return createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
}

/**
 * Fetch an origin over TLS, trusting a published pin instead of a CA.
 *
 * No CA will issue for a Moshpit ending — they are outside the DNS root, and
 * the CA/Browser Forum stopped issuing for non-IANA TLDs in 2015. So the
 * origin's certificate is self-signed, `rejectUnauthorized` is off, and the
 * pin is doing the entire job a chain would normally do. That is a stronger
 * check than a chain in one respect and a weaker one in another: it names one
 * exact key rather than delegating to whichever of ~150 CAs will sign, but it
 * only works for a name whose owner has actually published a pin.
 *
 * The identity check is therefore the pin and nothing else — hostname
 * verification is explicitly disabled, because the certificate is for
 * `chovy.hacker` while the socket is connected to an address the registry
 * resolved. Checking the name here would fail on a certificate that is
 * correct, and passing it would prove nothing the pin has not already proven.
 */
export function fetchOriginTls({ host, port, servername, path, headers, pins, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    if (!pins?.length) {
      reject(Object.assign(new Error("no pin published"), { name: "NoPinError" }));
      return;
    }

    const request = https.request({
      host, port, path, method: "GET", headers, servername,
      rejectUnauthorized: false,
      // The pin is the identity. See above.
      checkServerIdentity: () => undefined,
    }, (response) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { truncated = true; response.destroy(); return; }
        chunks.push(chunk);
      });
      const done = () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: truncated ? Buffer.alloc(0) : Buffer.concat(chunks),
        truncated,
      });
      response.on("end", done);
      response.on("close", done);
      response.on("error", reject);
    });

    // Checked the moment the handshake finishes and before a single request
    // byte is written, so a wrong key never sees the request either.
    request.on("socket", (socket) => {
      socket.on("secureConnect", () => {
        const certificate = socket.getPeerX509Certificate?.();
        if (!certificate) {
          request.destroy(Object.assign(new Error("origin sent no certificate"), { name: "PinError" }));
          return;
        }
        const served = pinFromCertificate(certificate);
        if (!pins.includes(served)) {
          request.destroy(Object.assign(
            new Error(`origin key does not match the published pin (serving ${served})`),
            { name: "PinError", served },
          ));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(Object.assign(new Error("origin timed out"), { name: "AbortError" }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Where an origin's redirect points, when it points somewhere we may follow.
 *
 * An origin that upgrades to HTTPS is the common case for a Moshpit name — the
 * name's own nginx block does it — and forwarding that redirect to a browser is
 * useless, since the browser cannot resolve the name or validate the
 * certificate. So the gateway follows it instead.
 *
 * Only to the same name, and only to HTTPS. Following it anywhere else would
 * re-open the SSRF hole checkTarget() exists to close: the redirect is written
 * by whoever claimed the name, so treating it as a new address to fetch would
 * let them point at 169.254.169.254 after passing the check. Staying on the
 * already-validated address means there is no second target to validate.
 */
export function tlsRedirect(location, { name, host }) {
  if (!location) return null;
  let url;
  try { url = new URL(location); } catch { return null; }
  if (url.protocol !== "https:") return null;

  const to = url.hostname.toLowerCase();
  if (to !== String(name).toLowerCase() && to !== String(host).toLowerCase()) return null;

  return { port: url.port ? Number(url.port) : 443, path: `${url.pathname}${url.search}` || "/" };
}

/** Headers worth passing to the origin. Everything else is dropped. */
export function forwardableHeaders(headers = {}, name) {
  const out = {
    // The origin is virtual-hosting on the Moshpit name, so it needs to be told
    // which one this is — the TCP connection only knows an IP. Only reaches the
    // origin because fetchOrigin() uses node:http; fetch() would discard it.
    host: name,
    "x-forwarded-host": name,
    "x-moshpit-name": name,
  };
  for (const key of ["accept", "accept-language", "user-agent"]) {
    if (headers[key]) out[key] = headers[key];
  }
  // Deliberately absent: cookie, authorization, and every x-forwarded-for. The
  // visitor's session on app.moshcode.sh has nothing to do with the origin, and
  // forwarding it would hand a name's owner their visitors' credentials.
  return out;
}
