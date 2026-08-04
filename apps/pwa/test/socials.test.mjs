import assert from "node:assert/strict";
import test from "node:test";

import { NOSTR_RELAYS, nostrComposerPage } from "../src/routes/socials.mjs";

test("Nostr composer loads the pinned NIP-07/NIP-46 bridge", () => {
  const html = nostrComposerPage();
  assert.match(html, /window\.nostr\.js@0\.5\.0\/dist\/window\.nostr\.min\.js/);
  assert.match(html, /window\.nostr\.getPublicKey\(\)/);
  assert.match(html, /window\.nostr\.signEvent\(/);
});

test("Nostr composer creates kind-1 events and publishes to every named relay", () => {
  const html = nostrComposerPage();
  assert.match(html, /kind: 1/);
  assert.match(html, /\["EVENT", event\]/);
  for (const relay of NOSTR_RELAYS) assert.ok(html.includes(relay), `${relay} is not rendered`);
});

test("Nostr composer reads the draft from the fragment", () => {
  const html = nostrComposerPage();
  assert.match(html, /location\.hash\.slice\(1\)/);
  assert.doesNotMatch(html, /location\.search/);
});
