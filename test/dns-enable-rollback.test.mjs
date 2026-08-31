// `dns enable` switching a machine's DNS, and putting it back when it should not have.
//
// Every test here is a machine that ended up unable to resolve anything. The
// two preflight ones are states that were misdiagnosed as bridge bugs for a
// whole afternoon each; the rollback ones are the difference between a failed
// command and a desktop with no resolver and no way to look up the fix.
//
// The system calls are injected, not exercised: what is under test is the
// decision — refuse, apply, verify, restore — and none of it should need root,
// a resolver, or a real port to check.
import test from "node:test";
import assert from "node:assert/strict";

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyWithRollback, backupPath, conflictingDropins, dnsCommand, dropinNameservers,
  parseUdpListeners, portHolder, preflightEnable, verifyResolution,
} from "../src/dns.mjs";

/* ------------------------------------------------------------- preflight ---*/

test("a second drop-in setting DNS= is a conflict, an empty DNS= is not", () => {
  // `DNS=` with no value is systemd's reset, not another server. Reading it as
  // a conflict would refuse to enable on a machine that is deliberately clean.
  const found = conflictingDropins([
    { name: "moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" },
    { name: "DigitalOcean.conf", content: "[Resolve]\nDNS=67.207.67.2 67.207.67.3\n" },
    { name: "reset.conf", content: "[Resolve]\nDNS=\n" },
    { name: "commented.conf", content: "[Resolve]\n#DNS=1.1.1.1\n" },
    { name: "notes.txt", content: "DNS=8.8.8.8\n" },
  ]);
  assert.deepEqual(found.map((f) => f.name), ["DigitalOcean.conf"]);
  assert.deepEqual(found[0].servers, ["67.207.67.2", "67.207.67.3"]);
});

test("a drop-in already pointing at this bridge is a duplicate, not a competing server", async () => {
  // Real, and common: an earlier installer left 00-moshpit.conf naming the same
  // 127.0.0.1:5354. There is no second server for the resolver to rotate to, so
  // refusing would mean refusing on every machine that installer touched.
  const result = await preflightEnable({
    dropins: async () => [{ name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" }],
    listeners: async () => [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  // It still outlives `dns disable`, which removes moshpit.conf and nothing else.
  assert.deepEqual(result.duplicates.map((d) => d.name), ["00-moshpit.conf"]);
});

test("DNS= is read case- and whitespace-insensitively, the way systemd reads it", () => {
  assert.deepEqual(dropinNameservers("[Resolve]\n  dns = 9.9.9.9  \n"), ["9.9.9.9"]);
  assert.deepEqual(dropinNameservers("[Resolve]\nDNSSEC=no\n"), [], "DNSSEC= is not DNS=");
});

test("a conflicting drop-in stops the run before anything is written", async () => {
  const lines = [];
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    preflight: (o) => preflightEnable({
      ...o,
      dropins: async () => [{ name: "DigitalOcean.conf", content: "[Resolve]\nDNS=67.207.67.2\n" }],
      listeners: async () => [],
    }),
  });
  const out = lines.join("\n");
  assert.equal(code, 1);
  assert.match(out, /DigitalOcean\.conf also sets DNS=/);
  assert.match(out, /Nothing has been changed/);
  // The reason it refuses rather than picking a winner: the other server
  // answers NXDOMAIN for every Moshpit name, so nothing ever looks broken.
  assert.match(out, /rotates back/);
});

test("a stale listener on the bridge's port stops the run, and names the pid", async () => {
  const lines = [];
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    preflight: (o) => preflightEnable({
      ...o,
      dropins: async () => [],
      listeners: async () => [{ address: "127.0.0.1", port: 5354, pid: 4242, process: "node" }],
      // The signature of the thing: it holds the port and swallows the query.
      forwards: async () => false,
    }),
  });
  assert.equal(code, 1);
  const out = lines.join("\n");
  assert.match(out, /already listening on 127\.0\.0\.1:5354 and does not forward — pid 4242 \(node\)/);
  assert.match(out, /kill 4242/);
});

test("the bridge this run already owns is not a stale listener", async () => {
  // Re-running enable on a working machine must not refuse because its own
  // bridge is up. The pid from the pidfile is what tells them apart.
  const ours = await preflightEnable({
    ourPid: 4242,
    dropins: async () => [],
    listeners: async () => [{ address: "127.0.0.1", port: 5354, pid: 4242, process: "node" }],
    forwards: async () => false,
  });
  assert.equal(ours.ok, true);
});

test("a holder that forwards is used, not refused — or --force becomes the normal way to run this", async () => {
  // A bridge started by hand holds the port with no pidfile to prove it is
  // ours, and works perfectly. Blocking on identity rather than on behaviour
  // would train everyone to pass --force, which is how a safety check stops
  // being one. Behaviour is the test: it answers a clearnet name.
  const lines = [];
  let startedOurs = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    preflight: (o) => preflightEnable({
      ...o,
      dropins: async () => [],
      listeners: async () => [{ address: "0.0.0.0", port: 5354, pid: 2471795, process: "bun" }],
      forwards: async () => true,
    }),
    startBridge: async () => { startedOurs = true; return { started: true, pid: 1, alreadyRunning: false }; },
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
  });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /held by pid 2471795, which this run did not start — it forwards/);
  // "Used as-is" has to mean it. This assertion is the one this test was missing
  // while it was named for it: the note printed, and then a second daemon was
  // started anyway. `startDaemon` reads our pidfile to decide "already running",
  // so it cannot see the holder; both bind, because the socket sets reuseAddr,
  // and the kernel gives the query to the more specific bind. On the machine
  // that found this, ours took 127.0.0.1 while the holder had 0.0.0.0 — so the
  // bridge the note promised would serve was the one getting nothing.
  assert.equal(startedOurs, false, "the holder is used as-is, so there is nothing to start");
  assert.match(out, /using the bridge already on 127\.0\.0\.1:5354 \(pid 2471795\)/);
  assert.doesNotMatch(out, /bridge started on/);
});

