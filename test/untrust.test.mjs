/**
 * Taking the local root back out — the undo `dns disable` never had.
 *
 * `dns enable` installs a CA as a system trust anchor. The restore point it
 * writes covers /etc, which is the right shape for resolver config and the
 * wrong shape for this: a trust store is not a file the manifest can capture
 * and replay. So for a long time `dns disable` put the routing back and left
 * behind the one change with security consequences.
 *
 * The property every test here is a version of: a trust anchor reported as
 * removed must actually be gone, and one that could not be removed must say so
 * rather than be quietly counted as success. A machine that believes it stopped
 * trusting a root it still trusts is worse off than one that knows it does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { applyUntrust, trustStores, untrustPlan } from "../src/trust.mjs";

const HOME = "/home/tester";
const CA = path.join(HOME, ".moshpit", "ca.crt");

/** Collects the report, the way the dns command's `out` does. */
function out() {
  const lines = [];
  const write = (line) => lines.push(String(line));
  write.text = () => lines.join("\n");
  write.lines = lines;
  return write;
}

/** A runner that succeeds at everything and remembers what it was asked. */
function runner(overrides = {}) {
  const calls = [];
  const impl = async (command, args) => {
    calls.push({ command, args: [...args], line: `${command} ${args.join(" ")}` });
    const hit = overrides[command];
    if (typeof hit === "function") return hit(args);
    return hit || { ok: true, stdout: "", stderr: "" };
  };
  impl.calls = calls;
  return impl;
}

test("every store this build can install into, it can also remove from", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const store of trustStores({ platform, home: HOME, caFile: CA })) {
      assert.ok(store.remove, `${platform}/${store.id} can be installed but never removed`);
      assert.ok(store.remove.command, `${platform}/${store.id} has no removal command`);
    }
  }
});

test("removal is not gated on the root being safe to install", () => {
  // The point: a root that should never have been trusted is the one you most
  // need to be able to withdraw. untrustPlan takes no certificate at all.
  const plan = untrustPlan({ platform: "linux", home: HOME, caFile: CA, isRoot: true });

  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 2, "nss and the system store");
  assert.deepEqual(plan.skipped, []);
});

test("the NSS anchor is withdrawn by nickname, so a deleted root is no obstacle", () => {
  const plan = untrustPlan({
    platform: "linux", home: HOME, caFile: CA, isRoot: true, haveFile: false,
  });

  const nss = plan.steps.find((s) => s.id === "nss");
  assert.ok(nss, "nss must still be removable with the certificate gone");
  assert.ok(nss.remove.args.includes("-D"), "delete, not add");
  assert.ok(nss.remove.args.includes("Moshpit Local CA"));
  assert.ok(!nss.remove.args.includes(CA), "must not need the file it no longer has");
});

test("the macOS keychain says so when the root it needs is gone", () => {
  const withFile = untrustPlan({ platform: "darwin", home: HOME, caFile: CA, isRoot: true, haveFile: true });
  assert.equal(withFile.steps.length, 1);

  const without = untrustPlan({ platform: "darwin", home: HOME, caFile: CA, isRoot: true, haveFile: false });
  assert.equal(without.steps.length, 0, "cannot be done");
  assert.equal(without.skipped.length, 1, "and must not be silent about it");
  assert.match(without.skipped[0].why, /can only be told with it/);
});

test("the system store is skipped without root, and names the fix", async () => {
  const plan = untrustPlan({ platform: "linux", home: HOME, caFile: CA, isRoot: false });

  assert.deepEqual(plan.steps.map((s) => s.id), ["nss"], "the user-level half still works");
  assert.deepEqual(plan.skipped.map((s) => s.id), ["system"]);

  const write = out();
  await applyUntrust(write, {
    platform: "linux", home: HOME, uid: 1000, env: {},
    readFile: async () => "cert",
    runner: runner(),
  });
  assert.match(write.text(), /sudo moshcode dns disable/);
});

test("the Debian copy is deleted before the bundle is rebuilt", async () => {
  const write = out();
  const run = runner();

  await applyUntrust(write, {
    platform: "linux", home: HOME, uid: 0, env: {},
    readFile: async () => "cert",
    runner: run,
  });

  const rm = run.calls.findIndex((c) => c.command === "rm");
  const refresh = run.calls.findIndex((c) => c.command === "update-ca-certificates");
  assert.ok(rm !== -1, "the copy in /usr/local/share/ca-certificates must be removed");
  assert.ok(refresh > rm, "removing the source before the rebuild is what drops the symlink");
  assert.ok(run.calls[refresh].args.includes("--fresh"), "a bare refresh adds, it does not drop");
  assert.match(write.text(), /removed from the system store/);
});

test("an anchor that was already gone reads as done, not as a failure", async () => {
  // Running `dns disable` twice is ordinary. certutil's complaint that the
  // nickname is not in the database describes the state we wanted.
  const write = out();
  const run = runner({
    certutil: () => ({ ok: false, stdout: "", stderr: "certutil: could not find certificate named...: SEC_ERROR_BAD_DATA" }),
  });

  const result = await applyUntrust(write, {
    platform: "linux", home: HOME, uid: 0, env: {},
    readFile: async () => "cert",
    runner: run,
  });

  assert.equal(result.ok, true);
  assert.match(write.text(), /was not there/);
  assert.ok(!/FAIL/.test(write.text()), "an already-absent anchor is not a failure");
});

test("a removal that genuinely failed is reported as FAIL and not counted", async () => {
  const write = out();
  const run = runner({
    "update-ca-certificates": () => ({ ok: false, stdout: "", stderr: "update-ca-certificates: permission denied" }),
  });

  const result = await applyUntrust(write, {
    platform: "linux", home: HOME, uid: 0, env: {},
    readFile: async () => "cert",
    runner: run,
  });

  assert.match(write.text(), /FAIL the system store/);
  assert.equal(result.removed, 1, "only the NSS half succeeded");
});

test("an NSS database written as root is handed back to the operator", async () => {
  const write = out();
  const run = runner();

  await applyUntrust(write, {
    platform: "linux", home: HOME, uid: 0, env: { SUDO_USER: "tester" },
    readFile: async () => "cert",
    runner: run,
  });

  const chown = run.calls.find((c) => c.command === "chown");
  assert.ok(chown, "root must not leave the browser unable to update its own store");
  assert.deepEqual(chown.args, ["-R", "tester:", path.join(HOME, ".pki", "nssdb")]);
});

test("nothing to remove prints nothing at all", async () => {
  const write = out();

  const result = await applyUntrust(write, {
    platform: "sunos", home: HOME, uid: 0, env: {},
    readFile: async () => "cert",
    runner: runner(),
  });

  assert.equal(result.removed, 0);
  assert.deepEqual(write.lines, [], "a platform with no known store is not an occasion for a heading");
});
