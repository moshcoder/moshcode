// Asking for the password up front.
//
// Some installers escalate on their own partway through their own work —
// tailscale's goes through the distro package manager, so it calls sudo after
// refreshing package lists. Inside `moshcode update`, which walks a plan of
// moshcode + every engine + every tool, that prompt lands somewhere in the
// middle of a long unattended stream and parks the whole run.
//
// What these pin is the ordering the operator experiences: one prompt before any
// work, and silence when there is nothing to ask for. Every input is injected,
// because none of these cases — no tty, no sudo, a cancelled prompt, being root
// — can be produced from inside a test process.
import assert from "node:assert/strict";
import test from "node:test";

import { needsRootHere, primeEscalation } from "../src/escalate.mjs";
import { TOOLS } from "../src/tools.mjs";

const has = (...names) => (tool) => names.includes(tool);
const collect = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(String(s)) };
};

// The stub answers two different questions — "is a credential already cached"
// (`-n true`) and "prompt now" — so it branches on the args rather than
// counting calls, which would break the moment an implementation detail moved.
function fakeSudo({ cached = false, status = 0, error = null } = {}) {
  const calls = [];
  const spawn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    if (argv[0] === "-n") return { status: cached ? 0 : 1 };
    return error ? { error } : { status };
  };
  return { calls, spawn };
}

test("a spec with no needsRoot never triggers a prompt", () => {
  assert.equal(needsRootHere({}, "linux"), false);
  assert.equal(needsRootHere(undefined, "linux"), false);
  assert.equal(needsRootHere(TOOLS.gh, "linux"), false);
});

test("needsRoot: true means every platform", () => {
  assert.equal(needsRootHere({ needsRoot: true }, "linux"), true);
  assert.equal(needsRootHere({ needsRoot: true }, "darwin"), true);
});

test("an except list spares the platform that does not escalate", () => {
  // tailscale's script uses the distro package manager on Linux and delegates to
  // the App Store on macOS, where nothing asks for a password. Prompting there
  // would be a password request for a step that never escalates.
  assert.equal(needsRootHere(TOOLS.tailscale, "linux"), true);
  assert.equal(needsRootHere(TOOLS.tailscale, "darwin"), false);
});

test("Spinifex escalates everywhere it can run", () => {
  // Unlike tailscale there is no platform that gets a pass: the installer writes
  // systemd units, sudoers rules, and /usr/local/bin on the only OSes it
  // supports, and it has no macOS build to delegate to.
  assert.equal(needsRootHere(TOOLS.spinifex, "linux"), true);
  assert.equal(needsRootHere(TOOLS.spinifex, "darwin"), true);
});

test("an explicit platform list is the other direction", () => {
  assert.equal(needsRootHere({ needsRoot: ["linux"] }, "linux"), true);
  assert.equal(needsRootHere({ needsRoot: ["linux"] }, "win32"), false);
});

test("prompts once, before the work, with sudo's validate-only flag", () => {
  const { calls, spawn } = fakeSudo();
  const { lines, out } = collect();

  const result = primeEscalation({
    what: "tailscale", env: {}, isTTY: true, probe: has("sudo"), spawn, out, getuid: () => 1000,
  });

  assert.deepEqual(result, { primed: true, tool: "sudo", reason: "prompted" });
  // `-v` refreshes the timestamp and runs nothing, which is what makes this safe
  // to do before an install that might turn out not to need root at all.
  assert.deepEqual(calls.map((c) => c.argv), [["-n", "true"], ["-v"]]);
  // The prompt needs the terminal or there is nowhere to type.
  assert.equal(calls[1].opts.stdio, "inherit");
  assert.match(lines.join("\n"), /tailscale needs root partway through/);
});

test("doas gets a real command, because it has no -v", () => {
  const { calls, spawn } = fakeSudo();
  const result = primeEscalation({
    what: "tailscale", env: {}, isTTY: true, probe: has("doas"), spawn, out: () => {}, getuid: () => 1000,
  });

  assert.equal(result.tool, "doas");
  assert.deepEqual(calls.map((c) => c.argv), [["-n", "true"], ["true"]]);
});

test("says nothing when a credential is already cached", () => {
  const { calls, spawn } = fakeSudo({ cached: true });
  const { lines, out } = collect();

  const result = primeEscalation({
    what: "tailscale", env: {}, isTTY: true, probe: has("sudo"), spawn, out, getuid: () => 1000,
  });

  assert.deepEqual(result, { primed: true, tool: "sudo", reason: "cached" });
  // Announcing a password prompt and then not showing one reads as a bug. This
  // is also the NOPASSWD case.
  assert.deepEqual(lines, []);
  assert.equal(calls.length, 1);
});

test("root has nothing to ask for", () => {
  const result = primeEscalation({
    env: {}, isTTY: true, probe: has("sudo"),
    spawn: () => assert.fail("must not shell out when already root"),
    out: () => assert.fail("must not print"),
    getuid: () => 0,
  });

  assert.deepEqual(result, { primed: true, tool: null, reason: "already-root" });
});

test("no tty means no prompt — a CI job must not stall on one", () => {
  const result = primeEscalation({
    env: {}, isTTY: false, probe: has("sudo"),
    spawn: () => assert.fail("must not prompt without a terminal"),
    out: () => {}, getuid: () => 1000,
  });

  assert.deepEqual(result, { primed: false, tool: null, reason: "no-tty" });
});

test("no escalator on the box is not an error", () => {
  const result = primeEscalation({
    env: {}, isTTY: true, probe: has(),
    spawn: () => assert.fail("nothing to spawn"),
    out: () => {}, getuid: () => 1000,
  });

  assert.deepEqual(result, { primed: false, tool: null, reason: "no-escalator" });
});

test("MOSHCODE_ESCALATOR is honoured here too", () => {
  const { calls, spawn } = fakeSudo();
  const result = primeEscalation({
    what: "tailscale", env: { MOSHCODE_ESCALATOR: "doas" }, isTTY: true,
    probe: has("sudo", "doas"), spawn, out: () => {}, getuid: () => 1000,
  });

  assert.equal(result.tool, "doas");
  assert.equal(calls[0].cmd, "doas");
});

test("a cancelled or refused prompt carries on unprimed rather than failing the install", () => {
  const { spawn } = fakeSudo({ status: 1 });
  const result = primeEscalation({
    what: "tailscale", env: {}, isTTY: true, probe: has("sudo"), spawn, out: () => {}, getuid: () => 1000,
  });

  // A wrong password, a cancelled prompt, and an operator who is not in sudoers
  // all land here. The installer may not need root on this machine, so refusing
  // must not decide that on its behalf.
  assert.deepEqual(result, { primed: false, tool: "sudo", reason: "declined" });
});

test("a failed spawn degrades instead of throwing", () => {
  const { spawn } = fakeSudo({ error: new Error("ENOENT") });
  const result = primeEscalation({
    what: "tailscale", env: {}, isTTY: true, probe: has("sudo"), spawn, out: () => {}, getuid: () => 1000,
  });

  assert.deepEqual(result, { primed: false, tool: "sudo", reason: "spawn-failed" });
});
