/**
 * The record types the bridge answers beyond an address.
 *
 * A name could publish an MX and a TXT in the registry while `dig MX` came
 * back empty, because both resolvers gated on A/AAAA and returned NODATA for
 * everything else. The records existed and nothing served them.
 *
 * So these tests read the rdata back off the wire rather than trusting an
 * answer count: a TXT record split at the wrong byte, or an MX with its
 * preference in the wrong order, produces a reply of exactly the right shape
 * that no client can use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";

import {
  answerRecords, buildRecordResponse, createServer, encodeName, parseQuery,
  rdataMx, rdataTxt, TYPE_AAAA, TYPE_CNAME, TYPE_MX, TYPE_TXT,
} from "../src/dns.mjs";
import { createDohHandler } from "../src/doh.mjs";

const TYPE_A = 1;
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
const count = (reply) => reply.readUInt16BE(6);
const truncated = (reply) => Boolean(reply.readUInt16BE(2) & 0x0200);

/** Labels out of an rdata buffer — the encoder never writes a pointer. */
function readName(buf, offset = 0) {
  const labels = [];
  let i = offset;
  for (;;) {
    const len = buf[i];
    if (len === undefined) throw new Error("truncated");
    if (len === 0) return { name: labels.join("."), offset: i + 1 };
    i += 1;
    labels.push(buf.toString("ascii", i, i + len));
    i += len;
  }
}

/** Every answer in a reply, decoded far enough to be checked. */
function readAnswers(reply, name) {
  const questionEnd = 12 + encodeName(name).length + 4;
  const found = [];
  let i = questionEnd;
  for (let n = 0; n < count(reply); n++) {
    assert.equal(reply.readUInt16BE(i), 0xc00c, "answer does not point at the question's name");
    const type = reply.readUInt16BE(i + 2);
    const ttl = reply.readUInt32BE(i + 6);
    const length = reply.readUInt16BE(i + 10);
    const rdata = reply.subarray(i + 12, i + 12 + length);
    const record = { type, ttl };
    if (type === TYPE_TXT) {
      // Rejoined the way a client does: the 255-byte split is invisible above
      // the wire, so a value that survives the round trip must come back whole.
      const parts = [];
      let at = 0;
      while (at < rdata.length) {
        const len = rdata[at];
        parts.push(rdata.toString("utf8", at + 1, at + 1 + len));
        at += 1 + len;
      }
      record.value = parts.join("");
    } else if (type === TYPE_MX) {
      record.priority = rdata.readUInt16BE(0);
      record.value = readName(rdata, 2).name;
    } else if (type === TYPE_CNAME) {
      record.value = readName(rdata).name;
    } else {
      record.value = rdata;
    }
    found.push(record);
    i += 12 + length;
  }
  return found;
}

/** A registry answering /api/moshpit/resolve, with or without `&records=1`. */
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
      client.once("message", (msg) => { clearTimeout(timer); resolve(msg); });
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

/* ------------------------------------------------------------------ encoders */

test("TXT longer than 255 bytes is split into strings a client rejoins", () => {
  const value = "k".repeat(600);
  const rdata = rdataTxt(value);
  // 600 bytes as 255 + 255 + 90, each with its own length byte.
  assert.equal(rdata.length, 600 + 3);
  assert.equal(rdata[0], 255);
  assert.equal(rdata[256], 255);
  assert.equal(rdata[512], 90);
});

test("TXT splits on bytes, so a multi-byte character is not cut in half", () => {
  // 200 three-byte characters: the 255-byte boundary lands mid-character if the
  // split counts characters instead of bytes, and neither half then decodes.
  const value = "🤘".repeat(60);
  const rdata = rdataTxt(value);
  const parts = [];
  let at = 0;
  while (at < rdata.length) {
    const len = rdata[at];
    parts.push(rdata.subarray(at + 1, at + 1 + len));
    at += 1 + len;
  }
  assert.equal(Buffer.concat(parts).toString("utf8"), value, "the value did not survive the split");
});