test("a holder that does not forward is still not reused — --force starts ours over it", async () => {
  // The other half of the gate. A holder that fails the clearnet question is the
  // stale-bridge case, and forcing past it means deliberately putting a working
  // bridge in front of it — so the start still has to happen.
  const lines = [];
  let startedOurs = false;
  const code = await dnsCommand(["enable", "--force"], (l) => lines.push(String(l)), {
    ...noSystem(),
    preflight: (o) => preflightEnable({
      ...o,
      dropins: async () => [],
      listeners: async () => [{ address: "127.0.0.1", port: 5354, pid: 4242, process: "node" }],
      forwards: async () => false,
    }),
    startBridge: async () => { startedOurs = true; return { started: true, pid: 7, alreadyRunning: false }; },
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
  });
  assert.equal(code, 0);
  assert.equal(startedOurs, true);
  assert.match(lines.join("\n"), /bridge started on 127\.0\.0\.1:5354 \(pid 7\)/);
});

test("a wildcard bind is caught too — it is the same query, taken by the same stranger", () => {
  // 0.0.0.0:5354 and 127.0.0.1:5354 are both reachable at the address the
  // routing names. Which one wins depends only on which side bound first and
  // how specifically, so neither is a state to write catch-all routing into.
  const holder = portHolder([{ address: "0.0.0.0", port: 5354, pid: 99, process: "dnsmasq" }], { ourPid: null });
  assert.equal(holder?.pid, 99);
  assert.equal(portHolder([{ address: "127.0.0.1", port: 53, pid: 99 }], {}), null, "another port is not ours to police");
});

test("an unattributable listener is only forgiven when a bridge of ours is running", () => {
  // `ss` hides owners the caller cannot see. With one of ours recorded as
  // running, the unowned socket is almost certainly it; with nothing of ours
  // running there is no reading under which it is ours.
  const anonymous = [{ address: "127.0.0.1", port: 5354, pid: null, process: null }];
  assert.equal(portHolder(anonymous, { ourPid: 77 }), null);
  assert.notEqual(portHolder(anonymous, { ourPid: null }), null);
});

