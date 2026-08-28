// The twin rules, with no database and no network.
//
// These are the parts a client reimplements -- the browser extension computing
// a twin, a resolver reading a proof record -- so they are the parts that have
// to be exactly specified rather than merely working here.
import assert from "node:assert/strict";
import test from "node:test";

import {
  TWIN_PRICE_USD,
  TWIN_TLDS,
  TWIN_UNLINK_LEAD_MS,
  clearnetTwin,
  clearnetTwins,
  moshpitNameForTwin,
  normalizeDomain,
  normalizeTwinToken,
  parseTwinProof,
  twinIsLive,
  twinProof,
  twinProofMatches,
  twinProofName,
} from "../src/lib/moshpit-twin.mjs";

const TOKEN = "a".repeat(32);
const OTHER = "b".repeat(32);

test("the clearnet twin", async (t) => {
  await t.test("collapses the dot into a hyphen", () => {
    assert.equal(clearnetTwin("financial.advisors"), "financial-advisors.com");
    assert.equal(clearnetTwin("financial.advisors", "net"), "financial-advisors.net");
    assert.equal(clearnetTwin("blue.eggs", "org"), "blue-eggs.org");
    // People type the dot, and the ending is normalised the same way everywhere.
    assert.equal(clearnetTwin(".blue.eggs", ".NET"), "blue-eggs.net");
  });

  await t.test("refuses a name that has no representable twin", () => {
    assert.equal(clearnetTwin("a.b.c"), null, "not a moshpit name");
    assert.equal(clearnetTwin(""), null);
    // 63 is the DNS label ceiling and the stem is both halves plus a hyphen, so
    // a name well inside Moshpit's own limits can have no twin at all.
    const long = `${"a".repeat(40)}.${"b".repeat(40)}`;
    assert.equal(clearnetTwin(long), null, "stem would be 81 characters");
    const justFits = `${"a".repeat(31)}.${"b".repeat(31)}`;
    assert.equal(clearnetTwin(justFits), `${"a".repeat(31)}-${"b".repeat(31)}.com`);
  });

  await t.test("offers every ending, and none when there is no room", () => {
    assert.deepEqual(clearnetTwins("blue.eggs"), ["blue-eggs.com", "blue-eggs.net", "blue-eggs.org"]);
    assert.deepEqual(clearnetTwins("blue.eggs", ["net"]), ["blue-eggs.net"]);
    assert.deepEqual(clearnetTwins(`${"a".repeat(40)}.${"b".repeat(40)}`), []);
    // The endings offered are the ones reserved as pit endings, so a twin can
    // never collide with a namespace somebody holds.
    assert.deepEqual(TWIN_TLDS, ["com", "net", "org"]);
  });

  await t.test("round-trips, because a pit label may not contain a hyphen", () => {
    for (const name of ["blue.eggs", "financial.advisors", "420.blue", "x.yz"]) {
      const twin = clearnetTwin(name);
      assert.equal(moshpitNameForTwin(twin), name, name);
    }
  });

  await t.test("reads the stem out of a hostname, not the hostname", () => {
    assert.equal(moshpitNameForTwin("www.blue-eggs.net"), "blue.eggs");
    assert.equal(moshpitNameForTwin("https://blue-eggs.net/some/path?q=1"), "blue.eggs");
    assert.equal(moshpitNameForTwin("BLUE-EGGS.NET."), "blue.eggs");
  });

  await t.test("a domain that merely contains a dash is not a twin", () => {
    assert.equal(moshpitNameForTwin("example.com"), null, "no dash");
    assert.equal(moshpitNameForTwin("a-b-c.com"), null, "two dashes is not one name");
    assert.equal(moshpitNameForTwin("-bad.com"), null);
    assert.equal(moshpitNameForTwin("blue-.com"), null);
    // Both halves numeric is an IPv4 literal in disguise, which parseMoshpitName
    // refuses -- so it is not a twin either.
    assert.equal(moshpitNameForTwin("1-420.com"), null);
  });
});

test("clearnet domains", async (t) => {
  await t.test("normalises what people actually paste", () => {
    assert.equal(normalizeDomain("  HTTPS://Example.COM/path#x  "), "example.com");
    assert.equal(normalizeDomain("example.com."), "example.com");
    assert.equal(normalizeDomain("sub.example.co.uk"), "sub.example.co.uk");
  });

  await t.test("refuses what is not a domain", () => {
    assert.equal(normalizeDomain("localhost"), null, "one label");
    assert.equal(normalizeDomain(""), null);
    assert.equal(normalizeDomain("example."), null);
    assert.equal(normalizeDomain("exa mple.com"), null);
    assert.equal(normalizeDomain("under_score.com"), null);
    // An address is a well-formed sequence of labels with no registrar to
    // expire at, so it is refused rather than recorded as a domain.
    assert.equal(normalizeDomain("1.2.3.4"), null);
    assert.equal(normalizeDomain("example.c"), null, "one-character suffix");
    assert.equal(normalizeDomain(`${"a".repeat(64)}.com`), null, "label over 63");
  });
});

