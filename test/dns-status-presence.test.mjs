// What `dns status` says is running, and why the pidfile is not allowed to be
// the only witness.
//
// The bug these cover is one machine: a bridge answering happily on
// 0.0.0.0:5354, started by a systemd unit, with `moshcode dns status` reporting
// `bridge  not running` and advising `sudo moshcode dns enable`. Following that
// advice starts a second bridge bound to 127.0.0.1:5354; the kernel prefers the
// more specific socket, the working bridge stops receiving anything, and the
// machine loses DNS entirely. The status line was wrong, and the remedy it
// named was the outage.
//
// So the port is asked. Every probe here is injected — none of this should need
// root, a real socket, or a machine whose resolver is a real thing to break.
import test from "node:test";
import assert from "node:assert/strict";

import { bridgePresence, describeBridge, dnsCommand } from "../src/dns.mjs";
import { pidfilePath } from "../src/dns-system.mjs";

const NO_PIDFILE = { running: false, pid: null, stale: false };
const listeners = (rows) => async () => rows;

/* ------------------------------------------------------------- presence ---*/

test("a bridge answering on the port is running, even with no pidfile of ours", async () => {
  // The reported machine. `enable` escalated, wrote its pidfile into root's
  // home, and every unprivileged run since has been unable to see it.
  const presence = await bridgePresence({
    recorded: NO_PIDFILE,
    answers: async () => true,
    forwards: async () => true,
    listeners: listeners([{ address: "0.0.0.0", port: 5354, pid: 1330, process: "bun" }]),
  });
  assert.equal(presence.kind, "foreign");
  assert.equal(presence.answering, true);
  assert.equal(presence.pid, 1330);
  assert.match(describeBridge(presence), /answering on 127\.0\.0\.1:5354 \(pid 1330, bun\)/);
});

test("nothing on the port with no pidfile is the only real 'not running'", async () => {
  const presence = await bridgePresence({
    recorded: NO_PIDFILE,
    answers: async () => false,
    forwards: async () => false,
    listeners: listeners([]),
  });
  assert.equal(presence.kind, "none");
  assert.equal(presence.answering, false);
  assert.equal(describeBridge(presence), "not running");
});

test("a stale pidfile stays stale only while nothing answers", async () => {
  const dead = await bridgePresence({
    recorded: { running: false, pid: 999, stale: true },
    answers: async () => false,
    forwards: async () => false,
    listeners: listeners([]),
  });
  assert.equal(dead.kind, "stale");
  assert.match(describeBridge(dead), /stale pidfile for 999/);

  // Same stale file, but something is serving — that is a bridge, and calling
  // it stale is how the shadowing advice got printed in the first place.
  const alive = await bridgePresence({
    recorded: { running: false, pid: 999, stale: true },
    answers: async () => true,
    forwards: async () => true,
    listeners: listeners([{ address: "0.0.0.0", port: 5354, pid: 42, process: "bun" }]),
  });
  assert.equal(alive.kind, "foreign");
  assert.equal(alive.pid, 42);
});

test("our own recorded bridge is reported as ours, and checked anyway", async () => {
  const healthy = await bridgePresence({
    recorded: { running: true, pid: 77, stale: false },
    answers: async () => true,
    forwards: async () => true,
    listeners: listeners([]),
  });
  assert.equal(healthy.kind, "ours");
  assert.equal(describeBridge(healthy), "running (pid 77)");

  // Alive by pid and deaf on the port. Reporting a bare "running (pid 77)" here
  // is the failure this whole file exists to stop being silent.
  const deaf = await bridgePresence({
    recorded: { running: true, pid: 77, stale: false },
    answers: async () => false,
    forwards: async () => false,
    listeners: listeners([]),
  });
  assert.equal(deaf.kind, "ours");
  assert.equal(deaf.answering, false);
  assert.match(describeBridge(deaf), /not answering on 127\.0\.0\.1:5354/);
});

test("a holder whose owner is not visible is still a bridge", async () => {
  // `ss` only shows the process column for sockets the caller owns, so an
  // unprivileged status on someone else's bridge sees the port and no pid.
  const presence = await bridgePresence({
    recorded: NO_PIDFILE,
    answers: async () => true,
    forwards: async () => true,
    listeners: listeners([{ address: "0.0.0.0", port: 5354, pid: null, process: null }]),
  });
  assert.equal(presence.kind, "foreign");
  assert.equal(presence.pid, null);
  assert.match(describeBridge(presence), /owner not visible/);
});

test("answering Moshpit names without forwarding is still answering", async () => {
  const presence = await bridgePresence({
    recorded: NO_PIDFILE,
    answers: async () => true,
    forwards: async () => false,
    listeners: listeners([{ address: "127.0.0.1", port: 5354, pid: 5, process: "node" }]),
  });
  assert.equal(presence.answering, true);
  assert.equal(presence.forwards, false);
});

