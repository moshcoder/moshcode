// Whether catch-all routing is safe to write *right now*.
//
// The bug this exists for: the previous check asked whether upstreams were
// discoverable — a fact about the machine — and inferred the bridge would
// forward. On a desktop where the bridge is the only global nameserver, that
// inference is the difference between "Moshpit names do not resolve" and
// "nothing does". Which is what happened.
import test from "node:test";
import assert from "node:assert/strict";

import { catchAllSafety } from "../src/dns.mjs";

test("a running bridge that forwards makes catch-all safe", async () => {
  const safety = await catchAllSafety({ probe: async () => true });
  assert.equal(safety.safe, true);
  assert.match(safety.why, /forwards/);
});

test("a running bridge that does NOT forward blocks catch-all", async () => {
  // The exact shape that took a desktop off the internet: an older bridge
  // holds port 5354, `dns enable` reports "bridge already running" and leaves
  // it, and the new routing sends it every lookup on the machine.
  const safety = await catchAllSafety({
    // Fails the three-label probe, answers the two-label one — an older build
    // parking a Moshpit name.
    probe: async ({ name }) => name === "a.eggs",
  });
  assert.equal(safety.safe, false);
  assert.match(safety.why, /already running .* does not forward/);
});

test("no bridge running is safe, because enable starts ours next", async () => {
  const safety = await catchAllSafety({ probe: async () => false });
  assert.equal(safety.safe, true);
  assert.match(safety.why, /will be ours/);
});

test("the probe must not be fooled by a parked answer", async () => {
  // A two-label name is a Moshpit name to any build, and an older bridge
  // answers it with the parking address. An answer. Probing with one would
  // read as working forwarding and write catch-all against a bridge that
  // cannot forward — the precise failure being guarded here.
  const asked = [];
  await catchAllSafety({ probe: async ({ name }) => { asked.push(name); return false; } });
  assert.ok(asked[0].split(".").length >= 3, `probed ${asked[0]}, which could be a Moshpit name`);
});
