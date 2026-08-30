// What `startDaemon` is allowed to call a started bridge.
//
// It used to spawn with `stdio: "ignore"`, write the pidfile from `child.pid`,
// and return `started: true` in the same tick — before the child had done
// anything at all, including exist. On a machine where the daemon dies on
// startup that produced `ok bridge started (pid 22900)` for a process that was
// already gone, and then `enable` installed catch-all routing (`Domains=~.`)
// pointing every lookup on the box at a dead port. The machine lost DNS
// entirely, and the reason was unrecoverable: the daemon wrote it to stderr,
// which had been routed to /dev/null.
//
// Observed on a Kubuntu desktop whose node comes from mise — under the sudo
// that `enable` escalates to, the interpreter was not where the daemon needed
// it. That specific cause matters less than the class: every startup failure
// arrived as the same confident success line.
//
// So the contract is: an early exit is a failed start that carries what the
// daemon said, no pidfile is left behind for a process that is not there, and
// "started" means it answered a query — or says plainly that it has not yet.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonStatus, isAlive, startDaemon } from "../src/dns-system.mjs";
import { dnsCommand } from "../src/dns.mjs";

/** A fake `entry` — startDaemon runs `node <entry> dns start --port N`. */
async function entryScript(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

const scratch = () => mkdtemp(join(tmpdir(), "moshcode-daemon-"));

// Everything here binds an ephemeral port, so nothing collides with a real
// bridge on 5354 or with a parallel run of this file.
const somePort = () => 20000 + Math.floor(Math.random() * 20000);

/** Dies on startup, the way a missing interpreter or a bad install does. */
const DIES = `
process.stderr.write("moshcode: node not on PATH — re-run installer\\n");
process.exit(127);
`;

/** Binds the port it was given and answers anything, i.e. a working bridge. */
const SERVES = `
import dgram from "node:dgram";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const socket = dgram.createSocket("udp4");
socket.on("message", (msg, from) => {
  const reply = Buffer.from(msg);
  reply.writeUInt16BE(0x8183, 2); // a response, NXDOMAIN — any reply proves it serves
  socket.send(reply, from.port, from.address);
});
socket.bind(port, "127.0.0.1");
setTimeout(() => process.exit(0), 15000); // never outlive the test run
`;

/** Alive, but never binds — the "still waking up" case. */
const SILENT = `
setTimeout(() => process.exit(0), 15000);
`;

const reap = (pid) => {
  try {
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    // Already gone, which is the outcome we wanted anyway.
  }
};

/* --------------------------------------------- a daemon that does not survive */

test("a daemon that exits on startup is a failed start, not a started one", async () => {
  const dir = await scratch();
  const path = join(dir, "moshpit-dns.pid");
  const result = await startDaemon({
    port: somePort(),
    entry: await entryScript(dir, "dies.mjs", DIES),
    path,
    readyTimeoutMs: 3000,
  });

  assert.equal(result.started, false, "it did not start; saying otherwise is the bug");
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.pid, null, "there is no pid to report for a process that is gone");
  assert.match(result.error, /exited 127/);
});

test("a failed start hands back what the daemon wrote before it died", async () => {
  const dir = await scratch();
  const result = await startDaemon({
    port: somePort(),
    entry: await entryScript(dir, "dies.mjs", DIES),
    path: join(dir, "moshpit-dns.pid"),
    readyTimeoutMs: 3000,
  });

  // The whole point of the change. Under `stdio: "ignore"` this text existed
  // for a few milliseconds and then nowhere, on any disk, ever.
  assert.match(result.log, /node not on PATH/);
  assert.equal(
    await readFile(result.logPath, "utf8").then((t) => t.includes("node not on PATH")),
    true,
    "and it is still on disk afterwards, for whoever reads the failure later",
  );
});

test("a daemon that died leaves no pidfile claiming it is running", async () => {
  const dir = await scratch();
  const path = join(dir, "moshpit-dns.pid");
  await startDaemon({
    port: somePort(),
    entry: await entryScript(dir, "dies.mjs", DIES),
    path,
    readyTimeoutMs: 3000,
  });

  assert.equal(existsSync(path), false, "a pidfile for a dead process is what makes the next run skip starting one");
  const status = await daemonStatus(path);
  assert.deepEqual(status, { running: false, pid: null, stale: false });
});