test("a probe that throws is a probe that said no, not a crash", async () => {
  const presence = await bridgePresence({
    recorded: NO_PIDFILE,
    answers: async () => { throw new Error("EPERM"); },
    forwards: async () => { throw new Error("EPERM"); },
    listeners: async () => { throw new Error("no ss"); },
  });
  assert.equal(presence.kind, "none");
});

/* --------------------------------------------------------- the status line */

// `routed` is stated rather than inherited. Left to read the real filesystem,
// these tests passed on a machine with Moshpit enabled and failed on a clean
// runner — the assertions are about what status says once routing is in place,
// so that has to be an input.
const statusRun = async (presence, { routed = true } = {}) => {
  const lines = [];
  const code = await dnsCommand(["status"], (l) => lines.push(String(l)), {
    bridgeStatus: async () => NO_PIDFILE,
    presenceImpl: async () => presence,
    exists: () => routed,
    // Unreachable on purpose: the registry half of `status` is not what these
    // assert, and letting it reach the network made each one a 3s test.
    tlds: async () => { throw new Error("registry unreachable"); },
  });
  return { code, out: lines.join("\n") };
};

test("status does not advise starting a bridge on top of a working one", async () => {
  const { out } = await statusRun({
    kind: "foreign", pid: 1330, process: "bun", answering: true, forwards: true, moshpit: true,
  });
  assert.match(out, /answering on 127\.0\.0\.1:5354 \(pid 1330, bun\)/);
  // Routing really is in place — this is the exact machine that used to be told
  // its bridge was missing, so the alarm's absence has to be meaningful.
  assert.match(out, /routing {4}configured/);
  assert.doesNotMatch(out, /the bridge is not running/);
  assert.doesNotMatch(out, /Moshpit names will fail/);
});

test("an unrouted machine with no bridge is not an emergency", async () => {
  const { out } = await statusRun(
    { kind: "none", pid: null, answering: false, forwards: false, moshpit: false },
    { routed: false },
  );
  assert.match(out, /routing {4}not configured/);
  assert.doesNotMatch(out, /will fail/);
});

test("status still shouts when routing points at nothing at all", async () => {
  const { out } = await statusRun({
    kind: "none", pid: null, answering: false, forwards: false, moshpit: false,
  });
  assert.match(out, /nothing answers on 127\.0\.0\.1:5354 — Moshpit names will fail/);
  // The remedy never carries `sudo`: the CLI escalates the one step that needs
  // it, and `sudo moshcode …` is what reinstalls the tool into /root elsewhere.
  assert.match(out, /fix with: moshcode dns enable/);
  assert.doesNotMatch(out, /sudo moshcode/);
});

test("a bridge that answers but does not forward is named as such", async () => {
  const { out } = await statusRun({
    kind: "foreign", pid: 7, process: "node", answering: true, forwards: false, moshpit: true,
  });
  assert.match(out, /answers Moshpit names but is not forwarding/);
  assert.doesNotMatch(out, /Moshpit names will fail/);
});

/* ------------------------------------------------------------- pidfile ----*/

test("an escalated run records the bridge where the invoking user can find it", () => {
  // The root cause of "not running": under sudo, XDG_RUNTIME_DIR and HOME are
  // root's, so `enable` wrote /root/.moshcode/moshpit-dns.pid and no later
  // unprivileged run could read it — or even reach the directory.
  const asRoot = pidfilePath(
    { SUDO_UID: "1000", XDG_RUNTIME_DIR: "/run/user/0", HOME: "/root" },
    (p) => p === "/run/user/1000",
  );
  assert.equal(asRoot, "/run/user/1000/moshpit-dns.pid");

  // Which is the same path the unprivileged status resolves on its own.
  const asUser = pidfilePath({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => true);
  assert.equal(asUser, "/run/user/1000/moshpit-dns.pid");
});

test("a derived runtime dir that does not exist is not used", () => {
  // macOS under sudo, and any machine without /run/user. Swapping an unreadable
  // path for a nonexistent one fixes nothing and breaks the daemon's own write.
  const path = pidfilePath(
    { SUDO_UID: "501", XDG_RUNTIME_DIR: "/run/user/0" },
    () => false,
  );
  assert.equal(path, "/run/user/0/moshpit-dns.pid");
});

test("an ordinary unprivileged run is unchanged", () => {
  assert.equal(
    pidfilePath({ XDG_RUNTIME_DIR: "/run/user/1001" }, () => true),
    "/run/user/1001/moshpit-dns.pid",
  );
});
