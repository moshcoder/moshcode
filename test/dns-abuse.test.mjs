// Guards for a resolver that strangers can reach.
//
// An open forwarding resolver is a DDoS amplifier before it is anything else,
// and the attack needs no botnet: one host spoofs a victim's source address,
// sends a small query, and the resolver mails the large answer to the victim.
//
// That shape rules out most defences. The source address is a lie, so blocking
// "the client" punishes the victim; there is no session to fingerprint and no
// user agent to read. What is left is bounding the amplification a single query
// can buy, and what one source can extract before we stop answering.
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import {
  TYPE_A, TYPE_ANY, capResponse, createRateLimiter, createServer, encodeName,
  parseQuery, refusalReason,
} from "../src/dns.mjs";

function query(name, type = TYPE_A, id = 0x1234) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x0100, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

const okJson = (b) => async () => ({ ok: true, json: async () => b });
const rcode = (b) => b.readUInt16BE(2) & 0x000f;

async function ask(server, name, type = TYPE_A) {
  const client = dgram.createSocket("udp4");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 4000);
      client.once("message", (m) => { clearTimeout(timer); resolve(m); });
      client.send(query(name, type), server.port, "127.0.0.1");
    });
  } finally {
    client.close();
  }
}

/* ------------------------------------------------------------------- ANY */

test("ANY is refused — it exists to be amplified", () => {
  // A 30-byte question for every record a name holds. Real clients stopped
  // needing it years ago and RFC 8482 blesses refusing it.
  assert.match(refusalReason({ type: TYPE_ANY }), /ANY is refused/);
  assert.equal(refusalReason({ type: TYPE_A }), null);
  assert.equal(refusalReason(null), null);
});

test("ANY gets REFUSED over the wire, not silence", async (t) => {
  // Silence costs a real client a full resolver timeout before it tries
  // elsewhere, and costs an attacker nothing — they were never waiting.
  const server = await createServer({ port: 0, fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }) });
  t.after(() => server.close());
  assert.equal(rcode(await ask(server, "blue.eggs", TYPE_ANY)), 5, "REFUSED");
  assert.equal(rcode(await ask(server, "blue.eggs", TYPE_A)), 0, "ordinary query unaffected");
});

/* ------------------------------------------------------------ rate limit */

test("a source is cut off once its bucket empties, and recovers with time", () => {
  let clock = 0;
  const limiter = createRateLimiter({ perSecond: 10, burst: 3, now: () => clock });

  assert.equal(limiter.allow("1.2.3.4"), true);
  assert.equal(limiter.allow("1.2.3.4"), true);
  assert.equal(limiter.allow("1.2.3.4"), true);
  assert.equal(limiter.allow("1.2.3.4"), false, "burst spent");

  // One source running dry must not affect another.
  assert.equal(limiter.allow("5.6.7.8"), true);

  clock += 1000; // ten tokens back, capped at the burst ceiling
  assert.equal(limiter.allow("1.2.3.4"), true, "refilled");
});

test("the bucket map is bounded, because spoofed sources are unlimited", () => {
  // The part worth being careful about: keyed by source address, with forged
  // sources, an unbounded map is a memory exhaustion bug wearing a rate
  // limiter's clothes.
  const limiter = createRateLimiter({ maxClients: 50, burst: 1 });
  for (let i = 0; i < 5000; i++) limiter.allow(`10.0.${(i >> 8) & 255}.${i & 255}`);
  assert.ok(limiter.size <= 50, `map grew to ${limiter.size}`);
});

test("rate limiting refuses over the wire once the burst is gone", async (t) => {
  const server = await createServer({
    port: 0,
    rateLimit: { perSecond: 0, burst: 2 },
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  t.after(() => server.close());

  assert.equal(rcode(await ask(server, "blue.eggs")), 0);
  assert.equal(rcode(await ask(server, "blue.eggs")), 0);
  assert.equal(rcode(await ask(server, "blue.eggs")), 5, "third is REFUSED");
});

test("no rate limit configured means none applied", async (t) => {
  // A loopback bridge has one client; limiting it is pure cost.
  const server = await createServer({ port: 0, fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }) });
  t.after(() => server.close());
  for (let i = 0; i < 12; i++) assert.equal(rcode(await ask(server, "blue.eggs")), 0, `query ${i}`);
});

/* --------------------------------------------------------- response size */