test("MX puts the preference first, as the wire format requires", () => {
  const rdata = rdataMx(20, "mx.example.com");
  assert.equal(rdata.readUInt16BE(0), 20);
  assert.equal(readName(rdata, 2).name, "mx.example.com");
});

test("a record with rdata that cannot be encoded is dropped, not fatal", () => {
  const buf = query("blue.eggs", { type: TYPE_MX });
  const parsed = parseQuery(buf);
  const reply = buildRecordResponse(buf && parsed, buf, [
    { type: "MX", value: "mx.example.com", ttl: 300, priority: 10 },
    { type: "AAAA", value: "not-an-address", ttl: 300, priority: null },
  ]);
  // The good one still answers. One bad row from a registry running a different
  // version must not take the reply down with it.
  assert.equal(count(reply), 1);
  assert.equal(readAnswers(reply, "blue.eggs")[0].value, "mx.example.com");
});

/* -------------------------------------------------------------- over the wire */

test("an MX question is answered from the record set, preference and all", async (t) => {
  const server = await serve(t, registry({
    target: "2606:4700:4700::1111",
    records: [
      { type: "MX", value: "mx1.example.com", ttl: 300, priority: 10 },
      { type: "MX", value: "mx2.example.com", ttl: 300, priority: 20 },
    ],
  }));
  const reply = await ask(server, query("blue.eggs", { type: TYPE_MX }));

  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(count(reply), 2);
  assert.deepEqual(readAnswers(reply, "blue.eggs").map((r) => [r.priority, r.value]), [
    [10, "mx1.example.com"],
    [20, "mx2.example.com"],
  ]);
});

test("a TXT question comes back with the value intact", async (t) => {
  const value = "v=spf1 include:example.com -all";
  const server = await serve(t, registry({ records: [{ type: "TXT", value, ttl: 60, priority: null }] }));
  const reply = await ask(server, query("blue.eggs", { type: TYPE_TXT }));

  const [answer] = readAnswers(reply, "blue.eggs");
  assert.equal(answer.value, value);
  // The owner's TTL, not the bridge's default: they set 60 on purpose.
  assert.equal(answer.ttl, 60);
});

test("a name with no record of the type asked for is NODATA, not NXDOMAIN", async (t) => {
  const server = await serve(t, registry({ records: [{ type: "TXT", value: "hi", ttl: 300, priority: null }] }));
  const reply = await ask(server, query("blue.eggs", { type: TYPE_MX }));

  // The name is here — denying it would deny its address too.
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(count(reply), 0);
});

test("an unregistered name under a claimed ending is parked, not denied", async (t) => {
  // The bridge's existing verdict for a name with no target, and record
  // questions have to agree with it: parking is a name waiting to be pointed,
  // and NXDOMAIN on the TXT question would deny the parking address the A
  // question is about to hand back.
  const server = await serve(t, registry({ target: null, records: [] }));
  const reply = await ask(server, query("nobody.eggs", { type: TYPE_TXT }));
  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(count(reply), 0);
});

test("a record question about a third-level name nobody holds is NXDOMAIN", async (t) => {
  // Three labels is a name under a name now, so it cannot be refused on sight
  // anymore — but a name the registry does not hold, exactly or by wildcard,
  // has nothing to park to and is NXDOMAIN rather than parked.
  const reg = registry({ records: [], registered: false });
  const server = await serve(t, reg);
  const reply = await ask(server, query("not.a.name", { type: TYPE_TXT }));
  assert.equal(rcode(reply), RCODE_NXDOMAIN);
  // The wildcard got its chance before the name was denied: exact first, then
  // `*.a.name`, and only then NXDOMAIN.
  assert.ok(reg.calls.some((u) => u.includes("name=*.a.name")), "the wildcard was never asked");
});

