// The sign-in page carries the server-rendered Profullstack footer: the webring
// row (rssamplifier's verifier reads HTML, never runs script) and the clearnet
// template, never the pit.world one (app.moshcode.sh is an ICANN host).
import assert from "node:assert/strict";
import test from "node:test";

process.env.PROFULLSTACK_FOOTER_OFFLINE = "1";
const { ringFooter, setRingFooter, RING_FOOTER_OPTIONS } = await import("../src/lib/ring-footer.mjs");

test("ring footer links the Profullstack ring from app.moshcode.sh", () => {
  const html = ringFooter();
  assert.match(html, /rssamplifier\.com\/ring\/profullstack/);
  assert.match(html, /from=https%3A%2F%2Fapp\.moshcode\.sh%2F/);
  assert.match(html, /href="https:\/\/built\.indie\.pit\.world\/for\?site=https:\/\/app\.moshcode\.sh\/"/);
  assert.match(html, /src="https:\/\/logicsrc\.com\/openicon\/set\/hq\/svg\/built-indie\.svg"/);
  assert.match(html, /href="https:\/\/pwamart\.com\/for\?site=https:\/\/app\.moshcode\.sh\/"/);
  assert.match(html, /src="https:\/\/logicsrc\.com\/openicon\/set\/hq\/svg\/pwamart\.svg"/);
  assert.doesNotMatch(html, /pit\.world network/);
  assert.equal(RING_FOOTER_OPTIONS.site, "https://app.moshcode.sh/");
});

test("a refreshed footer that lost the ring is rejected", () => {
  const before = ringFooter();
  assert.equal(setRingFooter("<footer>nothing</footer>"), false);
  assert.equal(setRingFooter(42), false);
  assert.equal(ringFooter(), before);
});
