/**
 * A name that exists must not answer NXDOMAIN.
 *
 * NXDOMAIN denies the whole name, not just the question that was asked, so a
 * resolver may apply it to every other type it has in flight. A browser asks
 * HTTPS/SVCB beside every A and AAAA, which is why answering that one question
 * wrongly took the page load down with it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { answerFor, answerPolicy, buildResponse, createServer, encodeName, parseQuery } from "../src/dns.mjs";

const TYPE_A = 1;
const TYPE_MX = 15;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_HTTPS = 65; // SVCB-compatible; Chrome and Safari send it on every navigation
const RCODE_OK = 0;
const RCODE_NXDOMAIN = 3;

/** A query the way a resolver would send it. */
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

/** A registry that always gives the same verdict, counting how often it is asked. */
function registry(body, { ok = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok, json: async () => body };
  };
  return { fetchImpl, calls };
}

const parked = () => registry({ name_registered: true, target: null });
const live = (target) => registry({ name_registered: true, target });
const down = () => registry({}, { ok: false });

/** Send one query to a live server and hand back the raw reply. */
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
  const server = await createServer({
    port: 0,
    parkingAddress: "198.51.100.9",
    fetchImpl,
    ...extra,
  });
  t.after(() => server.close());
  return server;
}

/* ------------------------------------------- the questions this bridge does not serve */

for (const [label, type] of [
  ["HTTPS/SVCB", TYPE_HTTPS],
  ["TXT", TYPE_TXT],
  ["MX", TYPE_MX],
]) {
  test(`a ${label} question about a parked name is NODATA, not NXDOMAIN`, async (t) => {
    const server = await serve(t, parked());
    const reply = await ask(server, query("scrambled.eggs", { type }));
    assert.equal(rcode(reply), RCODE_OK, `${label} must not deny the name`);
    assert.equal(answers(reply), 0, "nothing to answer with");
  });
}

test("a HTTPS/SVCB question about a live name is NODATA, not NXDOMAIN", async (t) => {
  const server = await serve(t, live("203.0.113.7"));
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_HTTPS }));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 0);
});

test("the A question beside it still answers, so the pair does not contradict itself", async (t) => {
  const server = await serve(t, live("203.0.113.7"));
  const https = await ask(server, query("scrambled.eggs", { type: TYPE_HTTPS }));
  const a = await ask(server, query("scrambled.eggs", { type: TYPE_A }));
  assert.equal(rcode(https), RCODE_OK, "HTTPS must not say the name is gone");
  assert.equal(rcode(a), RCODE_OK, "while A says it is here");
  assert.equal(answers(a), 1);
});

/* ------------------------------------------------- a name with no address to serve */

test("a live name pointed at a hostname answers with a CNAME, not an empty NOERROR", async (t) => {
  // Most of the registry is pointed at a host rather than an address, so the
  // old empty-NOERROR here was not an edge case: it was the common case, and
  // it read to every client as a name with nothing behind it. An A record
  // cannot hold a hostname; a CNAME can, and the client chases it.
  const server = await serve(t, live("example.com"));
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_A }));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 1, "the name has somewhere to go and must say so");
});

test("a live name whose target names a port is NODATA, not NXDOMAIN", async (t) => {
  const server = await serve(t, live("example.com:8080"));
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_A }));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 0);
});

/* ------------------------------------------------------- NXDOMAIN is still reachable */

test("a name the registry does not know is still NXDOMAIN, on every type", async (t) => {
  const server = await serve(t, down());
  for (const type of [TYPE_A, TYPE_AAAA, TYPE_TXT, TYPE_MX, TYPE_HTTPS]) {
    const reply = await ask(server, query("scrambled.eggs", { type }));
    assert.equal(rcode(reply), RCODE_NXDOMAIN, `type ${type} must still deny an unknown name`);
    assert.equal(answers(reply), 0);
  }
});

test("a name the registry cannot hold is still NXDOMAIN, on every type", async (t) => {
  const reg = parked();
  const server = await serve(t, reg);
  for (const type of [TYPE_A, TYPE_HTTPS]) {
    const reply = await ask(server, query("deep.sub.eggs", { type }));
    assert.equal(rcode(reply), RCODE_NXDOMAIN, `type ${type} on a non-name`);
  }
  assert.equal(reg.calls.length, 0, "a shape the registry cannot hold is never looked up");
});

test("a question in another class is still NXDOMAIN and is never looked up", async (t) => {
  const reg = parked();
  const server = await serve(t, reg);
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_A, cls: 3 }));
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
  assert.equal(reg.calls.length, 0, "CHAOS is not ours to answer");
});

/* ---------------------------------------------------------------- lookup accounting */

test("a question we do not serve costs exactly one lookup, not zero and not several", async (t) => {
  // Counted rather than inferred from the reply: a status can be right by
  // accident, a call count cannot.
  const reg = parked();
  const server = await serve(t, reg);
  await ask(server, query("scrambled.eggs", { type: TYPE_HTTPS }));
  assert.equal(reg.calls.length, 1);
});

