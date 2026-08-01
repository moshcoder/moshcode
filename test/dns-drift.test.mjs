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
});