test("ss output is parsed for the owner, not just grepped for the port", () => {
  const listeners = parseUdpListeners([
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    'UNCONN 0      0        127.0.0.1:5354       0.0.0.0:*     users:(("node",pid=1234,fd=20))',
    "UNCONN 0      0            [::1]:5354          [::]:*     ",
  ].join("\n"));
  assert.deepEqual(listeners[0], { address: "127.0.0.1", port: 5354, pid: 1234, process: "node" });
  assert.deepEqual(listeners[1], { address: "::1", port: 5354, pid: null, process: null });
});

test("--force proceeds past both blockers", async () => {
  const lines = [];
  let applied = false;
  const code = await dnsCommand(["enable", "--force"], (l) => lines.push(String(l)), {
    ...noSystem(),
    preflight: (o) => preflightEnable({
      ...o,
      dropins: async () => [{ name: "DigitalOcean.conf", content: "[Resolve]\nDNS=67.207.67.2\n" }],
      listeners: async () => [{ address: "127.0.0.1", port: 5354, pid: 4242, process: "node" }],
      forwards: async () => false,
    }),
    applyWith: async () => {
      applied = true;
      return { saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] };
    },
  });
  assert.equal(code, 0);
  assert.equal(applied, true, "--force has to actually get to the apply");
  const out = lines.join("\n");
  assert.match(out, /BLOCKED/, "forcing does not mean hiding what was found");
  assert.match(out, /--force: proceeding anyway/);
});

/* ---------------------------------------------------------------- verify ---*/