test("the proof record", async (t) => {
  await t.test("is one string, at one place", () => {
    assert.equal(twinProofName("blue-eggs.net"), "_moshpit.blue-eggs.net");
    assert.equal(twinProof({ name: "blue.eggs", token: TOKEN }),
      `v=moshpit1 name=blue.eggs token=${TOKEN}`);
  });

  await t.test("refuses to render against a bad name or token", () => {
    assert.equal(twinProof({ name: "a.b.c", token: TOKEN }), null);
    assert.equal(twinProof({ name: "blue.eggs", token: "hunter2" }), null);
    assert.equal(twinProof({ name: "blue.eggs", token: TOKEN.toUpperCase() }),
      `v=moshpit1 name=blue.eggs token=${TOKEN}`, "hex is case-insensitive");
    assert.equal(normalizeTwinToken("z".repeat(32)), null, "not hex");
    assert.equal(normalizeTwinToken("a".repeat(31)), null, "too short");
  });

  await t.test("parses by key, because registrar forms reorder fields", () => {
    assert.deepEqual(parseTwinProof(`token=${TOKEN} v=moshpit1 name=blue.eggs`),
      { name: "blue.eggs", token: TOKEN });
    // Unknown fields are ignored so the format can grow one without every
    // already-published record turning invalid that day.
    assert.deepEqual(parseTwinProof(`v=moshpit1 name=blue.eggs token=${TOKEN} future=yes`),
      { name: "blue.eggs", token: TOKEN });
  });

  await t.test("is not fooled by something that merely looks like one", () => {
    assert.equal(parseTwinProof(""), null);
    assert.equal(parseTwinProof("v=spf1 include:example.com ~all"), null);
    assert.equal(parseTwinProof(`v=moshpit2 name=blue.eggs token=${TOKEN}`), null, "wrong version");
    assert.equal(parseTwinProof("v=moshpit1 name=blue.eggs"), null, "no token");
    assert.equal(parseTwinProof(`v=moshpit1 token=${TOKEN}`), null, "no name");
    assert.equal(parseTwinProof(`v=moshpit1 name=a.b.c token=${TOKEN}`), null, "not a pit name");
  });

  await t.test("matches one record among the several a real domain carries", () => {
    const want = { name: "blue.eggs", token: TOKEN };
    const spf = "v=spf1 include:_spf.google.com ~all";
    const stale = `v=moshpit1 name=blue.eggs token=${OTHER}`;
    assert.equal(twinProofMatches([spf, stale, twinProof(want)], want), true);
    assert.equal(twinProofMatches([spf, stale], want), false, "only a superseded token");
    assert.equal(twinProofMatches([], want), false);
    assert.equal(twinProofMatches(null, want), false);
  });

  await t.test("reassembles a record DNS split into chunks", () => {
    const want = { name: "blue.eggs", token: TOKEN };
    const value = twinProof(want);
    const chunked = [value.slice(0, 20), value.slice(20)];
    assert.equal(twinProofMatches([chunked], want), true);
  });

  await t.test("will not accept a proof issued for another name", () => {
    const theirs = twinProof({ name: "red.eggs", token: TOKEN });
    assert.equal(twinProofMatches([theirs], { name: "blue.eggs", token: TOKEN }), false);
  });
});

test("a twin lapses on our clock, ahead of the registrar's", async (t) => {
  const now = 1_700_000_000_000;
  const verified = (expires_at) => ({ status: "verified", expires_at });

  await t.test("only a verified twin is ever live", () => {
    assert.equal(twinIsLive(verified(null), now), true);
    assert.equal(twinIsLive({ status: "pending", expires_at: null }, now), false);
    assert.equal(twinIsLive(null, now), false);
    assert.equal(twinIsLive(undefined, now), false);
  });

  await t.test("goes dark a lead time before it expires", () => {
    const lead = TWIN_UNLINK_LEAD_MS;
    assert.equal(twinIsLive(verified(now + lead + 1), now), true, "just outside the window");
    assert.equal(twinIsLive(verified(now + lead), now), false, "at the boundary");
    assert.equal(twinIsLive(verified(now + lead - 1), now), false, "inside the window");
    assert.equal(twinIsLive(verified(now - 1), now), false, "already expired");
    // The point of the lead: the domain is still registered, and we have
    // already stopped handing it out.
    assert.equal(twinIsLive(verified(now + 1), now), false, "expires tomorrow, dropped today");
  });
});

test("a twin is priced as one number", () => {
  assert.equal(TWIN_PRICE_USD, 12);
  assert.equal(Number.isInteger(TWIN_PRICE_USD), true, "a price a person can hold in their head");
});
