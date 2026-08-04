/**
 * The address a Moshpit name actually has.
 *
 * Two gaps here made most of the registry look unregistered, and both failed
 * in the same invisible shape: an authoritative NOERROR with no answers, which
 * a client may treat as final. `dig` said the name existed; nothing could reach
 * it; no log anywhere reported an error.
 *
 *   - a published A/AAAA record was never consulted for an address question,
 *     because addresses came only from `target`
 *   - a `target` naming a host rather than an address produced nothing at all,
 *     and most of the registry points at a host
 *
 * So these tests read answers back off the wire. A reply of the right shape
 * with the wrong bytes in it is exactly the failure being fixed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import {
  addressAnswer, buildChainResponse, createServer, encodeName, parseQuery,
  resolveChain, targetHostname, TYPE_A, TYPE_AAAA, TYPE_CNAME,
} from "../src/dns.mjs";

const RCODE_OK = 0;
const RCODE_NXDOMAIN = 3;

function query(name, { id = 0x1234, type = TYPE_A, cls = 1, rd = true } = {}) {
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
const authoritative = (reply) => Boolean(reply.readUInt16BE(2) & 0x0400);

/** A name written out in full — the chain builder never emits a pointer for one. */
function readName(buf, offset) {
  const labels = [];
  let i = offset;
  for (;;) {
    const len = buf[i];
    if (len === undefined) throw new Error("truncated name");
    if (len === 0) return { name: labels.join("."), offset: i + 1 };
    labels.push(buf.toString("ascii", i + 1, i + 1 + len));
    i += len + 1;
  }
}

/**
 * Every answer in a reply, with the owner name of each.
 *
 * A chain carries two different owners, so unlike the record decoder this one
 * cannot assume the 0xc00c pointer — telling them apart is the point.
 */
function readAnswers(reply, name) {
  const found = [];
  let i = 12 + encodeName(name).length + 4;
  for (let n = 0; n < answers(reply); n++) {
    let owner;
    if (reply.readUInt16BE(i) === 0xc00c) {
      owner = name;
      i += 2;
    } else {
      ({ name: owner, offset: i } = readName(reply, i));
    }
    const type = reply.readUInt16BE(i);
    const ttl = reply.readUInt32BE(i + 4);
    const length = reply.readUInt16BE(i + 8);
    const rdata = reply.subarray(i + 10, i + 10 + length);
    i += 10 + length;
    found.push({ owner, type, ttl, rdata });
  }
  return found;
}

/**
 * A registry that answers the record set only when it was asked for.
 *
 * The `&records=1` split is load-bearing: the address path is meant to skip
 * that round trip whenever `target` already holds an address, and a fake that
 * ignored the flag would hide a regression in exactly that.
 */
function registry({ target = null, records = [], registered = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const wants = url.includes("records=1");
    return {
      ok: true,
      json: async () => ({
        name_registered: registered,
        target,
        ...(wants ? { records } : {}),
      }),
    };
  };
  return { fetchImpl, calls };
}

async function ask(server, buf) {
  const client = dgram.createSocket("udp4");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply")), 5000);
      client.once("message", (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      client.send(buf, server.port, "127.0.0.1");
    });
  } finally {
    client.close();
  }
}

async function serve(t, { fetchImpl }, extra = {}) {
  const server = await createServer({ port: 0, parkingAddress: "198.51.100.9", fetchImpl, ...extra });
  t.after(() => server.close());
  return server;
}

/* ----------------------------------------------------------- what a target holds */

test("targetHostname reads the host out of a target that is not an address", () => {
  assert.equal(targetHostname("dev.profullstack.com"), "dev.profullstack.com");
  assert.equal(targetHostname("https://dev.profullstack.com/"), "dev.profullstack.com");
  assert.equal(targetHostname("DEV.Profullstack.COM"), "dev.profullstack.com", "case is not identity");
  assert.equal(targetHostname("dev.profullstack.com."), "dev.profullstack.com", "a root dot is not a label");
});

test("targetHostname refuses what no CNAME could carry", () => {
  // A port cannot ride in a CNAME, and quietly dropping it would send the
  // client to port 80 of the right host — a wrong answer that looks right.
  assert.equal(targetHostname("example.com:8080"), null);
  assert.equal(targetHostname("https://example.com/path"), null, "a path is not a name");
  assert.equal(targetHostname("203.0.113.7"), null, "an address is targetAddress's job");
  assert.equal(targetHostname("2606:4700::1111"), null);
  assert.equal(targetHostname("localhost"), null, "a single label is not a resolvable target");
  assert.equal(targetHostname(""), null);
  assert.equal(targetHostname(null), null);
});