test("both names must answer, and an empty answer is not an answer", async () => {
  // NOERROR with zero records is exactly what a resolver that has swallowed the
  // query returns. Counting it as success is how the silent outage stayed silent.
  const empty = await verifyResolution({ moshpit: "a.eggs", attempts: 1, resolve: async () => [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.checks[0].error, "answered, with no records");

  const clearnetDown = await verifyResolution({
    moshpit: "a.eggs",
    attempts: 1,
    resolve: async (name) => (name === "a.eggs" ? ["1.2.3.4"] : Promise.reject(new Error("ENOTFOUND"))),
  });
  assert.equal(clearnetDown.ok, false, "Moshpit names resolving is not proof the machine has DNS");
  assert.deepEqual(clearnetDown.checks.filter((c) => !c.ok).map((c) => c.kind), ["clearnet"]);
});

test("verification is retried, because systemd-resolved is not ready the instant it restarts", async () => {
  let calls = 0;
  const result = await verifyResolution({
    attempts: 3,
    sleep: async () => {},
    resolve: async () => (++calls < 3 ? Promise.reject(new Error("ECONNREFUSED")) : ["1.2.3.4"]),
  });
  assert.equal(result.ok, true, "a rollback over a startup race would undo a switch that was fine");
});

/* -------------------------------------------------------------- rollback ---*/

function sandbox() {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "moshcode-dns-"));
  const conf = path.join(dir, "moshpit.conf");
  const runs = [];
  const plan = {
    platform: "linux",
    elevated: true,
    steps: [
      { kind: "write", path: conf, content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n", why: "route everything at the bridge" },
      { kind: "run", command: "systemctl", args: ["restart", "systemd-resolved"], why: "drop-ins are read at start" },
    ],
    notes: [],
  };
  return { dir, conf, plan, runs, runner: async (command, args) => { runs.push(`${command} ${args.join(" ")}`); } };
}

test("a failed verification restores the drop-in that was there before", async () => {
  const { dir, conf, plan, runs, runner } = sandbox();
  const previous = "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~eggs ~hacker\n";
  fsSync.writeFileSync(conf, previous);

  const outcome = await applyWithRollback(plan, {
    runner,
    verify: async () => ({ ok: false, checks: [{ name: "pit.moshcode.sh", kind: "clearnet", ok: false, error: "ENOTFOUND" }] }),
  });

  assert.equal(outcome.rolledBack.ok, true);
  assert.equal(fsSync.readFileSync(conf, "utf8"), previous, "byte-for-byte, not a regenerated equivalent");
  // Restoring the file is not enough: the resolver read it at start.
  assert.deepEqual(runs, ["systemctl restart systemd-resolved", "systemctl restart systemd-resolved"]);
  assert.equal(fsSync.existsSync(backupPath(conf)), false, "the original is back, so the copy is litter");
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test("a machine with no drop-in gets the file removed, not left empty", async () => {
  // The state that made this worth writing: an empty or leftover moshpit.conf
  // is a file systemd-resolved still reads, and `dns status` still reports as
  // routing configured. "Back as it was" has to mean the file is gone.
  const { dir, conf, plan, runner } = sandbox();
  const outcome = await applyWithRollback(plan, { runner, verify: async () => ({ ok: false, checks: [] }) });

  assert.equal(outcome.rolledBack.ok, true);
  assert.equal(fsSync.existsSync(conf), false);
  assert.equal(fsSync.existsSync(backupPath(conf)), false, "nothing existed to back up");
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test("a routing step that fails rolls back too, rather than leaving it half applied", async () => {
  const { dir, conf, plan, runner, runs } = sandbox();
  fsSync.writeFileSync(conf, "[Resolve]\nDNS=127.0.0.1:5354\n");
  // The restart is what fails here — config on disk, resolver still running the
  // old one. Previously this printed "some steps failed" and stopped there.
  let first = true;
  const flaky = async (command, args) => {
    if (first) { first = false; throw new Error("Failed to restart systemd-resolved.service"); }
    return runner(command, args);
  };

  const outcome = await applyWithRollback(plan, {
    runner: flaky,
    verify: async () => { throw new Error("verification must not run against a half-applied plan"); },
  });

  assert.equal(outcome.applied.ok, false);
  assert.match(outcome.verified.skipped, /not attempted/);
  assert.equal(fsSync.readFileSync(conf, "utf8"), "[Resolve]\nDNS=127.0.0.1:5354\n");
  assert.deepEqual(runs, ["systemctl restart systemd-resolved"], "the rollback restart still ran");
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test("a run that verifies keeps its config and drops the backup", async () => {
  const { dir, conf, plan, runner } = sandbox();
  fsSync.writeFileSync(conf, "old\n");
  const outcome = await applyWithRollback(plan, { runner, verify: async () => ({ ok: true, checks: [] }) });

  assert.equal(outcome.rolledBack, null);
  assert.match(fsSync.readFileSync(conf, "utf8"), /Domains=~\./);
  // A leftover *.conf-adjacent file in a config directory is the hazard the
  // preflight exists for, so success cleans up after itself.
  assert.equal(fsSync.existsSync(backupPath(conf)), false);
  fsSync.rmSync(dir, { recursive: true, force: true });
});

test("the backup is not named .conf, or it would become the conflict itself", () => {
  assert.doesNotMatch(backupPath("/etc/systemd/resolved.conf.d/moshpit.conf"), /\.conf$/);
});

test("a rollback that fails says where the previous config is", async () => {
  const { dir, conf, plan } = sandbox();
  fsSync.writeFileSync(conf, "previous\n");
  const outcome = await applyWithRollback(plan, {
    runner: async () => {},
    verify: async () => ({ ok: false, checks: [] }),
    // Restores fail; the machine is now in the state where the on-disk copy is
    // the only record of what it used to look like.
    apply: async (p, opts) => {
      const { applyPlan } = await import("../src/dns-system.mjs");
      const restoring = p.steps.some((s) => s.why?.includes("before this run"));
      return restoring
        ? { ok: false, results: p.steps.map((step) => ({ step, ok: false, error: "EROFS" })) }
        : applyPlan(p, opts);
    },
  });
  assert.equal(outcome.rolledBack.ok, false);
  assert.deepEqual(outcome.backups, [backupPath(conf)]);
  assert.equal(fsSync.readFileSync(backupPath(conf), "utf8"), "previous\n");
  fsSync.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------- the restore point */

test("enable records what the machine looked like before it changes it", async () => {
  const file = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), "moshcode-manifest-")), "restore.json");
  let existedAtApply = false;
  const code = await dnsCommand(["enable"], () => {}, {
    ...noSystem(),
    manifestFile: file,
    dropins: async () => [{ name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\n" }],
    applyWith: async () => {
      // Written *before* the routing moves, so a run killed halfway still
      // leaves the one thing needed to undo it.
      existedAtApply = fsSync.existsSync(file);
      return { saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] };
    },
  });
  assert.equal(code, 0);
  assert.equal(existedAtApply, true);

  const manifest = JSON.parse(fsSync.readFileSync(file, "utf8"));
  assert.equal(manifest.version, 1, "versioned, so a build that does not understand it falls back to detection");
  const paths = manifest.files.map((f) => f.path);
  assert.ok(paths.includes("/etc/systemd/resolved.conf.d/00-moshpit.conf"), "the foreign file is the one disable cannot deduce");
  assert.ok(paths.includes("/etc/systemd/resolved.conf.d/moshpit.conf"));
  fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("a rolled-back enable takes its restore point with it", async () => {
  // A manifest that outlives the run it describes is a loaded gun: the next
  // `disable` would replay it against a machine it no longer describes.
  const file = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), "moshcode-manifest-")), "restore.json");
  const code = await dnsCommand(["enable"], () => {}, {
    ...noSystem(),
    manifestFile: file,
    applyWith: async () => ({
      saved: { ok: true },
      applied: { ok: true, results: [] },
      verified: { ok: false, checks: [{ name: "pit.moshcode.sh", kind: "clearnet", ok: false, error: "ENOTFOUND" }] },
      rolledBack: { ok: true, results: [] },
      backups: [],
    }),
  });
  assert.equal(code, 1);
  assert.equal(fsSync.existsSync(file), false);
  fsSync.rmSync(path.dirname(file), { recursive: true, force: true });
});

/* --------------------------------------------------------------- dry run ---*/

test("--dry-run writes nothing, restarts nothing, verifies nothing, rolls back nothing", async () => {
  const lines = [];
  const boom = (what) => async () => { throw new Error(`--dry-run reached ${what}`); };
  const code = await dnsCommand(["enable", "--dry-run"], (l) => lines.push(String(l)), {
    ...noSystem(),
    applyWith: boom("apply"),
    verify: boom("verify"),
    startBridge: boom("the bridge"),
    stopBridge: boom("stop"),
  });
  assert.equal(code, 0);

  // All four phases, because deciding whether to hand this command root means
  // seeing the part that undoes it as well as the part that does it.
  const out = lines.join("\n");
  assert.match(out, /preflight  clear/);
  assert.match(out, /write   \/etc\/systemd\/resolved\.conf\.d\/moshpit\.conf/);
  // Not decoration: without it the per-link servers DHCP hands out carry
  // Default Route: yes, beat the global scope, and every query goes around the
  // bridge. `resolvectl query seo.rank` reporting `link: eth1` is what that
  // looks like on a box where the config is otherwise perfect.
  assert.match(out, /^ +Domains=~\.$/m);
  assert.match(out, /^verify /m);
  assert.match(out, /a\.eggs .*the bridge is reachable/);
  assert.match(out, /pit\.moshcode\.sh .*forwards rather than swallows/);
  assert.match(out, /^rollback  \(only if verify fails\)/m);
  assert.match(out, /restore \/etc\/systemd\/resolved\.conf\.d\/moshpit\.conf, or remove it/);
});

test("--dry-run still reports a preflight that would refuse", async () => {
  const lines = [];
  const code = await dnsCommand(["enable", "--dry-run"], (l) => lines.push(String(l)), {
    ...noSystem(),
    preflight: (o) => preflightEnable({
      ...o,
      dropins: async () => [{ name: "DigitalOcean.conf", content: "[Resolve]\nDNS=67.207.67.2\n" }],
      listeners: async () => [],
    }),
    applyWith: async () => { throw new Error("--dry-run applied a plan"); },
  });
  // Describing is the whole job of a dry run — including describing the refusal
  // someone is running it to understand.
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /BLOCKED[\s\S]*DigitalOcean\.conf/);
});

/* ------------------------------------------------------------------------- */

/** Every system call `enable` makes, stubbed to a machine where nothing is wrong. */
function noSystem() {
  return {
    // The enable tree consults host drop-ins only on linux +
    // systemd-resolved; pinning the platform keeps those paths testable from
    // any OS the suite runs on.
    platform: () => "linux",
    tlds: async () => ["eggs", "hacker"],
    safety: async () => ({ safe: true, upstreams: ["1.1.1.1"], why: "no bridge is running yet — this one will be ours" }),
    preflight: async () => ({ ok: true, blockers: [], conflicts: [], holder: null }),
    verify: async () => ({ ok: true, checks: [] }),
    bridgeStatus: async () => ({ running: false, pid: null, stale: false }),
    // No proxy, which is the state these tests were written in. Stubbed rather
    // than left to the real probe, which would open a TLS connection to
    // whatever holds 443 on the machine running the suite.
    findLocalProxyImpl: async () => ({ found: false, why: null, address: { v4: null, v6: null } }),
    startBridge: async () => ({ started: true, pid: 1, alreadyRunning: false }),
    // No systemd unit on this machine, which is the state these tests were
    // written in. Stubbed rather than left to the real one, which would read
    // the suite runner's own ~/.config/systemd/user and, on a developer's box,
    // restart their actual bridge.
    refreshBridge: async () => ({ refreshed: false, reason: "no unit installed", upstreams: [], steps: [] }),
    stopSupervised: async () => ({ stopped: false, reason: "no unit installed", steps: [] }),
    // Both of these reach the real machine when left to their defaults: one
    // looks for an installed proxy wrapper and starts it, the other writes
    // /etc/systemd/resolved.conf.d and restarts systemd-resolved. A test that
    // forgets to stub them does not fail cleanly — it either edits the system
    // running the suite or, unprivileged, fails on EACCES from somewhere that
    // reads as a bug in whatever it was actually testing.
    proxyWrapper: () => null,
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
    stopBridge: async () => ({ stopped: true, reason: null }),
    dropins: async () => [],
    readManifest: async () => null,
    // Pointed away from /var/lib so nothing here can write outside a temp dir;
    // the tests that care about the manifest hand in their own path.
    manifestFile: path.join(os.tmpdir(), "moshcode-test-manifest-unused.json"),
    uid: 0,
  };
}

/* --------------------------- a proxy this run started is a proxy it can trust */

// Detection used to ask the proxy for a certificate under `a.<ending>`. The
// proxy will not present one for a name with no key published in the registry —
// deliberately, so a browser gets a TLS failure it can explain — and nothing
// here can invent a name someone has registered, because the registry lists
// endings and not names.
//
// So on a correctly configured machine the check could not pass. Three lines
// apart, both true as written:
//
//     ok   proxy holds 127.0.0.1:443
//     --   no pinned-TLS proxy on this machine
//
// and the bridge was then started without proxy mode, leaving every name to
// answer its origin with a certificate no CA had signed.

test("a proxy started by this run turns proxy mode on without a handshake", async () => {
  const lines = [];
  let startedWith = null;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    proxyWrapper: () => "/home/x/.local/bin/moshpit-proxy",
    ensureProxy: async () => ({ ok: true, steps: [{ step: "proxy holds 127.0.0.1:443", ok: true }] }),
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
    // If this is consulted at all the fix has not worked: the whole point is
    // that no name is invented and no handshake is attempted.
    findLocalProxyImpl: async () => { throw new Error("the probe must not run for a proxy we started"); },
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  });

  assert.equal(code, 0);
  assert.match(lines.join("\n"), /started by this run/);
  assert.equal(startedWith?.proxy, "127.0.0.1", "the bridge has to be told, or names still answer their origin");
});

test("a proxy this run did not start is still probed", async () => {
  // The question is genuinely open there, so the handshake stays.
  const lines = [];
  let probed = false;
  await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    proxyWrapper: () => "/home/x/.local/bin/moshpit-proxy",
    ensureProxy: async () => ({ ok: false, reason: "not-listening", steps: [] }),
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
    findLocalProxyImpl: async () => { probed = true; return { found: false, why: null, address: { v4: null, v6: null } }; },
  });

  assert.equal(probed, true);
});

