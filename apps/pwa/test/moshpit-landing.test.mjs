// Someone typed `mosh.whatever` and landed on the pit. What they are offered
// has to match what the registry will actually let them do — an invitation to
// register a name that `registerName` then refuses is worse than a plain no.
import assert from "node:assert/strict";
import test from "node:test";

import { landingFor } from "../src/lib/moshpit-landing.mjs";

test("an unclaimed ending is offered whole", () => {
  const landing = landingFor("mosh.whatever", { tldOwned: false });
  assert.equal(landing.kind, "claim-tld");
  assert.equal(landing.tld, "whatever");
  assert.equal(landing.label, "mosh");
  assert.equal(landing.name, "mosh.whatever");
});

test("your own ending puts the name one form away", () => {
  assert.equal(
    landingFor("mosh.whatever", { tldOwned: true, ownedByViewer: true, nameRegistered: false }).kind,
    "mint-name",
  );
  assert.equal(
    landingFor("mosh.whatever", { tldOwned: true, ownedByViewer: true, nameRegistered: true }).kind,
    "yours",
  );
});

test("someone else's minted name says so, and where it points", () => {
  const landing = landingFor("mosh.whatever", {
    tldOwned: true, ownedByViewer: false, nameRegistered: true, target: "203.0.113.9",
  });
  assert.equal(landing.kind, "taken");
  assert.equal(landing.target, "203.0.113.9");
});

test("a free name under an ending that is listed for sale is offered at its price", () => {
  const landing = landingFor("mosh.whatever", {
    tldOwned: true, ownedByViewer: false, nameRegistered: false, priceUsd: 12.5,
  });
  assert.equal(landing.kind, "buy");
  assert.equal(landing.priceUsd, 12.5);
});

test("a free name is priced at zero if that is what the operator set", () => {
  // 0 is a price, not the absence of one — `?? null` would be fine but `||`
  // would quietly turn a free ending into "not selling".
  const landing = landingFor("mosh.whatever", {
    tldOwned: true, ownedByViewer: false, nameRegistered: false, priceUsd: 0,
  });
  assert.equal(landing.kind, "buy");
  assert.equal(landing.priceUsd, 0);
});

test("an unlisted ending says so rather than dead-ending in a checkout", () => {
  // quoteName() refuses when no price is set, so a Buy button here would take
  // someone to an error.
  const landing = landingFor("mosh.whatever", {
    tldOwned: true, ownedByViewer: false, nameRegistered: false, priceUsd: null,
  });
  assert.equal(landing.kind, "not-for-sale");
});

test("anything that is not a Moshpit name lands on nothing at all", () => {
  for (const input of ["", null, "whatever", "a.b.c", "https://mosh.whatever", "mosh.whatever/path"]) {
    assert.equal(landingFor(input, { tldOwned: false }).kind, "none", `${JSON.stringify(input)}`);
  }
});

test("the name is normalised the way the registry normalises it", () => {
  const landing = landingFor("  MOSH.Whatever.  ", { tldOwned: false });
  assert.equal(landing.name, "mosh.whatever");
});