/* ------------------------------------------------- a record the owner published */

test("a published AAAA record answers the AAAA question", async (t) => {
  // The registry held this the whole time and the bridge never looked: an
  // address question was answered from `target` alone.
  const server = await serve(t, registry({
    target: "dev.profullstack.com",
    records: [{ type: "AAAA", value: "2604:a880:400:d1:0:4:c3fe:1", ttl: 300 }],
  }));
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_AAAA }));

  assert.equal(rcode(reply), RCODE_OK);
  const [record] = readAnswers(reply, "scrambled.eggs");
  assert.equal(record.type, TYPE_AAAA);
  assert.equal(record.ttl, 300, "the owner's TTL, not the bridge's default");
  assert.equal(record.rdata.length, 16);
  assert.equal(record.rdata.readUInt16BE(0), 0x2604);
});

test("a published A record answers the A question", async (t) => {
  const server = await serve(t, registry({
    target: "dev.profullstack.com",
    records: [{ type: "A", value: "203.0.113.7", ttl: 120 }],
  }));
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_A }));

  const [record] = readAnswers(reply, "scrambled.eggs");
  assert.equal(record.type, TYPE_A);
  assert.deepEqual([...record.rdata], [203, 0, 113, 7]);
});

test("a name with only an AAAA record still exists to the A question", async (t) => {
  // NXDOMAIN here would deny the name outright, taking the AAAA lookup the
  // browser sent alongside it down too.
  const server = await serve(t, registry({
    target: null,
    records: [{ type: "AAAA", value: "2606:4700::1111" }],
  }));
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_A }));
  assert.equal(rcode(reply), RCODE_OK, "the name is here, it just has no A");
});

/* ------------------------------------------------------- a target that is a host */

test("a hostname target is answered as a CNAME to that host", async (t) => {
  const server = await serve(t, registry({ target: "dev.profullstack.com" }));
  const reply = await ask(server, query("scrambled.eggs"));

  assert.equal(rcode(reply), RCODE_OK);
  assert.ok(authoritative(reply), "we are still authoritative for the ending");
  const [record] = readAnswers(reply, "scrambled.eggs");
  assert.equal(record.type, TYPE_CNAME);
  assert.equal(readName(record.rdata, 0).name, "dev.profullstack.com");
});

test("a target naming a port stays NODATA rather than lying about the port", async (t) => {
  const server = await serve(t, registry({ target: "example.com:8080" }));
  const reply = await ask(server, query("scrambled.eggs"));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 0);
});

test("an address in the target still short-circuits the record lookup", async (t) => {
  // The fast path every page load takes. Asking for records it will not read
  // costs the registry a second query per navigation.
  const reg = registry({ target: "203.0.113.7" });
  const server = await serve(t, reg);
  await ask(server, query("scrambled.eggs"));

  assert.equal(reg.calls.filter((url) => url.includes("records=1")).length, 0);
});

/* ------------------------------------------------------------- the chain on the wire */

test("a completed chain carries the CNAME and the leaf under their own owners", () => {
  const name = "scrambled.eggs";
  const buf = query(name);
  const reply = buildChainResponse(parseQuery(buf), buf, {
    cname: "dev.profullstack.com",
    addresses: ["67.205.189.229"],
  });

  assert.equal(answers(reply), 2);
  const [cname, leaf] = readAnswers(reply, name);
  assert.equal(cname.owner, name, "the CNAME is owned by the name that was asked about");
  assert.equal(cname.type, TYPE_CNAME);
  assert.equal(leaf.owner, "dev.profullstack.com", "the address is owned by the CNAME's target");
  assert.equal(leaf.type, TYPE_A);
  assert.deepEqual([...leaf.rdata], [67, 205, 189, 229]);
});

test("a chain nobody could complete is still a usable CNAME", () => {
  // The leaf is a courtesy on top of an answer that is already correct, so an
  // upstream that is slow or silent must cost the extra record and nothing more.
  const buf = query("scrambled.eggs");
  const reply = buildChainResponse(parseQuery(buf), buf, { cname: "dev.profullstack.com", addresses: [] });

  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 1);
});

test("a leaf of the wrong family is dropped, not encoded as garbage", () => {
  const buf = query("scrambled.eggs", { type: TYPE_AAAA });
  const reply = buildChainResponse(parseQuery(buf), buf, {
    cname: "dev.profullstack.com",
    addresses: ["67.205.189.229"],
  });
  assert.equal(answers(reply), 1, "an IPv4 address cannot answer an AAAA question");
});

