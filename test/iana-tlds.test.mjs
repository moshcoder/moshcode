// Moshpit must not sell, or answer for, an ending that already exists.
//
// `.sh` was claimed through the ordinary registration flow for $2. It is Saint
// Helena's ccTLD, and it is also where this project's own registry lives:
// `pit.moshcode.sh`. Every bridge that fetched the ending list therefore
// learned to treat its own registry as a Moshpit name — refused to forward it,
// tried to resolve it through the registry it had just made unreachable, and
// returned NXDOMAIN. A resolver that cannot resolve the thing it needs in order
// to resolve.
//
// It took the rest of the ccTLD with it. On a machine running the bridge as its
// resolver, every real `.sh` site answered a parking IP instead.
//
// So both halves are tested here. The registry must refuse to sell one, which
// stops it happening again; the bridge must refuse to answer for one, which is
// what protects a person whose registry already sold 622 of them. Neither is
// sufficient alone — the second is the one that works today.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { IANA_TLDS, IANA_VERSION, isRealTld } from "../src/iana-tlds.mjs";
import { isOurs } from "../src/dns.mjs";
import { tldRejection } from "../apps/pwa/src/lib/moshpit-name.mjs";

/* ------------------------------------------------------------- the list */

test("the list is the real one, not a stub someone shortened", () => {
  assert.ok(IANA_TLDS.size > 1000, `only ${IANA_TLDS.size} TLDs — a truncated list silently re-opens the hole`);
  assert.match(IANA_VERSION, /Version \d{10}/);
  for (const real of ["com", "net", "org", "sh", "ai", "dev", "app", "io", "uk", "xn--p1ai"]) {
    assert.equal(isRealTld(real), true, `${real} is a real TLD`);
  }
});

test("endings that are not real TLDs stay claimable", () => {
  // The namespace has to keep working. These are live Moshpit endings.
  for (const made of ["eggs", "hacker", "2600", "moshpit", "agentic"]) {
    assert.equal(isRealTld(made), false, `${made} is not delegated by IANA and must stay available`);
  }
});

test("case and dots do not smuggle one past", () => {
  assert.equal(isRealTld("SH"), true);
  assert.equal(isRealTld(" sh "), true);
  assert.equal(isRealTld(""), false);
  assert.equal(isRealTld(null), false);
  assert.equal(isRealTld(undefined), false);
});

/* -------------------------------------------------------- the registry */

test("the registry refuses to sell a real top-level domain", () => {
  for (const real of ["sh", "ai", "dev", "app", "store", "blog", "aws"]) {
    assert.match(tldRejection(real) || "", /real top-level domain/, `.${real} must be refused`);
  }
});

test("the registry still sells endings that are not real TLDs", () => {
  for (const made of ["eggs", "hacker", "2600", "agentic"]) {
    assert.equal(tldRejection(made), null, `.${made} must stay registerable`);
  }
});

test("the reserved list still does its own job", () => {
  // `openai` and `moshpit` are not IANA TLDs, so they are refused for the older
  // reason — and that reason must not have been replaced by this one. (`bank`
  // makes a poor example here: it really is a delegated gTLD.)
  for (const name of ["openai", "anthropic", "moshpit", "police"]) {
    assert.equal(isRealTld(name), false, `${name} is not IANA-delegated`);
    assert.match(tldRejection(name) || "", /reserved/, `.${name} must still be refused as reserved`);
  }
});

/* ---------------------------------------------------------- the bridge */

test("the bridge never answers for a real TLD, even when the registry sold it", () => {
  // Exactly the state of the live registry: `sh` present in the ending set.
  const sold = new Set(["sh", "ai", "dev", "eggs", "2600"]);
  assert.equal(isOurs("pit.moshcode.sh", sold), false, "its own registry must be forwarded, not swallowed");
  assert.equal(isOurs("moshcoding.sh", sold), false);
  assert.equal(isOurs("anything.ai", sold), false);
  assert.equal(isOurs("foo.dev", sold), false);
});

test("the bridge still answers for the endings Moshpit actually owns", () => {
  const sold = new Set(["sh", "ai", "dev", "eggs", "2600"]);
  assert.equal(isOurs("blue.eggs", sold), true);
  assert.equal(isOurs("alt.2600", sold), true);
});

test("an ending the registry never sold is still not ours", () => {
  assert.equal(isOurs("blue.eggs", new Set(["hacker"])), false);
  assert.equal(isOurs("blue.eggs", new Set()), false);
});

/* ------------------------------------------------------------- vendoring */

test("the CLI's copy and the Pit's copy are identical", async () => {
  // They live in two packages that never import each other — `src/` ships to
  // npm, `apps/pwa/` deploys as the Pit and is not a workspace. A list that
  // drifts is a registry selling what the bridge refuses to answer for, or
  // worse, the reverse.
  const [cli, pit] = await Promise.all([
    readFile(new URL("../src/iana-tlds.mjs", import.meta.url), "utf8"),
    readFile(new URL("../apps/pwa/src/lib/iana-tlds.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(cli, pit, "regenerate both with: node scripts/generate-iana-tlds.mjs");
});
