// Unit tests for the browser-side Nostr composer.
//
// Same shape as the other PWA tests: the route module pulls in express at load
// time, so probe for it first and skip cleanly when the PWA dependencies aren't
// installed — that keeps the root `pnpm test` green in a fresh clone.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let hasDeps = true;
try {
  require("express");
} catch {
  hasDeps = false;
}

const skip = hasDeps ? false : "PWA dependencies are not installed";

async function composer() {
  const { NOSTR_RELAYS, nostrComposerPage } = await import("../src/routes/socials.mjs");
  return { NOSTR_RELAYS, html: nostrComposerPage() };
}

test("Nostr composer loads the pinned NIP-07/NIP-46 bridge", { skip }, async () => {
  const { html } = await composer();
  assert.match(html, /window\.nostr\.js@0\.5\.0\/dist\/window\.nostr\.min\.js/);
  assert.match(html, /window\.nostr\.getPublicKey\(\)/);
  assert.match(html, /window\.nostr\.signEvent\(/);
});

test("Nostr composer creates kind-1 events and publishes to every named relay", { skip }, async () => {
  const { NOSTR_RELAYS, html } = await composer();
  assert.match(html, /kind: 1/);
  assert.match(html, /\["EVENT", event\]/);
  for (const relay of NOSTR_RELAYS) assert.ok(html.includes(relay), `${relay} is not rendered`);
});

test("Nostr composer reads the draft from the fragment", { skip }, async () => {
  const { html } = await composer();
  assert.match(html, /location\.hash\.slice\(1\)/);
  assert.doesNotMatch(html, /location\.search/);
});