test("with no proxy installed, nothing is claimed and DNS still comes up", async () => {
  const lines = [];
  let startedWith = null;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    proxyWrapper: () => null,
    applyWith: async () => ({ saved: { ok: true }, applied: { ok: true, results: [] }, verified: { ok: true, checks: [] }, rolledBack: null, backups: [] }),
    startBridge: async (opts) => { startedWith = opts; return { started: true, pid: 1, alreadyRunning: false }; },
  });

  assert.equal(code, 0, "a missing optional component must never refuse the machine its DNS");
  assert.equal(startedWith?.proxy, null);
  assert.match(lines.join("\n"), /no pinned-TLS proxy installed/);
});

/* ------------------- a supervised bridge is re-described, not left alone ---*/

// The last thing that had to be done by hand. `startBridge` reports "already
// running" for a bridge systemd owns and leaves it alone — correct, and the
// reason proxy mode arrived a reboot late: what a resolver answers with is
// fixed when it spawns, so a bridge that came up before the proxy existed goes
// on answering origins whatever this run decides. Stopping it does not help
// either, because `Restart=always` brings the same ExecStart back.

test("an installed unit is rewritten with proxy mode and restarted", async () => {
  const lines = [];
  let asked = null;
  let startedByHand = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    proxyWrapper: () => "/home/x/.local/bin/moshpit-proxy",
    ensureProxy: async () => ({ ok: true, steps: [] }),
    refreshBridge: async (opts) => {
      asked = opts;
      return { refreshed: true, reason: null, upstreams: ["1.1.1.1"], steps: [{ step: "systemctl --user restart moshcode-dns.service", ok: true }] };
    },
    bridgeReady: async () => ({ started: true, pid: 99, alreadyRunning: false, supervised: true, verified: true }),
    startBridge: async () => { startedByHand = true; return { started: true, pid: 1, alreadyRunning: false }; },
  });

  assert.equal(code, 0);
  assert.equal(asked?.proxy, "127.0.0.1", "the unit has to carry --proxy, or the bridge still answers origins");
  assert.equal(startedByHand, false, "systemd owns this bridge — starting a second one is how two bridges end up on the port");
  assert.match(lines.join("\n"), /restarted with proxy mode on/);
  assert.match(lines.join("\n"), /forwarding the clearnet to 1\.1\.1\.1/);
});

