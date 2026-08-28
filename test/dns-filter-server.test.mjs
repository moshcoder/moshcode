/**
 * What a blocked name looks like on the wire.
 *
 * The filter sits above the fork between "a Moshpit name we answer" and "a
 * clearnet name we forward", so these tests check both sides of it: a blocked
 * name must never reach the registry, and must never reach an upstream. The
 * second matters more than it sounds — a filter that blocks the answer but
 * still sends the query has told the tracker's nameserver everything anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { createFilter } from "../src/dns-filter.mjs";
import { blockedReply, createServer, encodeName, parseQuery } from "../src/dns.mjs";

const TYPE_A = 1;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_HTTPS = 65;
const RCODE_OK = 0;
const RCODE_NXDOMAIN = 3;
const RCODE_REFUSED = 5;

function query(name, { id = 0x4242, type = TYPE_A, cls = 1, rd = true } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(rd ? 0x0100 : 0, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(cls, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

const rcode = (reply) => reply.readUInt16BE(2) & 0x0f;
const answers = (reply) => reply.readUInt16BE(6);

async function ask(server, buf) {
  const client = dgram.createSocket("udp4");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 5000);
      client.once("message", (msg) => { clearTimeout(timer); resolve(msg); });
      client.send(buf, server.port, "127.0.0.1");
    });
  } finally {
    client.close();
  }
}

/** A registry that answers everything, and counts every time it is asked. */
function registry(target = "203.0.113.7") {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ name_registered: true, target }) };
    },
  };
}

const blocking = (names, mode = "nxdomain") =>
  createFilter({ mode, lists: new Map([["ads", new Set(names)]]) });

async function serve(t, extra = {}) {
  const server = await createServer({ port: 0, parkingAddress: "198.51.100.9", ...extra });
  t.after(() => server.close());
  return server;
}

test("a blocked name answers NXDOMAIN and never reaches the registry", async (t) => {
  const reg = registry();
  const server = await serve(t, { fetchImpl: reg.fetchImpl, filter: blocking(["ads.example.com"]) });
  const reply = await ask(server, query("beacon.ads.example.com"));
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
  assert.equal(answers(reply), 0);
  assert.deepEqual(reg.calls, [], "a blocked name must not be looked up anywhere");
});

test("the reply carries the question and the transaction id back", async (t) => {
  const server = await serve(t, { fetchImpl: registry().fetchImpl, filter: blocking(["ads.example.com"]) });
  const asked = query("ads.example.com", { id: 0x0bad });
  const reply = await ask(server, asked);
  assert.equal(reply.readUInt16BE(0), 0x0bad, "a mismatched id is dropped by the client as someone else's answer");
  assert.equal(reply.readUInt16BE(4), 1, "the question count must survive");
  // `parseQuery` refuses a response, so the question is compared as bytes.
  assert.deepEqual(reply.subarray(12), asked.subarray(12), "the question is echoed verbatim");
});

test("a blocked clearnet name is not forwarded to an upstream", async (t) => {
  // An upstream that would answer if it were ever asked. Nothing should arrive.
  const upstream = dgram.createSocket("udp4");
  const seen = [];
  upstream.on("message", (msg, rinfo) => {
    seen.push(parseQuery(msg)?.name);
    upstream.send(msg, rinfo.port, rinfo.address);
  });
  await new Promise((done) => upstream.bind(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => upstream.close(done)));

  const server = await serve(t, {
    fetchImpl: registry().fetchImpl,
    upstreams: [`127.0.0.1:${upstream.address().port}`],
    tldSet: new Set(["eggs"]),
    filter: blocking(["tracker.example.com"]),
  });
  const reply = await ask(server, query("cdn.tracker.example.com"));
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
  assert.deepEqual(seen, [], "the query must not leave the machine");
});

test("an unblocked name is served exactly as before", async (t) => {
  const reg = registry("203.0.113.7");
  const server = await serve(t, { fetchImpl: reg.fetchImpl, filter: blocking(["ads.example.com"]) });
  const reply = await ask(server, query("scrambled.eggs"));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 1);
  assert.equal(reg.calls.length, 1);
});

test("a Moshpit name can be blocked too — the filter is above the fork", async (t) => {
  const reg = registry();
  const server = await serve(t, {
    fetchImpl: reg.fetchImpl,
    filter: createFilter({ block: ["scrambled.eggs"] }),
  });
  const reply = await ask(server, query("scrambled.eggs"));
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
  assert.deepEqual(reg.calls, []);
});

test("zero mode answers an address that goes nowhere", async (t) => {
  const server = await serve(t, { fetchImpl: registry().fetchImpl, filter: blocking(["ads.example.com"], "zero") });
  const v4 = await ask(server, query("ads.example.com"));
  assert.equal(rcode(v4), RCODE_OK);
  assert.equal(answers(v4), 1);
  assert.equal(Array.from(v4.subarray(v4.length - 4)).join("."), "0.0.0.0");

  const v6 = await ask(server, query("ads.example.com", { type: TYPE_AAAA }));
  assert.equal(answers(v6), 1);
  assert.ok(v6.subarray(v6.length - 16).every((byte) => byte === 0), ":: is 16 zero bytes");
});

test("zero mode gives NODATA to a question an address cannot answer", async (t) => {
  const server = await serve(t, { fetchImpl: registry().fetchImpl, filter: blocking(["ads.example.com"], "zero") });
  for (const type of [TYPE_HTTPS, TYPE_TXT]) {
    const reply = await ask(server, query("ads.example.com", { type }));
    assert.equal(rcode(reply), RCODE_OK, "the name still exists in this mode");
    assert.equal(answers(reply), 0);
  }
});

test("refuse mode says so, which is the only mode a client can tell apart", async (t) => {
  const server = await serve(t, { fetchImpl: registry().fetchImpl, filter: blocking(["ads.example.com"], "refuse") });
  const reply = await ask(server, query("ads.example.com"));
  assert.equal(rcode(reply), RCODE_REFUSED);
});

test("no filter at all leaves the query path untouched", async (t) => {
  const reg = registry();
  const server = await serve(t, { fetchImpl: reg.fetchImpl });
  const reply = await ask(server, query("scrambled.eggs"));
  assert.equal(rcode(reply), RCODE_OK);
});

test("the block is reported to onQuery with the rule that caused it", async (t) => {
  const seen = [];
  const server = await serve(t, {
    fetchImpl: registry().fetchImpl,
    filter: blocking(["ads.example.com"]),
    onQuery: (event) => seen.push(event),
  });
  await ask(server, query("deep.ads.example.com"));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].blocked, { list: "ads", rule: "ads.example.com", mode: "nxdomain" });
});

test("blockedReply defaults to NXDOMAIN for a mode it does not know", () => {
  const buf = query("ads.example.com");
  const reply = blockedReply(parseQuery(buf), buf, "something-else");
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
});
