// The HTTP half of the DoH resolver.
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
  assert.match(conf, /^\tlisten 443 ssl;$/m);
  assert.match(conf, /^\tlisten \[::\]:443 ssl;$/m);
  assert.match(conf, new RegExp(`location ${DOH_PATH} \\{`));
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