test("with no unit installed, nothing is said about one and the daemon is started", async () => {
  const lines = [];
  let startedByHand = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    startBridge: async () => { startedByHand = true; return { started: true, pid: 1, alreadyRunning: false }; },
  });

  assert.equal(code, 0);
  assert.equal(startedByHand, true);
  assert.doesNotMatch(lines.join("\n"), /could not update/, "an unsupervised machine is not a failure to report");
});

test("a unit that restarts but never answers refuses the machine its routing", async () => {
  // `systemctl restart` returns as soon as a Type=simple unit forks, so it
  // returns 0 for a bridge that forked and died. The next thing enable does is
  // point every lookup on the machine at that port.
  const lines = [];
  let applied = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    refreshBridge: async () => ({ refreshed: true, reason: null, upstreams: [], steps: [] }),
    bridgeReady: async () => ({ started: false, alreadyRunning: false, pid: null, supervised: true, error: "moshcode-dns.service restarted but the bridge did not answer on 127.0.0.1:5354" }),
    applyWith: async () => { applied = true; return { ok: true, steps: [] }; },
  });

  assert.equal(code, 1);
  assert.equal(applied, false, "nothing may be written when the bridge is not answering");
  assert.match(lines.join("\n"), /did not answer/);
  assert.match(lines.join("\n"), /Nothing has been changed/);
});