test("a published CNAME answers the address question that had nothing to say", async (t) => {
  // The name's target is a hostname, so there is no address to hand back —
  // which used to be NODATA and looked identical to a typo.
  const server = await serve(t, registry({
    target: "box.example.com",
    records: [{ type: "CNAME", value: "box.example.com", ttl: 300, priority: null }],
  }));
  const reply = await ask(server, query("blue.eggs", { type: TYPE_A }));

  assert.equal(rcode(reply), RCODE_OK);
  assert.equal(count(reply), 1);
  const [answer] = readAnswers(reply, "blue.eggs");
  assert.equal(answer.type, TYPE_CNAME);
  assert.equal(answer.value, "box.example.com");
});

test("a name with an address never pays for the CNAME lookup", async (t) => {
  const reg = registry({ target: "2606:4700:4700::1111" });
  const server = await serve(t, reg);
  await ask(server, query("blue.eggs", { type: TYPE_AAAA }));

  assert.equal(reg.calls.length, 1, "an address question made a second round trip");
  assert.equal(reg.calls.filter((u) => u.includes("records=1")).length, 0,
    "an address question asked the registry for records it would not read");
});

test("an oversized answer is trimmed and marked truncated, not sent whole", async (t) => {
  // Twenty MX records is far past what fits in a 512-byte datagram.
  const records = Array.from({ length: 20 }, (_, i) => ({
    type: "MX", value: `mx${i}.averyveryverylongmailhostname.example.com`, ttl: 300, priority: i,
  }));
  const server = await serve(t, registry({ records }));
  const reply = await ask(server, query("blue.eggs", { type: TYPE_MX }));

  assert.ok(reply.length <= 512, `reply was ${reply.length} bytes`);
  assert.ok(count(reply) > 0, "trimming dropped every answer instead of what did not fit");
  assert.ok(count(reply) < 20, "nothing was actually dropped, so this proves nothing");
  assert.ok(truncated(reply), "TC was not set, so the client cannot tell it got a partial answer");
});

/* ---------------------------------------------------------------------- policy */

test("answerRecords separates 'no such record' from 'no such name'", async () => {
  // Here, with a TXT but no MX: NODATA, which must not deny the name.
  const here = registry({ records: [{ type: "TXT", value: "hi", ttl: 300, priority: null }] });
  assert.deepEqual(await answerRecords("blue.eggs", { fetchImpl: here.fetchImpl, type: "MX" }),
    { exists: true, records: [] });

  // A third-level name nobody holds — not exactly, and not by wildcard. It can
  // no longer be rejected on sight (three labels are a name under a name now),
  // so it costs the exact question and the wildcard one, and no more.
  const reg = registry({ records: [], registered: false });
  assert.deepEqual(await answerRecords("not.a.name", { fetchImpl: reg.fetchImpl, type: "MX" }),
    { exists: false, records: [] });
  assert.equal(reg.calls.length, 2, "exact name, then the wildcard, then done");
});

test("answerRecords asks the registry for the record set exactly once", async () => {
  const reg = registry({ records: [] });
  await answerRecords("blue.eggs", { fetchImpl: reg.fetchImpl, type: "TXT" });
  assert.equal(reg.calls.length, 1);
  assert.match(reg.calls[0], /records=1/);
});

/* ------------------------------------------------------------------------ DoH */

test("DoH answers the same record questions as the bridge", async () => {
  const reg = registry({ records: [{ type: "MX", value: "mx.example.com", ttl: 300, priority: 5 }] });
  const handle = createDohHandler({ fetchImpl: reg.fetchImpl, tldSet: new Set(["eggs"]) });

  const message = query("blue.eggs", { type: TYPE_MX });
  const res = await handle({ method: "POST", body: message, address: "203.0.113.9" });

  assert.equal(res.status, 200);
  const [answer] = readAnswers(res.body, "blue.eggs");
  assert.equal(answer.priority, 5);
  assert.equal(answer.value, "mx.example.com");
});

