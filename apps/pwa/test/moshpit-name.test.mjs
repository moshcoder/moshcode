// Pure validation + resolution-precedence rules for the Moshpit namespace.
// No database, so this runs everywhere and is safe for a client (the
// tronbrowser.dev extension) to reuse.
import assert from "node:assert/strict";
import test from "node:test";

import {
  RESERVED_TLDS, normalizeLabel, normalizeTld, tldRejection, parseMoshpitName,
  normalizeMode, resolutionPreference,
} from "../src/lib/moshpit-name.mjs";

test("normalizeTld accepts what people actually type", () => {
  assert.equal(normalizeTld("eggs"), "eggs");
  assert.equal(normalizeTld(".eggs"), "eggs");
  assert.equal(normalizeTld("  .EGGS  "), "eggs");
  assert.equal(normalizeTld("web3agents"), "web3agents");
});

test("normalizeTld rejects what could never be a TLD", () => {
  assert.equal(normalizeTld(""), null);
  assert.equal(normalizeTld("."), null);
  assert.equal(normalizeTld("foo.bar"), null, "a dot means they gave a domain");
  assert.equal(normalizeTld("-eggs"), null);
  assert.equal(normalizeTld("eggs-"), null);
  assert.equal(normalizeTld("egg s"), null);
  assert.equal(normalizeTld("a".repeat(64)), null);
  assert.equal(normalizeTld(null), null);
  assert.equal(normalizeTld(undefined), null);
});

test("either half of a name may be numeric — but not both", () => {
  assert.equal(normalizeLabel("123"), "123");
  // .420 and .187 are endings people want, and an ending on its own is never
  // mistaken for an address.
  assert.equal(normalizeTld("123"), "123");
  assert.deepEqual(parseMoshpitName("123.eggs"), { label: "123", tld: "eggs" });
  assert.deepEqual(parseMoshpitName("blue.420"), { label: "blue", tld: "420" });

  // Both halves numeric is where the IPv4 ambiguity actually lives: several
  // parsers read a two-part dotted number as an abbreviated address.
  assert.equal(parseMoshpitName("1.420"), null);
  assert.equal(parseMoshpitName("192.168"), null);
});

test("reserved names cannot be claimed", () => {
  for (const name of ["bank", "apple", "gov", "moshpit", "com"]) {
    assert.ok(RESERVED_TLDS.has(name), `${name} should be reserved`);
    assert.equal(tldRejection(name), "that name is reserved");
  }
  assert.equal(tldRejection("eggs"), null);
});

test("a TLD needs at least two characters", () => {
  assert.equal(tldRejection("a"), "a TLD needs at least 2 characters");
  assert.equal(tldRejection("ai"), null);
});

test("parseMoshpitName splits exactly one dot", () => {
  assert.deepEqual(parseMoshpitName("foo.agentic"), { label: "foo", tld: "agentic" });
  assert.deepEqual(parseMoshpitName(" FOO.Agentic "), { label: "foo", tld: "agentic" });
  assert.deepEqual(parseMoshpitName("123.agentic"), { label: "123", tld: "agentic" });
  assert.equal(parseMoshpitName("a.b.c"), null, "the namespace is one level deep");
  assert.equal(parseMoshpitName("nodot"), null);
  assert.equal(parseMoshpitName(""), null);
  assert.equal(parseMoshpitName("-bad.agentic"), null);
});

/* ---- resolution precedence: the tronbrowser.dev setting ---- */

test("mode defaults to clearnet, including for junk input", () => {
  assert.equal(normalizeMode(undefined), "clearnet");
  assert.equal(normalizeMode(""), "clearnet");
  assert.equal(normalizeMode("nonsense"), "clearnet");
  assert.equal(normalizeMode("MOSHPIT"), "moshpit");
  assert.equal(normalizeMode(" moshpit "), "moshpit");
  assert.equal(normalizeMode("clearnet"), "clearnet");
});

test("an unregistered name never displaces clearnet, in either mode", () => {
  assert.equal(resolutionPreference({ registered: false, mode: "clearnet" }), "clearnet");
  assert.equal(resolutionPreference({ registered: false, mode: "moshpit" }), "clearnet");
});

test("clearnet mode only fills gaps", () => {
  // The safe default: DNS stays authoritative, the pit answers when DNS won't.
  assert.equal(resolutionPreference({ registered: true, mode: "clearnet" }), "fallback");
  assert.equal(resolutionPreference({ registered: true, mode: undefined }), "fallback");
});

test("moshpit mode outranks clearnet — the squatted-domain case", () => {
  // profullstack.ai squatted in DNS, but ours in the pit: mode=moshpit wins.
  assert.equal(resolutionPreference({ registered: true, mode: "moshpit" }), "moshpit");
});

test("overriding DNS is opt-in, never the default", () => {
  // A resolver that silently outranked real DNS the first time it was switched
  // on would hijack names its operator never intended to touch.
  for (const mode of [undefined, "", "clearnet", "typo", null]) {
    assert.notEqual(resolutionPreference({ registered: true, mode }), "moshpit");
  }
});

test("all-numeric endings", async (t) => {
  const { normalizeTld, parseMoshpitName } = await import("../src/lib/moshpit-name.mjs");

  await t.test("an ending may be all digits", () => {
    // .420, .187, .911 are names people want; an ending on its own is never
    // mistaken for an address.
    for (const [input, expected] of [[".420", "420"], ["187", "187"], [".911", "911"], ["0", "0"]]) {
      assert.equal(normalizeTld(input), expected, input);
    }
  });

  await t.test("a name is fine when only one half is numeric", () => {
    assert.deepEqual(parseMoshpitName("blue.420"), { label: "blue", tld: "420" });
    assert.deepEqual(parseMoshpitName("bud.420"), { label: "bud", tld: "420" });
    assert.deepEqual(parseMoshpitName("420.blue"), { label: "420", tld: "blue" });
  });

  await t.test("both halves numeric is refused — that reads as an address", () => {
    // Several parsers read a two-part dotted number as an abbreviated IPv4,
    // so `1.420` is genuinely ambiguous where `blue.420` is not.
    assert.equal(parseMoshpitName("1.420"), null);
    assert.equal(parseMoshpitName("192.168"), null);
    assert.equal(parseMoshpitName("0.0"), null);
  });
});

test("dashes are not part of a Moshpit name", () => {
  // A dash is the cheapest way to mint a near-miss of an ending someone else
  // holds — `.cryp-to` beside `.crypto` — and a namespace one level deep with
  // no dispute process has nowhere to put the argument.
  assert.equal(normalizeTld("lazy-loaded"), null);
  assert.equal(normalizeTld("cryp-to"), null);
  assert.equal(normalizeLabel("register-me"), null);
  assert.equal(normalizeLabel("-leading"), null);
  assert.equal(normalizeLabel("trailing-"), null);

  // Unchanged either side of the dot.
  assert.equal(normalizeTld("oranges"), "oranges");
  assert.equal(normalizeTld("420"), "420");
  assert.equal(normalizeLabel("california"), "california");
  assert.equal(normalizeLabel("123"), "123");
  assert.equal(normalizeLabel("a".repeat(63)), "a".repeat(63));
  assert.equal(normalizeLabel("a".repeat(64)), null);
});