test("a spawn that cannot run at all is reported, not thrown", async () => {
  // No `exit` event ever fires for this one — the failure is on the spawn
  // itself, which is why the error listener exists alongside it.
  const dir = await scratch();
  const result = await startDaemon({
    port: somePort(),
    entry: join(dir, "nothing.mjs"),
    path: join(dir, "moshpit-dns.pid"),
    readyTimeoutMs: 3000,
  });
  assert.equal(result.started, false);
  assert.equal(typeof result.error, "string");
});

/* ------------------------------------------------- a daemon that does survive */

test("a bridge that answers is started, verified, and recorded", async () => {
  const dir = await scratch();
  const path = join(dir, "moshpit-dns.pid");
  const result = await startDaemon({
    port: somePort(),
    entry: await entryScript(dir, "serves.mjs", SERVES),
    path,
    readyTimeoutMs: 5000,
  });

  try {
    assert.equal(result.started, true);
    assert.equal(result.verified, true, "it answered a real query on the port — that is what verified means");
    assert.equal(isAlive(result.pid), true);
    assert.equal((await readFile(path, "utf8")).trim(), String(result.pid));
    assert.equal((await daemonStatus(path)).running, true);
  } finally {
    reap(result.pid);
  }
});

test("a bridge that is alive but silent is started and says it is unproven", async () => {
  const dir = await scratch();
  const result = await startDaemon({
    port: somePort(),
    entry: await entryScript(dir, "silent.mjs", SILENT),
    path: join(dir, "moshpit-dns.pid"),
    readyTimeoutMs: 600,
  });

  try {
    // Deliberately not a failure: a slow registry fetch on a slow link looks
    // exactly like this, and killing a bridge that was merely still waking up
    // is the worse of the two mistakes.
    assert.equal(result.started, true);
    assert.equal(result.verified, false);
  } finally {
    reap(result.pid);
  }
});

/* ------------------------------------------------------------------ controls */

/* ------------------------------- what `enable` does with a bridge that failed */

// Same shape as the harness in dns-enable-rollback.test.mjs: the decision is
// what is under test, and none of it should need root or a real resolver.
function noSystem() {
  return {
    tlds: async () => ["eggs", "hacker"],
    safety: async () => ({ safe: true, upstreams: ["1.1.1.1"], why: "no bridge is running yet — this one will be ours" }),
    preflight: async () => ({ ok: true, blockers: [], conflicts: [], holder: null }),
    verify: async () => ({ ok: true, checks: [] }),
    bridgeStatus: async () => ({ running: false, pid: null, stale: false }),
    findLocalProxyImpl: async () => ({ found: false, why: null, address: { v4: null, v6: null } }),
    startBridge: async () => ({ started: true, pid: 1, alreadyRunning: false }),
    stopBridge: async () => ({ stopped: true, reason: null }),
    dropins: async () => [],
    readManifest: async () => null,
    uid: 0,
  };
}

test("enable refuses to route the machine at a bridge that did not start", async () => {
  const dir = await scratch();
  const lines = [];
  let applied = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    manifestFile: join(dir, "dns-restore.json"),
    startBridge: async () => ({
      started: false,
      alreadyRunning: false,
      pid: null,
      error: "exited 127 before it could serve",
      log: "moshcode: node not on PATH — re-run installer",
      logPath: join(dir, "moshpit-dns.log"),
    }),
    applyWith: async () => {
      applied = true;
      return { saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] };
    },
  });
  const out = lines.join("\n");

  assert.equal(code, 1);
  // The routing is catch-all. Writing it against a dead bridge is not a
  // degraded feature, it is the machine's resolver pointed at nothing — which
  // is exactly how a desktop lost DNS entirely and could not look up the fix.
  assert.equal(applied, false, "nothing may be written once the bridge is known to be down");
  assert.match(out, /FAIL bridge did not start on 127\.0\.0\.1:5354 — exited 127/);
  assert.match(out, /node not on PATH/, "the daemon's own words, which used to go to /dev/null");
  assert.match(out, /Refusing to route this machine's DNS at a bridge that is not running/);
  assert.match(out, /Nothing has been changed/);
  // Somewhere to go next that does not require guessing.
  assert.match(out, /moshcode dns start --port 5354/);
});