test("a unit that cannot be updated is reported, and the run continues", async () => {
  // A refusal from systemctl is worth naming — proxy mode will not take effect
  // — but it is not a reason to leave the machine without DNS.
  const lines = [];
  let startedByHand = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    refreshBridge: async () => ({ refreshed: false, reason: "systemctl refused the unit", upstreams: [], steps: [{ step: "systemctl --user restart moshcode-dns.service", ok: false, error: "Interactive authentication required" }] }),
    startBridge: async () => { startedByHand = true; return { started: true, pid: 1, alreadyRunning: false }; },
  });

  assert.equal(code, 0);
  assert.equal(startedByHand, true);
  assert.match(lines.join("\n"), /could not update moshcode-dns\.service/);
  assert.match(lines.join("\n"), /keeps the mode it started with/);
});

/* ------------------ turning it off has to stop a bridge systemd is holding -*/

test("disable stops the unit through systemd, not by signalling a pid", async () => {
  // `stopDaemon` kills what the pidfile names, and the unit is Restart=always:
  // the process dies and systemd has the same ExecStart back within the second.
  // So disable printed "bridge stopped" on a machine where the bridge was still
  // up and answering — just no longer on anything's path.
  const lines = [];
  let askedSystemd = false;
  const code = await dnsCommand(["disable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" }],
    stopSupervised: async () => { askedSystemd = true; return { stopped: true, reason: null, steps: [] }; },
  });

  assert.equal(code, 0);
  assert.equal(askedSystemd, true, "killing the pid alone leaves a bridge systemd will restart");
  assert.match(lines.join("\n"), /moshcode-dns\.service stopped and disabled/);
});