test("an oversized answer is truncated with TC, not mailed at full size", () => {
  // Amplification is a ratio, so the ceiling on an answer is the ceiling on
  // the attack. TC tells a real client to retry over TCP, where the handshake
  // makes a spoofed source useless: legitimate case retries, abusive case
  // dead-ends.
  const buf = query("blue.eggs");
  const parsed = parseQuery(buf);
  const huge = Buffer.concat([buf, Buffer.alloc(4000, 0xaa)]);
  huge.writeUInt16BE(40, 6); // claims 40 answers

  const capped = capResponse(huge, parsed, 512);
  assert.ok(capped.length < 512, `still ${capped.length} bytes`);
  assert.equal((capped.readUInt16BE(2) & 0x0200) !== 0, true, "TC set");
  assert.equal(capped.readUInt16BE(6), 0, "no answers survive the cut");
  assert.equal(capped.readUInt16BE(0), 0x1234, "id echoed so the client matches it");

  // Under the limit, nothing is touched.
  const small = Buffer.concat([buf, Buffer.alloc(10)]);
  assert.equal(capResponse(small, parsed, 512), small);
});

/* ------------------------------------------------- fail2ban with backoff */

test("IPv6 clients are grouped by /64, because one address is free to change", async () => {
  const { clientKey } = await import("../src/dns.mjs");
  // The bug this prevents: banning 2604:...::1 while the same host walks to
  // ::2. Any host worth banning holds a /64 at minimum, so a per-address ban
  // is defeated by incrementing — and it fails silently, because the bans look
  // like they are being applied.
  const a = clientKey("2604:a880:400:d1:0:4:c3fe:1");
  const b = clientKey("2604:a880:400:d1:ffff:ffff:ffff:ffff");
  assert.equal(a, b, "same /64 is the same client");
  assert.notEqual(a, clientKey("2604:a880:400:d2:0:4:c3fe:1"), "a different /64 is not");

  // v4 stays per-address: a /24 spans unrelated customers behind carrier NAT,
  // so widening there punishes an abuser's neighbours.
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.notEqual(clientKey("203.0.113.7"), clientKey("203.0.113.8"));

  // A v4-mapped address is a v4 client on a dual-stack socket.
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey(""), "");
});

test("each strike doubles the ban, and a clean spell forgets", async () => {
  const { createBanList } = await import("../src/dns.mjs");
  let clock = 0;
  const bans = createBanList({ baseMs: 1000, factor: 2, maxMs: 8000, forgetMs: 10_000, now: () => clock });

  // A flat limit is a toll an attacker pays and returns from. Backoff makes
  // persistence expensive.
  assert.equal(bans.strike("x").banMs, 1000);
  assert.equal(bans.strike("x").banMs, 2000);
  assert.equal(bans.strike("x").banMs, 4000);
  assert.equal(bans.strike("x").banMs, 8000);
  assert.equal(bans.strike("x").banMs, 8000, "capped, not unbounded");

  assert.equal(bans.banned("x"), true);
  clock += 8001;
  assert.equal(bans.banned("x"), false, "ban expires");

  // Without decay the ceiling is permanent and one bad afternoon is
  // unforgivable.
  clock += 20_000;
  assert.equal(bans.strike("x").banMs, 1000, "slate wiped after a clean spell");
});

test("the ban table is bounded too", async () => {
  const { createBanList } = await import("../src/dns.mjs");
  const bans = createBanList({ maxClients: 40 });
  for (let i = 0; i < 3000; i++) bans.strike(`2001:db8:0:${i.toString(16)}::/64`);
  assert.ok(bans.size <= 40, `grew to ${bans.size}`);
});

test("a banned source stays refused even when its bucket has refilled", async (t) => {
  // The point of the ban: without it, a source that empties its bucket simply
  // waits for a refill and continues. With it, the wait grows each time.
  const server = await createServer({
    port: 0,
    // Slow enough that three rapid queries outrun the refill, fast enough
    // that the bucket is demonstrably full again before the last assertion.
    rateLimit: { perSecond: 20, burst: 2 },
    ban: { baseMs: 60_000, factor: 2 },
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  t.after(() => server.close());

  assert.equal(rcode(await ask(server, "blue.eggs")), 0);
  assert.equal(rcode(await ask(server, "blue.eggs")), 0);
  assert.equal(rcode(await ask(server, "blue.eggs")), 5, "burst spent — struck");

  // 300ms buys six tokens at 20/s, so the bucket is full again. Only the ban
  // is keeping this source out now.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rcode(await ask(server, "blue.eggs")), 5, "still banned");
});
