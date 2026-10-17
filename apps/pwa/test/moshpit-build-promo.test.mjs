// The build-and-host offer on /pit: it must reach the paid intake, and it must
// never echo a banner it was handed into the page unescaped.
import assert from "node:assert/strict";
import test from "node:test";
import { boughtName, buildPromo, BUILD_START_URL } from "../src/lib/moshpit-build-promo.mjs";

test("boughtName reads the name a buy or claim just handed over", () => {
  assert.equal(boughtName("pay.agent is yours."), "pay.agent");
  assert.equal(boughtName("Pay.Agent is yours"), "pay.agent");
  // An ending, a count, or anything else is not one name.
  assert.equal(boughtName(".agent is yours."), null);
  assert.equal(boughtName("3 names claimed"), null);
  assert.equal(boughtName(undefined), null);
});

test("the form posts to the chovy Starter intake, tagged as moshpit", () => {
  const html = buildPromo();
  assert.match(html, new RegExp(`action="${BUILD_START_URL}" method="get"`));
  assert.match(html, /name="plan" value="starter"/);
  assert.match(html, /name="ref" value="moshpit"/);
  assert.match(html, /<textarea name="idea"[^>]*required/);
  assert.match(html, /\$49/);
  assert.match(html, /\$2 a month/);
  assert.match(html, /href="https:\/\/pit\.world\/build"/);
});

test("a bought name seeds the idea and is escaped", () => {
  assert.match(buildPromo({ name: "pay.agent" }), />A site at pay\.agent: <\/textarea>/);
  const html = buildPromo({ name: "<x>.y" });
  assert.doesNotMatch(html, /<x>/);
});