test("resolveChain does no clearnet DNS when there is nowhere to ask", async () => {
  assert.deepEqual(await resolveChain("dev.profullstack.com", { upstreams: [] }), []);
  assert.deepEqual(await resolveChain("", { upstreams: ["203.0.113.7"] }), []);
});

/* --------------------------------------------------------------- the plan itself */

test("addressAnswer parks a claimed name before reading any record", async () => {
  const reg = registry({ target: null });
  const plan = await addressAnswer("scrambled.eggs", {
    fetchImpl: reg.fetchImpl,
    parkingAddress: "198.51.100.9",
  });

  assert.equal(plan.kind, "address");
  assert.equal(plan.address, "198.51.100.9");
  assert.equal(reg.calls.filter((url) => url.includes("records=1")).length, 0);
});

/** A registry that does not hold the name — the shape a 404 arrives in. */
const missing = () => ({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }), calls: [] });

test("addressAnswer denies a name the registry does not hold", async () => {
  const plan = await addressAnswer("scrambled.eggs", { fetchImpl: missing().fetchImpl });
  assert.equal(plan.kind, "nxdomain");
  assert.equal(plan.exists, false);
});

test("a name the registry does not hold is still NXDOMAIN on an address question", async (t) => {
  // The one answer the new paths must never swallow: adding CNAMEs and record
  // lookups above this must not turn a name nobody holds into a name that exists.
  const server = await serve(t, missing());
  const reply = await ask(server, query("scrambled.eggs"));
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
});

/* ------------------------------------------------------------------ wildcards */

/**
 * A registry that holds `*.chovy.hacker` and nothing under it — dumber than
 * the real pit on purpose, so the exact-then-wildcard fallback on this side of
 * HTTP is what produces the answer.
 */
function wildcardOnly({ target = null, records = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const wants = url.includes("records=1");
    const asked = decodeURIComponent(new URL(url).searchParams.get("name"));
    const held = asked === "*.chovy.hacker";
    return {
      ok: true,
      json: async () => ({
        name_registered: held,
        target: held ? target : null,
        ...(wants ? { records: held ? records : [] } : {}),
      }),
    };
  };
  return { fetchImpl, calls };
}

test("a wildcard AAAA answers a third-level address question, as the asked name", async (t) => {
  // The primary use of the feature: `*.chovy.hacker` publishes the owner's
  // IPv6, and every name under chovy answers with it.
  const server = await serve(t, wildcardOnly({ target: "2606:4700:4700::1111" }));
  const reply = await ask(server, query("foo.chovy.hacker", { type: TYPE_AAAA }));

  assert.equal(rcode(reply), RCODE_OK);
  const [record] = readAnswers(reply, "foo.chovy.hacker");
  assert.equal(record.owner, "foo.chovy.hacker", "the answer carries the asked name, not the wildcard");
  assert.equal(record.type, TYPE_AAAA);
  assert.equal(record.rdata.readUInt16BE(0), 0x2606);
});

test("a wildcard AAAA record answers when the wildcard has no target of its own", async (t) => {
  // The registry need not mirror the record into `target`: the records path
  // finds the address exactly as it does for a registered name.
  const server = await serve(t, wildcardOnly({
    records: [{ type: "AAAA", value: "2606:4700:4700::1111", ttl: 300 }],
  }));
  const reply = await ask(server, query("foo.chovy.hacker", { type: TYPE_AAAA }));

  assert.equal(rcode(reply), RCODE_OK);
  const [record] = readAnswers(reply, "foo.chovy.hacker");
  assert.equal(record.type, TYPE_AAAA);
  assert.equal(record.rdata.readUInt16BE(0), 0x2606);
});

test("a third-level name is never parked", async (t) => {
  // Parking is for names that are for sale, and a sub-name is never for sale —
  // it exists only through a wildcard. A wildcard that exists but has no
  // address to give is NODATA, and sending it to the for-sale page would be
  // the one answer that is always wrong.
  const reg = wildcardOnly({});
  const plan = await addressAnswer("foo.chovy.hacker", {
    fetchImpl: reg.fetchImpl,
    parkingAddress: "198.51.100.9",
  });
  assert.equal(plan.kind, "nodata");
  assert.notEqual(plan.address, "198.51.100.9");

  const server = await serve(t, reg);
  const reply = await ask(server, query("foo.chovy.hacker", { type: TYPE_AAAA }));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 0);
});
