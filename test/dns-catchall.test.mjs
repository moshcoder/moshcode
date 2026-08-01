// Catch-all routing: the bridge as the machine's resolver rather than an oracle
// for a list of endings.
//
// Routing each claimed ending by name did not survive the registry growing —
// systemd-resolved caps how many search domains it accepts, took 1090 of 4586
// alphabetically, and rejected the rest one journal line at a time while
// reporting success. `~.` is one entry that never grows.
//
// The bill for that is this file. Every lookup on the machine now arrives here,
// so the tests that matter are the ones about what the bridge must NOT answer.
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import {
  createServer,
  dnsmasqCatchAllConf,
  encodeName,
  forwardQuery,
  isOurs,
  parseUpstreams,
  resolvedCatchAllConf,
  TYPE_A,
} from "../src/dns.mjs";

function query(name, { id = 0x1234, type = TYPE_A } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x0100, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });
const rcode = (b) => b.readUInt16BE(2) & 0x000f;
const answers = (b) => b.readUInt16BE(6);

async function ask(server, name, type = TYPE_A) {
  const client = dgram.createSocket("udp4");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 5000);
      client.once("message", (m) => { clearTimeout(timer); resolve(m); });
      client.send(query(name, { type }), server.port, "127.0.0.1");
    });
  } finally {
    client.close();
  }
}

/** A stand-in upstream that answers everything with one fixed A record. */
async function fakeUpstream(address = "203.0.113.55") {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (msg, rinfo) => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(msg.readUInt16BE(0), 0);
    head.writeUInt16BE(0x8180, 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(1, 6);
    let i = 12;
    while (msg[i] !== 0) i += msg[i] + 1;
    const question = msg.subarray(12, i + 5);
    const answer = Buffer.alloc(12);
    answer.writeUInt16BE(0xc00c, 0);
    answer.writeUInt16BE(1, 2);
    answer.writeUInt16BE(1, 4);
    answer.writeUInt32BE(60, 6);
    answer.writeUInt16BE(4, 10);
    socket.send(
      Buffer.concat([head, question, answer, Buffer.from(address.split(".").map(Number))]),
      rinfo.port, rinfo.address,
    );
  });
  await new Promise((r) => socket.bind(0, "127.0.0.1", r));
  return { port: socket.address().port, close: () => new Promise((d) => socket.close(d)) };
}

/* ------------------------------------------------------------ the safety gate */

test("a clearnet name is never ours, however much it looks like a Moshpit one", () => {
  // The whole risk of catch-all routing in one assertion: `google.com` has
  // exactly two labels, same as `blue.eggs`. Parsing alone would have the
  // bridge answer for the internet.
  const claimed = new Set(["eggs", "oranges", "hacker"]);
  for (const name of ["google.com", "example.org", "news.ycombinator.com", "a.io"]) {
    assert.equal(isOurs(name, claimed), false, name);
  }
  assert.equal(isOurs("blue.eggs", claimed), true);
  assert.equal(isOurs("chovy.hacker", claimed), true);
});

test("an unknown ending set means not ours, never ours", () => {
  // Failing this way costs a Moshpit name until the registry answers again.
  // Failing the other way costs the whole internet on that machine.
  for (const set of [null, undefined, new Set(), "eggs", []]) {
    assert.equal(isOurs("blue.eggs", set), false, String(set));
  }
});

/* --------------------------------------------------------------- forwarding */