test("a refused enable does not leave the restore point it recorded", async () => {
  const dir = await scratch();
  const manifestFile = join(dir, "dns-restore.json");
  await dnsCommand(["enable"], () => {}, {
    ...noSystem(),
    manifestFile,
    startBridge: async () => ({ started: false, alreadyRunning: false, pid: null, error: "exited 1 before it could serve", log: "", logPath: null }),
  });
  // It is recorded before the bridge is started, so a refusal has to take it
  // back — a manifest describing a switch that never happened would be replayed
  // by the next `disable` against a machine it does not describe.
  assert.equal(existsSync(manifestFile), false);
});

test("a bridge that answered says so; one that has not is flagged, not refused", async () => {
  const dir = await scratch();
  const answering = [];
  await dnsCommand(["enable"], (l) => answering.push(String(l)), {
    ...noSystem(),
    manifestFile: join(dir, "a.json"),
    startBridge: async () => ({ started: true, pid: 77, alreadyRunning: false, verified: true }),
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
  });
  assert.match(answering.join("\n"), /bridge started on 127\.0\.0\.1:5354 \(pid 77\) — answering/);

  const silent = [];
  const code = await dnsCommand(["enable"], (l) => silent.push(String(l)), {
    ...noSystem(),
    manifestFile: join(dir, "b.json"),
    startBridge: async () => ({ started: true, pid: 78, alreadyRunning: false, verified: false }),
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
  });
  // Alive but unproven is not a failure — a slow registry fetch looks like this.
  assert.equal(code, 0);
  assert.match(silent.join("\n"), /has not answered a query yet/);
});

test("a starter that does not report on verification is not accused of failing it", async () => {
  // `verified` absent means "this starter does not check", which is every
  // injected stub and every reused holder. Rounding that to false would print a
  // warning about bridges that are working fine.
  const dir = await scratch();
  const lines = [];
  await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    manifestFile: join(dir, "c.json"),
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
  });
  assert.doesNotMatch(lines.join("\n"), /has not answered a query yet/);
});

/* ------------------------------------------------------------------ controls */

test("an already-running daemon still short-circuits without spawning", async () => {
  const dir = await scratch();
  const path = join(dir, "moshpit-dns.pid");
  await writeFile(path, `${process.pid}\n`); // alive by definition

  const result = await startDaemon({
    port: somePort(),
    entry: join(dir, "never-run.mjs"),
    path,
    readyTimeoutMs: 3000,
  });
  assert.deepEqual(result, { started: false, pid: process.pid, alreadyRunning: true });
});

/* ----------------------------------------------- alive, but not ours */

// `process.kill(pid, 0)` has two failure modes and they mean opposite things.
// Collapsing them is not academic: `dns enable` escalates, so the bridge it
// starts is root's and every unprivileged `status` afterwards got EPERM,
// called it dead, and advised a fix that starts a second bridge on top of the
// live one. Observed as `moshcode dns status` reporting "stale pidfile for
// 641911" on a Kubuntu desktop whose bridge was running the whole time.

const errno = (code) => Object.assign(new Error(code), { code });

test("EPERM means alive and someone else's, not dead", () => {
  const denied = () => {
    throw errno("EPERM");
  };
  assert.equal(isAlive(4242, denied), true, "a pid we may not signal is still a pid that exists");
});

test("ESRCH is the only failure that means dead", () => {
  const gone = () => {
    throw errno("ESRCH");
  };
  assert.equal(isAlive(4242, gone), false);
});

test("a real process this test cannot signal reads as alive", () => {
  // pid 1 always exists and, unprivileged, cannot be signalled — the exact
  // shape of a root-owned bridge. Running as root it simply succeeds, so this
  // holds either way rather than depending on who runs the suite.
  assert.equal(isAlive(1), true);
});

test("a pidfile naming another user's live process is running, not stale", async () => {
  const dir = await scratch();
  const path = join(dir, "moshpit-dns.pid");
  await writeFile(path, "1\n");

  // The whole bug in one assertion: `stale: true` here is what sent people to
  // `dns enable` and took their resolver down.
  assert.deepEqual(await daemonStatus(path), { running: true, pid: 1, stale: false });
});
