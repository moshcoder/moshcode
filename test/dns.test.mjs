import test from "node:test";
import assert from "node:assert/strict";

import {
  answerFor,
  buildResponse,
  createServer,
  decodeName,
  dnsmasqConf,
  encodeName,
  fetchTlds,
  parseQuery,
  parseRegistryName,
  resolveName,
  resolvedConf,
} from "../src/dns.mjs";

/** A minimal A/IN query, the way a resolver would send it. */
function query(name, { id = 0x1234, type = 1, cls = 1, rd = true } = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(rd ? 0x0100 : 0, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(cls, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test("names round-trip through the wire codec", () => {
  const buf = encodeName("california.oranges");
  assert.deepEqual(decodeName(buf, 0), { name: "california.oranges", offset: buf.length });
});

test("a trailing dot is not part of the name", () => {
  assert.equal(decodeName(encodeName("a.eggs."), 0).name, "a.eggs");
});

test("parseQuery reads the question", () => {
  const q = parseQuery(query("california.oranges"));
  assert.equal(q.name, "california.oranges");
  assert.equal(q.id, 0x1234);
  assert.equal(q.type, 1);
  assert.equal(q.recursionDesired, true);
});

test("parseQuery refuses what it must not answer", () => {
  assert.equal(parseQuery(Buffer.alloc(4)), null, "truncated");
  const response = query("a.eggs");
  response.writeUInt16BE(0x8400, 2);
  assert.equal(parseQuery(response), null, "a response, not a query");
  const twoQuestions = query("a.eggs");
  twoQuestions.writeUInt16BE(2, 4);
  assert.equal(parseQuery(twoQuestions), null, "more than one question");
});

test("a compression pointer in a question is rejected, not followed", () => {
  const evil = Buffer.concat([query("a.eggs").subarray(0, 12), Buffer.from([0xc0, 0x0c])]);
  assert.equal(parseQuery(evil), null);
});

test("buildResponse answers with an A record", () => {
  const buf = query("a.eggs");
  const res = buildResponse(parseQuery(buf), buf, "203.0.113.7", 30);
  assert.equal(res.readUInt16BE(0), 0x1234, "id echoed");
  assert.equal(res.readUInt16BE(6), 1, "one answer");
  assert.equal((res.readUInt16BE(2) & 0x000f) >>> 0, 0, "RCODE 0");
  assert.deepEqual([...res.subarray(res.length - 4)], [203, 0, 113, 7]);
});

test("buildResponse says NXDOMAIN when there is no address", () => {
  const buf = query("a.eggs");
  const res = buildResponse(parseQuery(buf), buf, null);
  assert.equal(res.readUInt16BE(6), 0, "no answers");
  assert.equal(res.readUInt16BE(2) & 0x000f, 3, "RCODE 3");
});

test("only registry-shaped names are ours to answer", () => {
  assert.deepEqual(parseRegistryName("california.oranges"), { label: "california", tld: "oranges" });
  assert.equal(parseRegistryName("a.b.c"), null);
  assert.equal(parseRegistryName("localhost"), null);
  assert.equal(parseRegistryName("127.0.0.1"), null);
});

test("a pointed name resolves to its target", async () => {
  const r = await resolveName("a.eggs", {
    fetchImpl: okJson({ name_registered: true, target: "203.0.113.7" }),
  });
  assert.deepEqual(r, { status: "live", target: "203.0.113.7" });
});

test("a claimed name with no target is parked, not broken", async () => {
  // Verbatim from the live registry.
  const r = await resolveName("california.oranges", {
    fetchImpl: okJson({
      name: "california.oranges",
      resolved: "california.oranges",
      aliased: false,
      registered: true,
      name_registered: true,
      target: null,
      mode: "clearnet",
      prefer: "fallback",
    }),
  });
  assert.equal(r.status, "parked");
});

test("name_registered wins over the TLD-level registered flag", async () => {
  const r = await resolveName("x.eggs", {
    fetchImpl: okJson({ registered: true, name_registered: false, target: null }),
  });
  assert.equal(r.status, "parked");
  assert.equal(r.registered, false);
});

test("an unreachable registry is not mistaken for a parked name", async () => {
  const r = await resolveName("a.eggs", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(r.status, "unreachable");
});

test("answerFor sends parked names to the parking address", async () => {
  const opts = { parkingAddress: "198.51.100.9", fetchImpl: okJson({ name_registered: true, target: null }) };
  assert.equal(await answerFor("california.oranges", opts), "198.51.100.9");
});

test("answerFor NXDOMAINs an unreachable registry rather than parking everything", async () => {
  const address = await answerFor("a.eggs", {
    parkingAddress: "198.51.100.9",
    fetchImpl: async () => {
      throw new Error("down");
    },
  });
  assert.equal(address, null, "a registry outage must not redirect the machine to a parking page");
});

test("fetchTlds reads the Pit's TLD list", async () => {
  const tlds = await fetchTlds({
    fetchImpl: okJson({ tlds: [{ tld: "Install" }, { tld: "agent" }, "eggs"] }),
  });
  assert.deepEqual(tlds, ["agent", "eggs", "install"]);
});

test("resolver config routes only the claimed TLDs", () => {
  const conf = resolvedConf(["eggs", "agent"], { port: 5354 });
  assert.match(conf, /DNS=127\.0\.0\.1:5354/);
  assert.match(conf, /Domains=~eggs ~agent/);
  assert.deepEqual(
    dnsmasqConf(["eggs"], { port: 5354 }).split("\n").filter((l) => l.startsWith("server=")),
    ["server=/eggs/127.0.0.1#5354"],
  );
});

test("the server answers a real query over UDP", async (t) => {
  const dgram = await import("node:dgram");
  const server = await createServer({
    port: 0,
    parkingAddress: "198.51.100.9",
    fetchImpl: okJson({ name_registered: true, target: null }),
  });
  t.after(() => server.close());

  const client = dgram.createSocket("udp4");
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply")), 5000);
    client.once("message", (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    client.send(query("california.oranges"), server.port, "127.0.0.1");
  });
  client.close();

  assert.equal(reply.readUInt16BE(6), 1, "answered");
  assert.deepEqual([...reply.subarray(reply.length - 4)], [198, 51, 100, 9], "parked → parking IP");
});