test("disable says nothing about a unit on a machine that has none", async () => {
  const lines = [];
  const code = await dnsCommand(["disable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" }],
  });

  assert.equal(code, 0);
  assert.doesNotMatch(lines.join("\n"), /moshcode-dns\.service/);
});

test("a unit that will not stop is named, because it is about to come back", async () => {
  const lines = [];
  const code = await dnsCommand(["disable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" }],
    stopSupervised: async () => ({ stopped: false, reason: "Interactive authentication required", steps: [] }),
  });

  assert.equal(code, 0, "a bridge that will not stop is not a reason to leave the routing in place");
  assert.match(lines.join("\n"), /could not stop moshcode-dns\.service/);
  assert.match(lines.join("\n"), /it will restart itself/);
});

test("a supervised machine is not told to re-run enable after a reboot", async () => {
  // The unit was just enabled and restarted, so the bridge does come back.
  // Telling someone to re-run a command they do not need is how advice stops
  // being read at all.
  const lines = [];
  await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    refreshBridge: async () => ({ refreshed: true, reason: null, upstreams: [], steps: [] }),
    bridgeReady: async () => ({ started: true, pid: 99, alreadyRunning: false, supervised: true, verified: true }),
  });

  const out = lines.join("\n");
  assert.match(out, /moshcode-dns\.service brings the bridge back after a reboot/);
  assert.doesNotMatch(out, /does not yet survive a reboot/);
});

test("an unsupervised machine is still told the bridge dies at reboot", async () => {
  const lines = [];
  await dnsCommand(["enable"], (l) => lines.push(String(l)), { ...noSystem() });
  assert.match(lines.join("\n"), /does not yet survive a reboot/);
});

test("a rollback leaves a supervised bridge where it found it", async () => {
  // It was holding the port before this run and is meant to go on holding it.
  // Signalling its pid would not stop it anyway — Restart=always replaces it
  // within the second — so the old line printed "remove bridge started by this
  // run" about a bridge that was neither started by this run nor removed.
  const lines = [];
  let killed = false;
  const code = await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    refreshBridge: async () => ({ refreshed: true, reason: null, upstreams: [], steps: [] }),
    bridgeReady: async () => ({ started: true, pid: 99, alreadyRunning: false, supervised: true, verified: true }),
    applyWith: async () => ({
      saved: { ok: true },
      applied: { ok: true, results: [] },
      verified: { ok: false, checks: [{ name: "pit.moshcode.sh", kind: "clearnet", ok: false, error: "ENOTFOUND" }] },
      rolledBack: { ok: true, results: [] },
      backups: [],
    }),
    stopBridge: async () => { killed = true; return { stopped: true, reason: null }; },
  });

  assert.equal(code, 1);
  assert.equal(killed, false, "systemd would put it straight back, so the kill is noise that reads as a fact");
  assert.doesNotMatch(lines.join("\n"), /remove bridge started by this run/);
});

test("a rollback still cleans up a bridge this run really did start", async () => {
  const lines = [];
  let killed = false;
  await dnsCommand(["enable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    startBridge: async () => ({ started: true, pid: 7, alreadyRunning: false }),
    applyWith: async () => ({
      saved: { ok: true },
      applied: { ok: true, results: [] },
      verified: { ok: false, checks: [{ name: "pit.moshcode.sh", kind: "clearnet", ok: false, error: "ENOTFOUND" }] },
      rolledBack: { ok: true, results: [] },
      backups: [],
    }),
    stopBridge: async () => { killed = true; return { stopped: true, reason: null }; },
  });

  assert.equal(killed, true, "an unsupervised bridge left on 5354 is what the next preflight refuses to run past");
  assert.match(lines.join("\n"), /remove bridge started by this run/);
});
