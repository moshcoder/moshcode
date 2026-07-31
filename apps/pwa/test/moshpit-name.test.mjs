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
  assert.equal(normalizeTld("web3-agents"), "web3-agents");
});

test("normalizeTld rejects what could never be a TLD", () => {
  assert.equal(normalizeTld(""), null);
  assert.equal(normalizeTld("."), null);
  assert.equal(normalizeTld("foo.bar"), null, "a dot means they gave a domain");
  assert.equal(normalizeTld("-eggs"), null);
  assert.equal(normalizeTld("eggs-"), null);
  assert.equal(normalizeTld("egg s"), null);
  assert.equal(normalizeTld("123"), null, "ambiguous against an IPv4 literal");
  assert.equal(normalizeTld("a".repeat(64)), null);
  assert.equal(normalizeTld(null), null);
  assert.equal(normalizeTld(undefined), null);
});

test("hostname labels may be numeric even though TLDs may not", () => {
  assert.equal(normalizeLabel("123"), "123");
  assert.equal(normalizeTld("123"), null);
  assert.deepEqual(parseMoshpitName("123.eggs"), { label: "123", tld: "eggs" });
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
