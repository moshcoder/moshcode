// `sudo moshcode update` is the one escalation this CLI must never accept.
// runUpgrade's self spec re-runs the installer, and every path the installer
// uses comes from $HOME — which sudo has set to /root. The update reports
// success, moshcode is reinstalled into root's home, and the operator is left
// with a `moshcode` on PATH that they cannot execute:
//
//     $ moshcode install secrets
//     zsh: permission denied: moshcode
//
// This is not theoretical; it happened on a real machine, and the path there
// was `sudo moshcode update` typed because `dns enable` asks for root.
import assert from "node:assert/strict";
import test from "node:test";

import { runUpgrade } from "../src/upgrade.mjs";

const collect = () => {
  const lines = [];
  return { lines, io: { log: (s) => lines.push(String(s)), rule: () => {} } };
};

const shouldNotRun = () => assert.fail("nothing should be executed after a refusal");

test("refuses an escalated update, and runs nothing", async () => {
  const { lines, io } = collect();
  const results = await runUpgrade([], {
    ...io,
    uid: 0,
    env: { SUDO_USER: "anthony", HOME: "/root" },
    runCmd: shouldNotRun,
  });

  const output = lines.join("\n");
  assert.match(output, /don't run moshcode update with sudo/);
  assert.match(output, /anthony/, "it should name the user who would be locked out");
  assert.match(output, /\/root/, "it should show the HOME that sudo substituted");

  // The caller turns a non-ok result into a non-zero exit, so a refusal must
  // not look like "nothing to do".
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
});

test("the refusal points at the escalation that does work", async () => {
  const { lines, io } = collect();
  await runUpgrade([], { ...io, uid: 0, env: { SUDO_USER: "anthony" }, runCmd: shouldNotRun });

  // Someone here got to `sudo moshcode update` from `dns enable` asking for
  // root, so the way out has to mention that dns now asks for itself.
  assert.match(lines.join("\n"), /dns enable/);
});

test("a bare root shell still upgrades", async () => {
  // Containers and root-only boxes have no SUDO_USER. Refusing there would
  // break a legitimate upgrade.
  const { lines, io } = collect();
  await runUpgrade([], { ...io, uid: 0, env: {}, runCmd: async () => ({ code: 0 }) });

  assert.doesNotMatch(lines.join("\n"), /don't run moshcode update with sudo/);
});

test("MOSHCODE_ALLOW_ROOT overrides the refusal", async () => {
  const { lines, io } = collect();
  await runUpgrade([], {
    ...io,
    uid: 0,
    env: { SUDO_USER: "anthony", MOSHCODE_ALLOW_ROOT: "1" },
    runCmd: async () => ({ code: 0 }),
  });

  assert.doesNotMatch(lines.join("\n"), /don't run moshcode update with sudo/);
});

test("an ordinary user is unaffected even with SUDO_USER set", async () => {
  // A normal shell inherits SUDO_USER after any earlier sudo call, so the uid
  // has to be what decides.
  const { lines, io } = collect();
  await runUpgrade([], {
    ...io,
    uid: 1000,
    env: { SUDO_USER: "anthony" },
    runCmd: async () => ({ code: 0 }),
  });

  assert.doesNotMatch(lines.join("\n"), /don't run moshcode update with sudo/);
});
