// The vendored DNS bridge, against the published one.
//
// src/dns.mjs is a copy of @moshcoder/moshpit-dns. It is a copy on purpose:
// moshcode ships as a tarball that nothing runs `npm install` over, so a
// runtime dependency would break every install. The cost of that choice is
// drift, and the point of this file is to make drift loud instead of silent.
//
// Behaviour rather than bytes. The two differ cosmetically — the standalone
// tool names itself in the config comments it writes — and a byte comparison
// would fail on that forever while missing a real divergence in what the
// protocol actually does. So this runs both over the same inputs and requires
// the same answers.
//
// Skips when the package is not installed, so a checkout without dev
// dependencies still runs the rest of the suite.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import * as vendored from "../src/dns.mjs";

const require = createRequire(import.meta.url);
let published = null;
try {
  published = await import("@moshcoder/moshpit-dns");
} catch {
  published = null;
}

test("vendored DNS bridge matches the published package", {
  skip: published ? false : "@moshcoder/moshpit-dns not installed",
}, async (t) => {
  await t.test("the wire codec encodes names identically", () => {
    for (const name of ["blue.eggs", "a.b", "x".repeat(63) + ".eggs", "california.oranges"]) {
      assert.deepEqual(
        [...vendored.encodeName(name)],
        [...published.encodeName(name)],
        name,
      );
    }
  });

  await t.test("names decode identically, including the failures", () => {
    for (const name of ["blue.eggs", "california.oranges"]) {
      const buf = vendored.encodeName(name);
      assert.deepEqual(vendored.decodeName(buf, 0), published.decodeName(buf, 0), name);
    }
    // A compression pointer in a question is rejected by both, or neither is
    // safe to put on a socket.
    const pointer = Buffer.from([0xc0, 0x0c]);
    assert.throws(() => vendored.decodeName(pointer, 0));
    assert.throws(() => published.decodeName(pointer, 0));
  });

  await t.test("a query parses to the same question", () => {
    const question = Buffer.concat([
      Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
      vendored.encodeName("blue.eggs"),
      Buffer.from([0, 1, 0, 1]),
    ]);
    assert.deepEqual(vendored.parseQuery(question), published.parseQuery(question));
  });

  await t.test("responses are byte-identical on the wire", () => {
    const question = Buffer.concat([
      Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
      vendored.encodeName("blue.eggs"),
      Buffer.from([0, 1, 0, 1]),
    ]);
    const q = vendored.parseQuery(question);
    // This is the one that matters most: a resolver that disagrees about bytes
    // is a resolver that answers differently depending on which copy ran.
    assert.deepEqual(
      [...vendored.buildResponse(q, question, "203.0.113.7", 30)],
      [...published.buildResponse(q, question, "203.0.113.7", 30)],
    );
  });

  await t.test("the same hostnames are Moshpit names", () => {
    // The dashed entries matter: whether a dash may appear inside a label is a
    // rule that has changed, and without them a divergence on it reads as green.
    for (const h of [
      "blue.eggs", "a.b.c", "1.2.3.4", "localhost", "", "eggs", "blue.420", "1.420",
      "blue.lazy-loaded", "register-me.eggs", "a-b.c-d", "-bad.eggs", "bad-.eggs",
    ]) {
      assert.deepEqual(vendored.parseRegistryName(h), published.parseRegistryName(h), h);
    }
  });

  await t.test("resolution decides the same way on the same registry answer", async () => {
    const cases = [
      { registered: true, name_registered: true, target: "203.0.113.9" },
      { registered: true, name_registered: true, target: null },
      { registered: true, name_registered: false, target: null },
      { registered: false },
    ];
    for (const body of cases) {
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
      assert.deepEqual(
        await vendored.resolveName("blue.eggs", { fetchImpl }),
        await published.resolveName("blue.eggs", { fetchImpl }),
        JSON.stringify(body),
      );
    }
  });

  await t.test("an unreachable registry fails the same way in both", async () => {
    const fetchImpl = async () => { throw new Error("offline"); };
    assert.deepEqual(
      await vendored.resolveName("blue.eggs", { fetchImpl }),
      await published.resolveName("blue.eggs", { fetchImpl }),
    );
  });

  await t.test("the defaults have not drifted apart", () => {
    for (const key of ["DEFAULT_REGISTRY_BASE", "DEFAULT_PORT", "DEFAULT_HOST", "DEFAULT_TTL"]) {
      assert.equal(vendored[key], published[key], key);
    }
  });

  await t.test("the published version is recorded, so a bump is a visible change", () => {
    const { version } = require("@moshcoder/moshpit-dns/package.json");
    assert.match(version, /^\d+\.\d+\.\d+/);
  });

  /* ------------------------------------------------- what this test used to miss */

  // Everything above asked an A question and compared the answer. Both copies
  // agreed, and stayed green through a release in which one of them learned to
  // answer AAAA and the other did not, and a second in which one learned CNAME,
  // MX and TXT and the other did not. A resolver comparison that only ever asks
  // one question type is a comparison of one question type.
  //
  // So: every type either copy claims to serve, asked of both.

  /** A question of a given type, the way a resolver sends it. */
  const question = (name, type) => Buffer.concat([
    Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    vendored.encodeName(name),
    Buffer.from([(type >> 8) & 0xff, type & 0xff, 0, 1]),
  ]);

  await t.test("both serve the same set of record question types", () => {
    // A Map of qtype -> registry name. If one copy grows a type the other has
    // not, that is the divergence this whole file exists to catch, and it is
    // visible here before any wire byte is compared.
    assert.deepEqual(
      [...(vendored.RECORD_TYPES ?? new Map())].sort(),
      [...(published.RECORD_TYPES ?? new Map())].sort(),
      "one copy answers a question type the other does not",
    );
  });

  await t.test("an AAAA answer is byte-identical, not just an A answer", () => {
    // The gap that let AAAA support ship in one copy and not the other.
    const buf = question("blue.eggs", vendored.TYPE_AAAA);
    const q = vendored.parseQuery(buf);
    assert.deepEqual(
      [...vendored.buildResponse(q, buf, "2606:4700:4700::1111", 30)],
      [...published.buildResponse(q, buf, "2606:4700:4700::1111", 30)],
    );
  });

  await t.test("NODATA and NXDOMAIN are drawn in the same place", () => {
    // A name that exists with nothing to say must not be denied by one copy and
    // merely empty in the other: NXDOMAIN is cached and applied to every type.
    for (const [label, exists] of [["exists", true], ["does not exist", false]]) {
      const buf = question("blue.eggs", vendored.TYPE_A);
      const q = vendored.parseQuery(buf);
      assert.deepEqual(
        [...vendored.buildResponse(q, buf, null, 30, exists)],
        [...published.buildResponse(q, buf, null, 30, exists)],
        label,
      );
    }
  });

  await t.test("record rdata encodes identically", () => {
    // TXT past one string, and a multi-byte character on the 255-byte boundary:
    // the two ways a split goes wrong, and both produce a reply of the right
    // shape that no client can read.
    for (const value of ["v=spf1 -all", "k".repeat(600), "🤘".repeat(60), ""]) {
      assert.deepEqual(
        [...vendored.rdataTxt(value)],
        [...published.rdataTxt(value)],
        `TXT ${value.slice(0, 12)}…`,
      );
    }
    for (const priority of [0, 10, 65_535]) {
      assert.deepEqual(
        [...vendored.rdataMx(priority, "mx.example.com")],
        [...published.rdataMx(priority, "mx.example.com")],
        `MX ${priority}`,
      );
    }
  });

  await t.test("a record answer is byte-identical on the wire", () => {
    const records = [
      { type: "MX", value: "mx1.example.com", ttl: 300, priority: 10 },
      { type: "MX", value: "mx2.example.com", ttl: 300, priority: 20 },
      { type: "TXT", value: "v=spf1 include:example.com -all", ttl: 60, priority: null },
      { type: "CNAME", value: "box.example.com", ttl: 300, priority: null },
    ];
    for (const [type, name] of [...vendored.RECORD_TYPES]) {
      const buf = question("blue.eggs", type);
      const q = vendored.parseQuery(buf);
      const mine = records.filter((r) => r.type === name);
      assert.deepEqual(
        [...vendored.buildRecordResponse(q, buf, mine, { ttl: 30 })],
        [...published.buildRecordResponse(q, buf, mine, { ttl: 30 })],
        name,
      );
    }
  });

  await t.test("an oversized record answer is trimmed the same way", () => {
    // Where the two would diverge silently: one dropping every answer and
    // setting TC, the other keeping what fits, both "truncated" to a caller
    // reading the flag alone.
    const many = Array.from({ length: 20 }, (_, i) => ({
      type: "MX", value: `mx${i}.averyveryverylongmailhostname.example.com`, ttl: 300, priority: i,
    }));
    const buf = question("blue.eggs", vendored.TYPE_MX);
    const q = vendored.parseQuery(buf);
    assert.deepEqual(
      [...vendored.buildRecordResponse(q, buf, many, { ttl: 30 })],
      [...published.buildRecordResponse(q, buf, many, { ttl: 30 })],
    );
  });

  await t.test("record resolution decides the same way on the same registry answer", async () => {
    const bodies = [
      { name_registered: true, target: "2606:4700:4700::1111", records: [{ type: "MX", value: "mx.example.com", ttl: 300, priority: 10 }] },
      { name_registered: true, target: null, records: [] },
      { registered: false },
    ];
    for (const body of bodies) {
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
      for (const type of ["MX", "TXT", "CNAME"]) {
        assert.deepEqual(
          await vendored.answerRecords("blue.eggs", { fetchImpl, type }),
          await published.answerRecords("blue.eggs", { fetchImpl, type }),
          `${type} ${JSON.stringify(body)}`,
        );
      }
    }
  });

  await t.test("asking for records is opt-in in both, so address lookups stay cheap", async () => {
    // Every DNS query on the machine goes through resolveName. If one copy
    // started asking the registry for records unconditionally, the cost would
    // land on every page load and nothing else here would notice.
    for (const copy of [vendored, published]) {
      const urls = [];
      const fetchImpl = async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ name_registered: true, target: "2606:4700:4700::1111" }) };
      };
      await copy.resolveName("blue.eggs", { fetchImpl });
      assert.equal(urls.filter((u) => u.includes("records=1")).length, 0);
      await copy.answerRecords("blue.eggs", { fetchImpl, type: "MX" });
      assert.equal(urls.filter((u) => u.includes("records=1")).length, 1);
    }
  });

  await t.test("the shared surface is present in both", () => {
    // The vendored copy is a superset: moshcode's bridge also forwards, rate
    // limits and writes catch-all routing, none of which the standalone tool
    // does. This is the part that must exist on both sides, named explicitly so
    // that dropping one from the package is a failure rather than a silence.
    for (const name of [
      "encodeName", "decodeName", "parseQuery", "buildResponse", "buildRecordResponse",
      "rdataTxt", "rdataMx", "encodeRdata", "parseRegistryName", "resolveName",
      "answerFor", "answerPolicy", "answerRecords", "mayHaveCname", "targetAddress",
      "createServer", "fetchTlds", "resolvedConf", "dnsmasqConf",
      "RECORD_TYPES", "TYPE_A", "TYPE_AAAA", "TYPE_CNAME", "TYPE_MX", "TYPE_TXT",
    ]) {
      assert.ok(vendored[name] !== undefined, `vendored is missing ${name}`);
      assert.ok(published[name] !== undefined, `the published package is missing ${name}`);
    }
  });
});
