// DNS over HTTPS for Moshpit names.
//
// The case this exists for: a browser with Secure DNS on never asks the system
// resolver, so a machine running the bridge perfectly still cannot open a
// Moshpit name — curl resolves it, the browser does not. A DoH endpoint that
// knows both namespaces resolves it *through* DoH instead of being defeated.
import test from "node:test";
import assert from "node:assert/strict";

import { createDohHandler, decodeRequest, cacheControl, DNS_MESSAGE } from "../src/doh.mjs";
import { encodeName, TYPE_A, TYPE_AAAA } from "../src/dns.mjs";

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
const answers = (b) => b.readUInt16BE(6);

test("both transports RFC 8484 requires are accepted", () => {
  // Browsers mostly POST; resolvers and every curl example use GET. A resolver
  // that only speaks one of them fails for half its clients.
  const message = query("blue.eggs");
  const post = decodeRequest({ method: "POST", body: message });
  assert.equal(post.ok, true);
  assert.equal(Buffer.compare(post.message, message), 0);

  const get = decodeRequest({ method: "GET", url: `/dns-query?dns=${message.toString("base64url")}` });
  assert.equal(get.ok, true);
  assert.equal(Buffer.compare(get.message, message), 0);
});

test("junk is rejected before it reaches the resolver", () => {
  assert.equal(decodeRequest({ method: "GET", url: "/dns-query" }).status, 400, "no ?dns=");
  assert.equal(decodeRequest({ method: "POST", body: Buffer.alloc(0) }).status, 400, "empty body");
  assert.equal(decodeRequest({ method: "PUT", body: Buffer.alloc(4) }).status, 405);
  // A large body is a memory question before it is a DNS question.
  assert.equal(decodeRequest({ method: "POST", body: Buffer.alloc(9000) }).status, 413);
});

test("a Moshpit name is answered, with its target", async () => {
  const handle = createDohHandler({
    tldSet: new Set(["eggs"]),
    fetchImpl: okJson({ name_registered: true, target: "2606:4700:4700::1111" }),
  });
  const res = await handle({ method: "POST", body: query("blue.eggs", TYPE_AAAA) });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], DNS_MESSAGE);
  assert.equal(answers(res.body), 1);
  assert.deepEqual([...res.body.subarray(res.body.length - 16).subarray(0, 4)], [0x26, 0x06, 0x47, 0x00]);
});

test("a clearnet name is forwarded, not answered here", async () => {
  // The same gate as the UDP path: google.com has two labels exactly like
  // blue.eggs does, so parsing alone would have this answer for the internet.
  let forwarded = null;
  const handle = createDohHandler({
    tldSet: new Set(["eggs"]),
    upstreams: ["203.0.113.9"],
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  // No upstream will answer 203.0.113.9, so this proves it *tried* to forward
  // rather than answering from the registry.
  const res = await handle({ method: "POST", body: query("google.com"), address: "198.51.100.4" });
  assert.equal(res.status, 502, "forwarded and got nothing, rather than inventing an answer");
});

test("answers are cacheable only as long as the record lives", () => {
  // A Moshpit target changes the moment its owner repoints it, and a stale
  // answer is the one failure nobody can debug from outside.
  assert.equal(cacheControl(30), "max-age=30");
  assert.equal(cacheControl(0), "max-age=0");
});

test("rate limiting answers REFUSED in DNS, not an HTTP error", async () => {
  // A client that asked for a DNS message and got an HTTP 429 mostly throws.
  // REFUSED is a thing every resolver already knows how to retry past.
  const handle = createDohHandler({
    tldSet: new Set(["eggs"]),
    rateLimit: { perSecond: 0, burst: 1 },
    ban: { baseMs: 60_000 },
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  const first = await handle({ method: "POST", body: query("blue.eggs"), address: "203.0.113.5" });
  assert.equal(answers(first.body), 1);

  const second = await handle({ method: "POST", body: query("blue.eggs"), address: "203.0.113.5" });
  assert.equal(second.status, 200, "still a DNS message");
  assert.equal(rcode(second.body), 5, "REFUSED");
  assert.equal(second.headers["cache-control"], "no-store", "a refusal must not be cached");
});

test("IPv6 clients are limited by /64, as on the UDP side", async () => {
  const handle = createDohHandler({
    tldSet: new Set(["eggs"]),
    rateLimit: { perSecond: 0, burst: 1 },
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  await handle({ method: "POST", body: query("blue.eggs"), address: "2001:db8:1:2::1" });
  // Same /64, different address: a per-address limit would let this through.
  const next = await handle({ method: "POST", body: query("blue.eggs"), address: "2001:db8:1:2::99" });
  assert.equal(rcode(next.body), 5, "moving within the prefix does not buy a fresh bucket");
});