test("DoH follows a published CNAME on an address question too", async () => {
  const reg = registry({
    target: "box.example.com",
    records: [{ type: "CNAME", value: "box.example.com", ttl: 300, priority: null }],
  });
  const handle = createDohHandler({ fetchImpl: reg.fetchImpl, tldSet: new Set(["eggs"]) });

  const res = await handle({ method: "POST", body: query("blue.eggs", { type: TYPE_A }), address: "203.0.113.9" });
  const [answer] = readAnswers(res.body, "blue.eggs");
  assert.equal(answer.type, TYPE_CNAME, "the two resolvers disagree, which is the bug DoH exists to avoid");
});

/* ------------------------------------------------------------------ wildcards */

/**
 * A registry that holds `*.chovy.hacker` and nothing under it.
 *
 * Deliberately dumber than the real pit, which applies the wildcard match
 * itself: this one knows the wildcard only as a name of its own, so the
 * exact-then-wildcard fallback in resolveName is what makes the answer — which
 * is the half of the feature that lives on this side of HTTP.
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

test("a third-level name is answered by its parent's wildcard, as the asked name", async (t) => {
  const reg = wildcardOnly({ records: [{ type: "TXT", value: "wild", ttl: 300, priority: null }] });
  const server = await serve(t, reg);
  const reply = await ask(server, query("foo.chovy.hacker", { type: TYPE_TXT }));

  assert.equal(rcode(reply), RCODE_OK);
  const [answer] = readAnswers(reply, "foo.chovy.hacker");
  // readAnswers asserts the owner is the question's name — a wildcard answer
  // names what was asked, never the `*.chovy.hacker` it came from.
  assert.equal(answer.value, "wild");
  assert.ok(reg.calls.some((u) => u.includes("name=*.chovy.hacker")), "the wildcard was never asked");
});

test("an exact third-level answer beats the wildcard, which is never asked", async (t) => {
  // Exact first, always: a name with its own records does not fall through to
  // the wildcard that would otherwise cover it.
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const wants = url.includes("records=1");
    const asked = decodeURIComponent(new URL(url).searchParams.get("name"));
    const exact = asked === "foo.chovy.hacker";
    return {
      ok: true,
      json: async () => ({
        name_registered: true,
        target: null,
        ...(wants ? { records: [{ type: "TXT", value: exact ? "exact" : "wild", ttl: 300, priority: null }] } : {}),
      }),
    };
  };
  const server = await serve(t, { fetchImpl, calls });
  const reply = await ask(server, query("foo.chovy.hacker", { type: TYPE_TXT }));

  const [answer] = readAnswers(reply, "foo.chovy.hacker");
  assert.equal(answer.value, "exact");
  assert.ok(!calls.some((u) => u.includes("name=*")), "the wildcard was asked despite an exact answer");
});

test("a two-label name never pays for the wildcard question", async (t) => {
  // The fallback is for names under names. An unregistered two-label name is
  // parked on one question, exactly as before.
  const reg = registry({ records: [], registered: false });
  const server = await serve(t, reg);
  await ask(server, query("nobody.eggs", { type: TYPE_TXT }));
  assert.equal(reg.calls.length, 1);
  assert.ok(!reg.calls.some((u) => u.includes("name=*")));
});

test("DoH answers a third-level name by wildcard exactly as the bridge does", async () => {
  // The one invariant this endpoint exists under: the two resolvers must not
  // disagree, or DoH reintroduces the gap it was built to close.
  const reg = wildcardOnly({ records: [{ type: "TXT", value: "wild", ttl: 300, priority: null }] });
  const handle = createDohHandler({ fetchImpl: reg.fetchImpl, tldSet: new Set(["hacker"]) });

  const res = await handle({ method: "POST", body: query("foo.chovy.hacker", { type: TYPE_TXT }), address: "203.0.113.9" });
  assert.equal(res.status, 200);
  const [answer] = readAnswers(res.body, "foo.chovy.hacker");
  assert.equal(answer.value, "wild");
});