test("a clearnet lookup is relayed to the upstream and back", async (t) => {
  const upstream = await fakeUpstream("203.0.113.55");
  t.after(() => upstream.close());
  const server = await createServer({
    port: 0,
    upstreams: [`127.0.0.1#${upstream.port}`],
    tldSet: new Set(["eggs"]),
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  t.after(() => server.close());

  const reply = await ask(server, "google.com");
  assert.equal(rcode(reply), 0);
  assert.equal(answers(reply), 1);
  assert.deepEqual([...reply.subarray(reply.length - 4)], [203, 0, 113, 55], "the upstream's answer");
});

test("a Moshpit name is answered here, not forwarded", async (t) => {
  const upstream = await fakeUpstream("203.0.113.55");
  t.after(() => upstream.close());
  const server = await createServer({
    port: 0,
    upstreams: [`127.0.0.1#${upstream.port}`],
    tldSet: new Set(["eggs"]),
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  t.after(() => server.close());

  const reply = await ask(server, "blue.eggs");
  assert.deepEqual([...reply.subarray(reply.length - 4)], [203, 0, 113, 7], "ours, not the upstream's");
});

test("silent upstreams are SERVFAIL, never NXDOMAIN", async (t) => {
  // "I could not find out" is retried elsewhere. "It does not exist" gets
  // cached, and the name stays broken after the network comes back.
  const server = await createServer({
    port: 0,
    upstreams: ["127.0.0.1#1"], // nothing listens there
    tldSet: new Set(["eggs"]),
    forwardTimeoutMs: 300,
    fetchImpl: okJson({ name_registered: false, target: null }),
  });
  t.after(() => server.close());

  const reply = await ask(server, "google.com");
  assert.equal(rcode(reply), 2, "SERVFAIL");
  assert.equal(answers(reply), 0);
});

test("with no upstreams configured the bridge behaves exactly as before", async (t) => {
  // The per-ending deployment still works: nothing to forward to means answer
  // only for what we are authoritative for.
  const server = await createServer({
    port: 0,
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  t.after(() => server.close());

  const reply = await ask(server, "blue.eggs");
  assert.deepEqual([...reply.subarray(reply.length - 4)], [203, 0, 113, 7]);
});

test("forwardQuery gives up rather than hanging on a dead upstream", async () => {
  const started = Date.now();
  assert.equal(await forwardQuery(query("x.eggs"), "127.0.0.1#1", { timeoutMs: 200 }), null);
  assert.ok(Date.now() - started < 4000, "returned promptly");
});

/* ------------------------------------------------------------------- config */

test("the resolver config is one line that never grows", () => {
  const conf = resolvedCatchAllConf({ port: 5354 });
  assert.match(conf, /^Domains=~\.$/m);
  assert.match(conf, /^DNS=127\.0\.0\.1:5354$/m);
  // The failure this replaces: 4586 endings on one line, of which the resolver
  // silently kept 1090.
  assert.ok(conf.length < 600, "no per-ending list to truncate");
});

test("the dnsmasq config does not inherit upstreams that point back here", () => {
  const conf = dnsmasqCatchAllConf({ port: 5354 });
  assert.match(conf, /^no-resolv$/m, "or dnsmasq loops through /etc/resolv.conf");
  assert.match(conf, /^server=127\.0\.0\.1#5354$/m);
});

test("loopback nameservers are dropped when finding upstreams", () => {
  // Once routing points here, 127.0.0.53 is the thing asking us — forwarding
  // back to it is a loop that ends in a timeout instead of an answer.
  const resolv = [
    "# generated",
    "nameserver 127.0.0.53",
    "nameserver 67.207.67.3",
    "nameserver 67.207.67.2",
    "nameserver ::1",
    "nameserver 2001:4860:4860::8888",
    "options edns0",
  ].join("\n");
  assert.deepEqual(parseUpstreams(resolv), ["67.207.67.3", "67.207.67.2", "2001:4860:4860::8888"]);
  assert.deepEqual(parseUpstreams(""), []);
  assert.deepEqual(parseUpstreams(null), []);
});

/* ---------------------------------------- noticing that the resolver said no */

test("routingShortfall names what the resolver refused to take", async () => {
  const { parseResolvectlDomains, routingShortfall, acceptedDomains } = await import("../src/dns.mjs");

  // Verbatim shape of `resolvectl domain`: a Global line, wrapped, plus links.
  const output = [
    "Global: ~eggs ~oranges ~2600",
    "        ~abex ~acid",
    "Link 2 (eth0): ~eggs",
  ].join("\n");
  assert.deepEqual(parseResolvectlDomains(output).sort(), ["2600", "abex", "acid", "eggs", "oranges"]);

  // The real failure: written and claimed agreed, so the old check was silent.
  const written = ["eggs", "oranges", "hacker", "rank", "zombies"];
  const shortfall = routingShortfall(written, ["eggs", "oranges"]);
  assert.equal(shortfall.written, 5);
  assert.equal(shortfall.accepted, 2);
  assert.deepEqual(shortfall.missing, ["hacker", "rank", "zombies"]);

  // Everything accepted is not a shortfall.
  assert.deepEqual(routingShortfall(written, written).missing, []);

  // Unknown is never "none": a box without resolvectl must not be told its
  // routing is missing.
  assert.equal(routingShortfall(written, null), null);
  assert.equal(await acceptedDomains(async () => null), null);
  assert.deepEqual(await acceptedDomains(async () => "Global: ~eggs"), ["eggs"]);
});

test("the shortfall reproduces the failure that started this", async () => {
  const { routingShortfall } = await import("../src/dns.mjs");
  // 4586 written, 1090 accepted, alphabetically — which is how ~hacker went
  // missing while `moshcode dns resolve chovy.hacker` kept answering.
  const written = Array.from({ length: 4586 }, (_, i) => `t${String(i).padStart(4, "0")}`);
  const shortfall = routingShortfall(written, written.slice(0, 1090));
  assert.equal(shortfall.missing.length, 3496);
  assert.equal(shortfall.missing[0], "t1090");
});