test("a malformed query is still never answered and never looked up", async (t) => {
  const reg = parked();
  const server = await serve(t, reg);
  const client = dgram.createSocket("udp4");
  t.after(() => client.close());
  let replied = false;
  client.on("message", () => {
    replied = true;
  });
  client.send(Buffer.alloc(4), server.port, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(replied, false, "say nothing at all");
  assert.equal(reg.calls.length, 0);
});

/* --------------------------------------------------- the answers that already worked */

test("a parked name still answers A with the parking address", async (t) => {
  const server = await serve(t, parked());
  const reply = await ask(server, query("scrambled.eggs"));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 1);
  assert.deepEqual([...reply.subarray(reply.length - 4)], [198, 51, 100, 9]);
});

test("a parked name still answers AAAA with NODATA", async (t) => {
  const server = await serve(t, parked());
  const reply = await ask(server, query("scrambled.eggs", { type: TYPE_AAAA }));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(answers(reply), 0);
});

test("a live IPv6 target still answers AAAA with sixteen bytes and NODATA on A", async (t) => {
  const server = await serve(t, live("2606:4700:4700::1111"));
  const v6 = await ask(server, query("scrambled.eggs", { type: TYPE_AAAA }));
  assert.equal(answers(v6), 1);
  assert.equal(v6.length - v6.indexOf(v6.subarray(v6.length - 16)), 16);
  const v4 = await ask(server, query("scrambled.eggs", { type: TYPE_A }));
  assert.equal(rcode(v4), RCODE_OK, "the family it does not have is NODATA, as before");
  assert.equal(answers(v4), 0);
});

/* ------------------------------------------------------------ the units underneath */

test("buildResponse keeps its old meaning when it is not told whether the name exists", () => {
  // Every existing caller passes four arguments. Those replies must not move.
  for (const [name, type, address] of [
    ["scrambled.eggs", TYPE_A, null],
    ["scrambled.eggs", TYPE_A, "203.0.113.7"],
    ["scrambled.eggs", TYPE_AAAA, "203.0.113.7"],
    ["scrambled.eggs", TYPE_AAAA, "2606:4700:4700::1111"],
  ]) {
    const buf = query(name, { type });
    const q = parseQuery(buf);
    assert.deepEqual(
      buildResponse(q, buf, address, 30),
      buildResponse(q, buf, address, 30, Boolean(address)),
      `four-argument form unchanged for ${type}/${address}`,
    );
  }
});

test("buildResponse says NODATA for a name that exists with no address", () => {
  const buf = query("scrambled.eggs", { type: TYPE_HTTPS });
  const q = parseQuery(buf);
  assert.equal(rcode(buildResponse(q, buf, null, 30, true)), RCODE_OK);
  assert.equal(answers(buildResponse(q, buf, null, 30, true)), 0);
  assert.equal(rcode(buildResponse(q, buf, null, 30, false)), RCODE_NXDOMAIN);
});

test("answerPolicy reports a parked name as here even when no address is wanted", async () => {
  const { fetchImpl } = parked();
  assert.deepEqual(await answerPolicy("scrambled.eggs", { fetchImpl, parkingAddress: "198.51.100.9" }), {
    exists: true,
    address: "198.51.100.9",
  });
  assert.deepEqual(
    await answerPolicy("scrambled.eggs", {
      fetchImpl,
      parkingAddress: "198.51.100.9",
      wantsAddress: false,
    }),
    { exists: true, address: null },
  );
});

test("answerPolicy reports a name it could not look up as not here", async () => {
  const { fetchImpl } = down();
  for (const wantsAddress of [true, false]) {
    assert.deepEqual(
      await answerPolicy("scrambled.eggs", { fetchImpl, parkingAddress: "198.51.100.9", wantsAddress }),
      { exists: false, address: null },
    );
  }
});

test("answerFor still returns exactly what it used to", async () => {
  assert.equal(
    await answerFor("scrambled.eggs", { fetchImpl: parked().fetchImpl, parkingAddress: "198.51.100.9" }),
    "198.51.100.9",
    "parked → the parking address",
  );
  assert.equal(
    await answerFor("scrambled.eggs", { fetchImpl: live("203.0.113.7").fetchImpl }),
    "203.0.113.7",
    "live → its address",
  );
  assert.equal(
    await answerFor("scrambled.eggs", { fetchImpl: live("example.com").fetchImpl }),
    null,
    "a hostname target has no address",
  );
  assert.equal(
    await answerFor("scrambled.eggs", { fetchImpl: down().fetchImpl, parkingAddress: "198.51.100.9" }),
    null,
    "a registry outage does not park every name",
  );
  assert.equal(await answerFor("deep.sub.eggs", { fetchImpl: parked().fetchImpl }), null, "not a name");
});

test("onQuery still reports no address for the questions we do not serve", async (t) => {
  const seen = [];
  const server = await serve(t, parked(), { onQuery: (q) => seen.push(q) });
  await ask(server, query("scrambled.eggs", { type: TYPE_HTTPS }));
  await ask(server, query("scrambled.eggs", { type: TYPE_A }));
  assert.deepEqual(seen, [
    { name: "scrambled.eggs", type: TYPE_HTTPS, address: null },
    { name: "scrambled.eggs", type: TYPE_A, address: "198.51.100.9" },
  ]);
});
