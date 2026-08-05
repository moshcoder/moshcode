// The HTTP half of the DoH resolver.
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

import { clientAddress, createDohServer, nginxDohSite, DOH_PATH } from "../src/doh-server.mjs";
import { encodeName, TYPE_A } from "../src/dns.mjs";
import { DNS_MESSAGE } from "../src/doh.mjs";

function query(name) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x1234, 0);
  head.writeUInt16BE(0x0100, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_A, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

test("the client's address comes from the proxy, not the socket", () => {
  // Behind a reverse proxy every request arrives from 127.0.0.1, so limiting
  // on the socket address puts every client in one bucket — one abusive source
  // locks out everyone.
  const req = {
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(clientAddress(req), "203.0.113.9", "first hop is the client");

  // Only when a proxy is actually in front. Trusting the header on a directly
  // exposed socket lets any client forge its own identity and its own quota.
  assert.equal(clientAddress(req, { trustProxy: false }), "127.0.0.1");
  assert.equal(clientAddress({ socket: { remoteAddress: "198.51.100.2" } }), "198.51.100.2");
});

test("it answers on the DoH path and 404s everywhere else", async (t) => {
  const server = await createDohServer({
    port: 0,
    handler: async () => ({ status: 200, headers: { "content-type": DNS_MESSAGE }, body: Buffer.from([1, 2, 3]) }),
  });
  t.after(() => server.close());

  const ok = await fetch(`http://127.0.0.1:${server.port}${DOH_PATH}`, {
    method: "POST",
    headers: { "content-type": DNS_MESSAGE },
    body: query("blue.eggs"),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), DNS_MESSAGE);

  const elsewhere = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(elsewhere.status, 404);
});

test("an oversized body is refused rather than buffered", async (t) => {
  // The cap is the point: a client sending megabytes to a DNS endpoint is not
  // a client, and buffering it first would make the limit decorative.
  const server = await createDohServer({
    port: 0,
    handler: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
  });
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.port}${DOH_PATH}`, {
    method: "POST",
    body: Buffer.alloc(200_000),
  }).catch(() => ({ status: 413 }));
  assert.equal(res.status, 413);
});

test("it binds loopback by default, never a public address", async (t) => {
  // A DoH endpoint reachable directly is an open resolver without the rate
  // limits its proxy was going to apply. Scanners find those in hours.
  const server = await createDohServer({ port: 0, handler: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }) });
  t.after(() => server.close());
  assert.equal(server.address, "127.0.0.1");
});

test("the nginx block forwards the client and does not compress", () => {
  const conf = nginxDohSite({ name: "dns.moshcode.sh", port: 8053 });
  // Both lines people miss, and both silently break something.
  assert.match(conf, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(conf, /gzip off;/);
  assert.match(conf, new RegExp(`location ${DOH_PATH} \\{`));
});

test("the default block is one nginx will actually load", () => {
  const conf = nginxDohSite({ name: "dns.moshcode.sh", port: 8053 });

  // `listen 443 ssl` with no ssl_certificate is not a config with a missing
  // line — nginx refuses to load it, so `nginx -t` fails and a reload takes
  // every other site on the box down with it. And certbot cannot rescue it:
  // `certbot --nginx` has to find a loadable vhost before it can issue the
  // certificate that would make it loadable. Emitting port 80 is the only
  // form with a way in.
  assert.doesNotMatch(conf, /listen (\[::\]:)?443 ssl;/,
    "must not emit a TLS listener it has no certificate for");
  assert.match(conf, /^\tlisten 80;$/m);
  assert.match(conf, /^\tlisten \[::\]:80;$/m);
  assert.match(conf, /certbot --nginx -d dns\.moshcode\.sh/,
    "and must say how the TLS half arrives");
});

test("--tls emits the certified form for a host provisioned elsewhere", () => {
  const conf = nginxDohSite({ name: "dns.moshcode.sh", port: 8053, tls: true });

  // The invariant is the pairing, not the port: a TLS listener may be emitted
  // only alongside the certificate that makes it loadable.
  assert.match(conf, /^\tlisten 443 ssl;$/m);
  assert.match(conf, /^\tlisten \[::\]:443 ssl;$/m);
  assert.match(conf, /ssl_certificate\s+\/etc\/letsencrypt\/live\/dns\.moshcode\.sh\/fullchain\.pem;/);
  assert.match(conf, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/dns\.moshcode\.sh\/privkey\.pem;/);
});

test("guards are on by default, because an open resolver is found in hours", async () => {
  const { DEFAULT_GUARDS, parseGuardArgs } = await import("../src/doh-server.mjs");

  // The bridge can default them off — it listens on loopback and has one
  // client. This is meant to be reachable, so the safe configuration has to be
  // the one you get by not thinking about it.
  const defaults = parseGuardArgs([]);
  assert.deepEqual(defaults.rateLimit, DEFAULT_GUARDS.rateLimit);
  assert.ok(defaults.ban.baseMs > 0);
  assert.equal(defaults.maxResponseBytes, 1232, "caps amplification at the flag-day payload size");

  // Tunable without being disabled by accident.
  const tuned = parseGuardArgs(["--rate", "5", "--burst", "10", "--ban-seconds", "300"]);
  assert.equal(tuned.rateLimit.perSecond, 5);
  assert.equal(tuned.rateLimit.burst, 10);
  assert.equal(tuned.ban.baseMs, 300_000);

  // Turning them off must be explicit — an unlimited open resolver is a
  // decision, and the caller has to have typed it.
  const off = parseGuardArgs(["--no-guards"]);
  assert.equal(off.rateLimit, null);
  assert.equal(off.ban, null);
  assert.equal(off.maxResponseBytes, 0);

  // Junk values fall back rather than disabling anything: `--rate banana`
  // must not quietly become an unlimited resolver.
  assert.equal(parseGuardArgs(["--rate", "banana"]).rateLimit.perSecond, DEFAULT_GUARDS.rateLimit.perSecond);
  assert.equal(parseGuardArgs(["--rate", "-5"]).rateLimit.perSecond, DEFAULT_GUARDS.rateLimit.perSecond);
});

test("a server built with defaults actually enforces them", async (t) => {
  // Not just parsed — reaching the handler. A default that is read and then
  // dropped on the floor is worse than no default, because it reads as safe.
  const server = await createDohServer({ port: 0, rateLimit: { perSecond: 0, burst: 1 } });
  t.after(() => server.close());

  const ask = () => fetch(`http://127.0.0.1:${server.port}${DOH_PATH}`, {
    method: "POST",
    headers: { "content-type": DNS_MESSAGE, "x-forwarded-for": "203.0.113.77" },
    body: query("blue.eggs"),
  });

  await ask();
  const limited = await ask();
  const body = Buffer.from(await limited.arrayBuffer());
  assert.equal(body.readUInt16BE(2) & 0x000f, 5, "REFUSED once the burst is spent");
});

