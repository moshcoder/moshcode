// A target that is not installed yet must be planned with its INSTALLER, never
// with its native updater.
//
// `upgradeSpec`/`toolUpgradeSpec` prefer an entry's native updater when it has
// one — `doppler update`, `aider --upgrade`, `opencode upgrade`. That command
// IS the missing binary, so for a target that is not present it can only fail
// with ENOENT. planUpgrade used to call those helpers regardless of the
// `installed` flag it computes on the very next line, so `moshcode upgrade
// doppler` announced "(installing — not present)" and then ran `doppler
// update`.
//
// The entries with no native updater (ugig, coinpay, claude, …) fall back to
// `install` on their own, which is why the pre-existing test named "explicit
// tool upgrades use official installers even when not installed" passed while
// the claim was false: it only exercises ugig and coinpay.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { planUpgrade } from "../src/upgrade.mjs";
import { ENGINES } from "../src/engines.mjs";
import { TOOLS } from "../src/tools.mjs";

/**
 * Run `fn` with a PATH containing exactly `names` as executables. The PATH is
 * REPLACED, not prepended to, for the same reason test/upgrade.test.mjs does
 * it: "which targets are installed" is the thing under test, so a real gh or
 * tailscale on the developer's box must not leak into the plan.
 */
function withPath(names, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "moshcode-upgrade-missing-"));
  for (const name of names) {
    const file = path.join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const before = process.env.PATH;
  process.env.PATH = dir;
  try { return fn(); }
  finally { process.env.PATH = before; }
}

const specOf = (target) => withPath([], () => planUpgrade([target]).items[0]);

// Every entry that HAS a native updater. Derived rather than hardcoded so a
// newly added updater is covered automatically instead of silently skipped.
const withNativeUpdater = [
  ...Object.entries(ENGINES).filter(([, e]) => e.upgrade).map(([key, e]) => [key, e, "engine"]),
  ...Object.entries(TOOLS).filter(([, t]) => t.upgrade).map(([key, t]) => [key, t, "tool"]),
];

// --- the bug -----------------------------------------------------------

test("a missing tool with a native updater is planned with its installer", () => {
  const item = specOf("doppler");
  assert.equal(item.installed, false);
  assert.notDeepEqual(item.spec, TOOLS.doppler.upgrade);
  assert.deepEqual(item.spec, TOOLS.doppler.install);
});

test("a missing engine with a native updater is planned with its installer", () => {
  const item = specOf("opencode");
  assert.equal(item.installed, false);
  assert.notDeepEqual(item.spec, ENGINES.opencode.upgrade);
  assert.deepEqual(item.spec, ENGINES.opencode.install);
});

test("a missing engine reached through an alias is planned with its installer", () => {
  // `pc` resolves to privacycode, whose updater is `privacycode upgrade`.
  const item = specOf("pc");
  assert.equal(item.key, "privacycode");
  assert.equal(item.installed, false);
  assert.deepEqual(item.spec, ENGINES.privacycode.install);
});

test("no missing target is ever planned to run the binary it is missing", () => {
  // The sweep that matters: for EVERY entry with a native updater, the planned
  // command for a not-installed target must not be the absent binary itself.
  assert.ok(withNativeUpdater.length >= 5, "expected several native updaters");
  for (const [key, entry, kind] of withNativeUpdater) {
    const item = specOf(key);
    assert.equal(item.installed, false, `${kind} ${key} should not be installed`);
    assert.notEqual(item.spec.cmd, entry.bin ?? key, `${kind} ${key} plans the missing binary`);
    assert.deepEqual(item.spec, entry.install, `${kind} ${key} should use its installer`);
  }
});

test("a missing target's plan is a command that could actually install it", () => {
  // Guards the fix's intent rather than its shape: an installer fetches
  // something, so the planned command line mentions a fetcher or a package
  // manager. A bare `doppler update` satisfies neither.
  for (const [key] of withNativeUpdater) {
    const { spec } = specOf(key);
    const line = [spec.cmd, ...(spec.args ?? [])].join(" ");
    assert.match(line, /curl|wget|npm|pip|brew/, `${key} plan is not an install command: ${line}`);
  }
});

// --- controls: these must hold both before and after the fix -----------

test("an INSTALLED tool still uses its native updater", () => {
  const item = withPath(["doppler"], () => planUpgrade(["doppler"]).items[0]);
  assert.equal(item.installed, true);
  assert.deepEqual(item.spec, TOOLS.doppler.upgrade);
});

test("an INSTALLED engine still uses its native updater", () => {
  const item = withPath(["opencode"], () => planUpgrade(["opencode"]).items[0]);
  assert.equal(item.installed, true);
  assert.deepEqual(item.spec, ENGINES.opencode.upgrade);
});

test("entries with no native updater are unchanged whether installed or not", () => {
  // The behaviour the pre-existing test asserted; it must not regress.
  const missing = withPath([], () => planUpgrade(["ugig", "coinpay"]).items);
  assert.deepEqual(missing.map((i) => i.spec), [TOOLS.ugig.install, TOOLS.coinpay.install]);
  const present = withPath(["ugig", "coinpay"], () => planUpgrade(["ugig", "coinpay"]).items);
  assert.deepEqual(present.map((i) => i.spec), [TOOLS.ugig.install, TOOLS.coinpay.install]);
});

test("the installed flag itself is still reported per target", () => {
  const items = withPath(["doppler"], () => planUpgrade(["doppler", "tailscale"]).items);
  assert.deepEqual(items.map((i) => [i.key, i.installed]), [["doppler", true], ["tailscale", false]]);
});

test("bulk selections still only include installed targets", () => {
  // `tools`/`engines`/`all` filter on installed, so they never reach the
  // not-installed branch at all — the fix must not widen them.
  const plan = withPath(["ugig", "doppler"], () => planUpgrade(["tools"]));
  assert.deepEqual(plan.items.map((i) => i.key), ["ugig", "doppler"]);
  assert.deepEqual(plan.items.find((i) => i.key === "doppler").spec, TOOLS.doppler.upgrade);
});

test("unknown targets are still collected rather than planned", () => {
  const plan = withPath([], () => planUpgrade(["doppler", "nosuchthing"]));
  assert.deepEqual(plan.unknown, ["nosuchthing"]);
  assert.deepEqual(plan.items.map((i) => i.key), ["doppler"]);
});
