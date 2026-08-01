// Checking before installing.
//
// `moshcode update` re-fetches Node, bun and the release tarball every run.
// Fine as a thing you type; wrong as a thing a timer runs every fifteen
// minutes, where it is minutes of network and disk to discover nothing changed.
import test from "node:test";
import assert from "node:assert/strict";

import { isNewer, latestRelease, normalizeVersion, selfUpdateCommand, timerUnits, updatePlan } from "../src/selfupdate.mjs";

const release = (tag) => async () => ({ ok: true, json: async () => ({ tag_name: tag }) });

test("versions compare in order, so a rollback is not an upgrade", () => {
  assert.equal(isNewer("v0.16.4", "0.16.3"), true);
  assert.equal(isNewer("0.16.3", "0.16.4"), false, "published is behind — reinstalling would downgrade");
  assert.equal(isNewer("v0.16.4", "0.16.4"), false);
  assert.equal(isNewer("v1.0.0", "0.99.99"), true);
  assert.equal(isNewer("v0.17.0", "0.16.99"), true);
  // Plain string inequality would call these upgrades. They are not.
  assert.equal(isNewer("v0.9.0", "0.10.0"), false);
  assert.deepEqual(normalizeVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(normalizeVersion("nonsense"), null);
  assert.equal(isNewer("nonsense", "0.1.0"), false);
});

test("an unreachable feed means do nothing, not reinstall", async () => {
  // A timer that reinstalls on every failed check would hammer a machine that
  // is merely offline.
  assert.equal(await latestRelease({ fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await latestRelease({ fetchImpl: async () => ({ ok: false }) }), null);

  const plan = await updatePlan({ installed: "0.16.4", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(plan.act, false);
  assert.match(plan.why, /could not reach/);
});

test("up to date is a no-op with a reason", async () => {
  const plan = await updatePlan({ installed: "0.16.4", fetchImpl: release("v0.16.4") });
  assert.equal(plan.act, false);
  assert.match(plan.why, /already on 0\.16\.4/);
});

test("a newer release is acted on", async () => {
  const plan = await updatePlan({ installed: "0.16.4", fetchImpl: release("v0.17.0") });
  assert.equal(plan.act, true);
  assert.match(plan.why, /0\.16\.4 → v0\.17\.0/);
});

test("--check never installs, even when an update exists", async () => {
  let installed = false;
  const lines = [];
  await selfUpdateCommand(["--check"], (l) => lines.push(l), {
    plan: async () => ({ act: true, why: "0.1.0 → 0.2.0" }),
    upgrade: async () => { installed = true; return 0; },
  });
  assert.equal(installed, false);
  assert.match(lines.join("\n"), /update available/);
});

test("--if-newer installs only when there is something newer", async () => {
  let runs = 0;
  const upgrade = async () => { runs += 1; return 0; };

  await selfUpdateCommand(["--if-newer"], () => {}, { plan: async () => ({ act: false, why: "already on x" }), upgrade });
  assert.equal(runs, 0, "no update means no install");

  await selfUpdateCommand(["--if-newer"], () => {}, { plan: async () => ({ act: true, why: "x → y" }), upgrade });
  assert.equal(runs, 1);
});

test("the timer survives a sleeping laptop and runs the checking form", () => {
  const units = timerUnits({ interval: "15min" });
  const timer = units["moshcode-update.timer"];
  // Without Persistent a machine asleep at the scheduled moment skips until
  // the next interval, which on a laptop can be days.
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^OnUnitActiveSec=15min$/m);

  // The unit must run the checking form. Pointing it at a bare `update` is how
  // a fifteen-minute timer becomes a fifteen-minute reinstall.
  assert.match(units["moshcode-update.service"], /update --if-newer/);

  assert.match(timerUnits({ interval: "1h" })["moshcode-update.timer"], /^OnUnitActiveSec=1h$/m);
});

test("--timer prints the units and writes nothing without --install", async () => {
  let wrote = 0;
  const lines = [];
  await selfUpdateCommand(["--timer"], (l) => lines.push(l), { write: async () => { wrote += 1; } });
  assert.equal(wrote, 0);
  assert.match(lines.join("\n"), /nothing written/);
});