test("overriding one guard keeps the guards you did not mention", async (t) => {
  // A caller mounting this programmatically may tune a single guard and leave
  // the rest at their defaults. The un-mentioned guards have to stay the safe
  // defaults `server.guards` reports, not silently fall to the handler's own
  // off-by-default null/null/0 — a resolver that says it rate limits and does
  // not is exactly the open resolver these guards exist to prevent.
  const registry = http.createServer((req, res) => {
    // The only thing the resolver needs from the registry here is that our
    // ending is ours, so a query for it reaches the handler as an answerable
    // name (NXDOMAIN) rather than a not-ours REFUSED, which rate limiting also
    // returns and would mask the very thing under test.
    if ((req.url || "").startsWith("/api/moshpit/tlds")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tlds: ["moshtest"], total: 1 }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
  await new Promise((r) => registry.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => registry.close(r)));
  const registryBase = `http://127.0.0.1:${registry.address().port}`;

  // Override only maxResponseBytes; rateLimit is left unmentioned.
  const server = await createDohServer({ port: 0, registryBase, maxResponseBytes: 4096 });
  t.after(() => server.close());
  assert.deepEqual(server.guards.rateLimit, { perSecond: 20, burst: 40 },
    "reports the default rate limit is in force");

  const ask = () => fetch(`http://127.0.0.1:${server.port}${DOH_PATH}`, {
    method: "POST",
    headers: { "content-type": DNS_MESSAGE, "x-forwarded-for": "198.51.100.9" },
    body: query("x.moshtest"),
  });
  // Default burst is 40. Fire well past it at once so token refill during the
  // run cannot stand in for a limiter that was dropped.
  const rcodes = await Promise.all(
    Array.from({ length: 120 }, () => ask().then(async (r) =>
      Buffer.from(await r.arrayBuffer()).readUInt16BE(2) & 0x000f)),
  );
  assert.ok(rcodes.some((c) => c !== 5),
    "an ours-name below the limit is answered, not REFUSED");
  assert.ok(rcodes.some((c) => c === 5),
    "the unmentioned default rate limit still REFUSES once the burst is spent");
});
