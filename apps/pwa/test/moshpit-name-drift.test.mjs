// The vendored namespace rules, against the published ones.
//
// src/lib/moshpit-name.mjs is a copy of @moshcoder/moshpit-name, and it stays a
// copy: apps/pwa is not part of a pnpm workspace, so the repo-root install that
// CI runs never reaches it and its dependencies are simply absent there. A
// runtime import would fail at load — which is exactly what happened when this
// was tried the other way round.
//
// So the dependency is dev-only, nothing at runtime needs it, and this compares
// the two. Behaviour rather than bytes, because the copies are allowed to carry
// different comments and must not be allowed to carry different rules.
//
// Skips when the package is absent, so a checkout without dev dependencies
// still runs everything else.
import assert from "node:assert/strict";
import test from "node:test";

import * as vendored from "../src/lib/moshpit-name.mjs";

let published = null;
try { published = await import("@moshcoder/moshpit-name"); } catch { published = null; }

const NAMES = [
  "blue.eggs", "a.b.c", "1.2.3.4", "localhost", "", "eggs", "blue.420", "420.blue",
  "1.420", "192.168", "0.0", "-bad.eggs", "bad-.eggs", "x".repeat(64) + ".eggs", "A.EGGS.",
];

test("vendored namespace rules match the published package", {
  skip: published ? false : "@moshcoder/moshpit-name not installed",
}, async (t) => {
  await t.test("every hostname parses the same way", () => {
    for (const n of NAMES) {
      assert.deepEqual(vendored.parseMoshpitName(n), published.parseMoshpitName(n), n);
    }
  });

  await t.test("the same endings are refused, for the same reason", () => {
    for (const tld of ["bank", "apple", "gov", "eggs", "420", "a", "", "a.b", "com"]) {
      assert.equal(vendored.normalizeTld(tld), published.normalizeTld(tld), `normalizeTld(${tld})`);
      assert.equal(vendored.tldRejection(tld), published.tldRejection(tld), `tldRejection(${tld})`);
    }
    // A reserved list that drifts is a list where one copy sells a name the
    // other protects.
    assert.deepEqual([...vendored.RESERVED_TLDS].sort(), [...published.RESERVED_TLDS].sort());
  });

  await t.test("prices and limits have not drifted apart", () => {
    for (const key of [
      "CHILD_PRICE_USD", "ENDING_PRICE_USD", "MAX_CHILD_PRICE_USD",
      "DEFAULT_TLD_PRICE_USD", "MAX_BULK_TLDS", "BULK_CHUNK",
    ]) {
      assert.equal(vendored[key], published[key], key);
    }
  });

  await t.test("a pasted list parses identically, settings and all", () => {
    const pastes = [
      ".toplevel .redirect $2.00USD\neggs, yeah\n# a comment\n.911 $5",
      "oranges\t\tmosh",
      ".Eggs\nEGGS\neggs",
      "",
    ];
    for (const paste of pastes) {
      assert.deepEqual(vendored.parseTldList(paste), published.parseTldList(paste), JSON.stringify(paste));
    }
  });

  await t.test("resolution precedence agrees across the whole input space", () => {
    for (const registered of [true, false]) {
      for (const mode of ["clearnet", "moshpit", "nonsense"]) {
        assert.equal(
          vendored.resolutionPreference({ registered, mode }),
          published.resolutionPreference({ registered, mode }),
          `${mode}/${registered}`,
        );
      }
    }
  });
});
