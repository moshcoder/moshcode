// The HTTP half of the DoH resolver.
//
// Plain HTTP on loopback, with TLS terminated by whatever already holds 443 on
// the box — nginx, Caddy, or a platform load balancer. That is not a shortcut:
// a resolver that manages its own certificate is a resolver that goes down when
// the certificate expires, and every machine pointed at it loses DNS at once.
// Renewal is a solved problem for exactly one process on a host, and it is not
// this one.
//
// Which means this must never bind a public address. A DoH endpoint reachable
// directly is an open resolver without the rate limits its proxy was going to
// apply, and scanners find those in hours.

import http from "node:http";
import { createDohHandler, DNS_MESSAGE } from "./doh.mjs";
import { discoverUpstreams, fetchTlds, DEFAULT_REGISTRY_BASE, parkingAddress } from "./dns.mjs";

export const DEFAULT_DOH_PORT = 8053;
export const DOH_PATH = "/dns-query";

/**
 * Guards on by default here, unlike the UDP bridge.
 *
 * The bridge listens on loopback and has one client, where rate limiting is
 * pure cost. This is meant to be reachable, and an unprotected open resolver
 * is found by scanners within hours of being published — so the safe
 * configuration has to be the one you get by not thinking about it.
 *
 * The numbers are generous for a person and tight for a script: 20 queries a
 * second sustained is far more than a browser produces and far less than a
 * scraper wants.
 */
export const DEFAULT_GUARDS = {
  rateLimit: { perSecond: 20, burst: 40 },
  ban: { baseMs: 60_000, factor: 2, maxMs: 24 * 60 * 60 * 1000 },
  // Caps amplification. 1232 is the payload size the DNS flag day settled on
  // as safe across the internet, so nothing legitimate loses anything.
  maxResponseBytes: 1232,
};

/**
 * Read guard settings off the command line.
 *
 * `--no-guards` exists for running behind something that already limits, and
 * is loud rather than silent: an unlimited open resolver is a decision, and
 * the caller has to have typed it.
 */
export function parseGuardArgs(args = []) {
  if (args.includes("--no-guards")) return { rateLimit: null, ban: null, maxResponseBytes: 0 };
  const num = (flag, fallback) => {
    const at = args.indexOf(flag);
    if (at < 0) return fallback;
    const value = Number(args[at + 1]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    rateLimit: {
      perSecond: num("--rate", DEFAULT_GUARDS.rateLimit.perSecond),
      burst: num("--burst", DEFAULT_GUARDS.rateLimit.burst),
    },
    ban: { ...DEFAULT_GUARDS.ban, baseMs: num("--ban-seconds", 60) * 1000 },
    maxResponseBytes: num("--max-response", DEFAULT_GUARDS.maxResponseBytes),
  };
}

/** Read a request body, refusing anything implausible for a DNS message. */
export function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Hung up on rather than buffered: the cap is the point, and a client
      // sending megabytes to a DNS endpoint is not a client.
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Who asked, as the proxy in front of us sees it.
 *
 * Behind a reverse proxy every request arrives from 127.0.0.1, so rate
 * limiting on the socket address would put every client in one bucket — one
 * abusive source would lock out everyone. The forwarded header is the only
 * client identity available, and it is trustworthy exactly as far as the proxy
 * is: fine when the proxy sets it, worthless if this is ever exposed directly,
 * which is the other reason it must not be.
 */
export function clientAddress(req, { trustProxy = true } = {}) {
  if (trustProxy) {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "";
}

/** Mount the DoH handler on an http server. Returns { port, address, close }. */
export async function createDohServer({
  port = DEFAULT_DOH_PORT,
  host = "127.0.0.1",
  registryBase = DEFAULT_REGISTRY_BASE,
  path = DOH_PATH,
  trustProxy = true,
  handler = null,
  onQuery = () => {},
  ...guards
} = {}) {
  const applied = { ...DEFAULT_GUARDS, ...guards };
  const handle = handler || createDohHandler({
    registryBase,
    upstreams: await discoverUpstreams(),
    tldSet: new Set(await fetchTlds({ registryBase }).catch(() => [])),
    parkingAddress: await parkingAddress().catch(() => null),
    onQuery,
    ...guards,
  });

  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    if (!url.split("?")[0].endsWith(path)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not here\n");
      return;
    }

    let body = null;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("query too large\n");
        return;
      }
    }

    const answer = await handle({
      method: req.method,
      url,
      body,
      address: clientAddress(req, { trustProxy }),
    }).catch(() => null);

    if (!answer) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("resolver error\n");
      return;
    }
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        address: addr.address,
        url: `http://${addr.address}:${addr.port}${path}`,
        guards: applied,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * The reverse-proxy block that terminates TLS in front of this.
 *
 * Emitted rather than described because the two lines people miss are the two
 * that matter: a DNS message is binary, so no charset and no gzip, and the
 * client's address has to be forwarded or every client shares a rate-limit
 * bucket.
 */
export function nginxDohSite({ name, port = DEFAULT_DOH_PORT, path = DOH_PATH }) {
  return [
    `# ${name} — DoH endpoint, written by \`moshcode doh --nginx\`.`,
    "#",
    "# TLS is terminated here on purpose. A resolver that manages its own",
    "# certificate goes down when that certificate expires, and every machine",
    "# pointed at it loses DNS at once.",
    "server {",
    "\tlisten 443 ssl;",
    "\tlisten [::]:443 ssl;",
    `\tserver_name ${name};`,
    "",
    `\t# certificates: certbot --nginx -d ${name}`,
    "",
    `\tlocation ${path} {`,
    `\t\tproxy_pass http://127.0.0.1:${port};`,
    "\t\tproxy_set_header Host $host;",
    "\t\t# Without this every client shares one rate-limit bucket, because",
    "\t\t# behind a proxy they all arrive from 127.0.0.1.",
    "\t\tproxy_set_header X-Forwarded-For $remote_addr;",
    "\t\t# A DNS message is binary. Compressing it wastes CPU and some",
    "\t\t# clients reject a gzipped application/dns-message outright.",
    "\t\tgzip off;",
    "\t}",
    "}",
    "",
  ].join("\n");
}

export { DNS_MESSAGE };
