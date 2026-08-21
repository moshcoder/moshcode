// `dns disable` putting a machine back, rather than deleting a filename.
//
// The bug: disable removed /etc/systemd/resolved.conf.d/moshpit.conf, restarted
// systemd-resolved, and printed "Moshpit TLDs are back to your normal
// resolver". On a machine where anything else routes to the bridge — and the
// moshpit-proxy installer writes 00-moshpit.conf to do exactly that — it
// changed nothing observable and said it had worked. A silently successful
// no-op is worse than a failure, because nobody re-reads the output of a
// command that reported success.
//
// So enable records what the machine looked like, and disable replays that.
// These tests are about what gets recorded, what gets replayed, and what
// happens when there is nothing to replay.
import test from "node:test";
import assert from "node:assert/strict";

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bridgeDropins, captureRestorePoint, dnsCommand, dropinDomains, MANIFEST_VERSION,
  manifestPath, parseManifest, restorePlan, writtenByMoshcode,
} from "../src/dns.mjs";
import { applyPlan } from "../src/dns-system.mjs";

/* ----------------------------------------------------------- the recording */

test("the snapshot covers every drop-in that steers a query, not just ours", async () => {
  // The whole reason detection was not enough: the file that keeps a machine
  // routed after `disable` is by definition one this code did not write, so a
  // snapshot limited to our own filename could never have caught it.
  const point = await captureRestorePoint({
    plan: { steps: [{ kind: "write", path: "/etc/systemd/resolved.conf.d/moshpit.conf", content: "new" }] },
    platform: "linux",
    bridge: "127.0.0.1:5354",
    dropins: async () => [
      { name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" },
      { name: "DigitalOcean.conf", content: "[Resolve]\nDNS=67.207.67.2\n" },
      { name: "search-only.conf", content: "[Resolve]\nDomains=~corp.example\n" },
      { name: "dnssec.conf", content: "[Resolve]\nDNSSEC=no\n" },
    ],
    read: async () => null,
    now: () => "2026-08-03T00:00:00.000Z",
  });

  assert.deepEqual(point.files.map((f) => f.path), [
    "/etc/systemd/resolved.conf.d/00-moshpit.conf",
    "/etc/systemd/resolved.conf.d/DigitalOcean.conf",
    "/etc/systemd/resolved.conf.d/moshpit.conf",
    "/etc/systemd/resolved.conf.d/search-only.conf",
  ]);
  // Domains= steers as surely as DNS= does — a drop-in setting only `Domains=~.`
  // sends every lookup to the global scope, and restoring half a routing
  // decision is not restoring it.
  assert.ok(point.files.some((f) => f.path.endsWith("search-only.conf")));
  // Nothing else in the file has an effect on where a query goes.
  assert.ok(!point.files.some((f) => f.path.endsWith("dnssec.conf")));
  // null is the instruction to remove: the file this run is about to create
  // did not exist, so putting the machine back means it is gone, not empty.
  assert.equal(point.files.find((f) => f.path.endsWith("/moshpit.conf")).content, null);
});

test("a manifest carries its own restart command rather than trusting the build that reads it", () => {
  // A machine enabled by one build is disabled by whatever is installed months
  // later. Re-deriving the restart there means undoing a run with a command
  // that build invented, not the one that was used.
  const manifest = parseManifest(JSON.stringify({
    version: MANIFEST_VERSION,
    files: [{ path: "/etc/x.conf", content: "old\n" }, { path: "/etc/y.conf", content: null }],
    restart: [{ command: "systemctl", args: ["restart", "systemd-resolved"] }],
  }));
  const plan = restorePlan(manifest);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["write", "remove", "run"]);
  assert.equal(plan.steps[0].content, "old\n");
  assert.equal(plan.steps[2].command, "systemctl");
});

test("an unreadable or newer manifest is null, not an error", () => {
  // Falling back to detection beats refusing to disable because a newer
  // moshcode enabled this machine, or because the file got truncated.
  assert.equal(parseManifest("{ not json"), null);
  assert.equal(parseManifest(JSON.stringify({ version: 99, files: [] })), null);
  assert.equal(parseManifest(JSON.stringify({ version: MANIFEST_VERSION })), null, "no files array is not a manifest");
});

test("the manifest does not live under resolved.conf.d", () => {
  // systemd-resolved globs *.conf there, which the backup suffix already works
  // around — but the deeper reason is that a manifest is state about the
  // machine, and that directory is the one place other tooling templates, syncs
  // and wipes wholesale.
  assert.doesNotMatch(manifestPath({}), /resolved\.conf\.d/);
  assert.equal(manifestPath({ MOSHCODE_DNS_MANIFEST: "/tmp/x.json" }), "/tmp/x.json");
});

test("Domains= is parsed the way DNS= is", () => {
  assert.deepEqual(dropinDomains("[Resolve]\nDomains=~eggs ~hacker\n"), ["~eggs", "~hacker"]);
  assert.deepEqual(dropinDomains("[Resolve]\n#Domains=~.\n"), []);
});

/* --------------------------------------------------------- who wrote what */

test("ours is identified by the header it writes, and theirs is named with a guess", () => {
  const found = bridgeDropins([
    { name: "moshpit.conf", content: "# Written by `moshcode dns enable`.\n[Resolve]\nDNS=127.0.0.1:5354\n" },
    { name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" },
    { name: "corp.conf", content: "[Resolve]\nDNS=10.0.0.1\n" },
  ], { bridge: "127.0.0.1:5354" });

  assert.deepEqual(found.map((f) => f.name), ["moshpit.conf", "00-moshpit.conf"], "a drop-in pointing elsewhere is not ours to touch");
  assert.equal(found[0].mine, true);
  assert.equal(found[1].mine, false);
  assert.equal(found[1].likelySource, "the moshpit-proxy installer");
});

test("a renamed copy of our own file is still recognised as ours", () => {
  // Filename is the weaker signal — the header is what we actually stamp.
  assert.equal(writtenByMoshcode("# Written by `moshcode dns install`. Routes...\n"), true);
  assert.equal(writtenByMoshcode("[Resolve]\nDNS=127.0.0.1:5354\n"), false);
});

/* ------------------------------------------------------------ round trip */

test("enable then disable leaves the drop-in directory byte-identical", async () => {
  // The claim the manifest exists to make. Two files before: one foreign
  // drop-in, one unrelated. Enable writes a third and rewrites nothing else;
  // disable has to end with exactly the two that were there, unchanged.
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "moshcode-restore-"));
  const before = {
    "00-moshpit.conf": "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n",
    "corp.conf": "[Resolve]\nDNS=10.0.0.1\nDomains=~corp.example\n",
  };
  for (const [name, content] of Object.entries(before)) fsSync.writeFileSync(path.join(dir, name), content);
  const ours = path.join(dir, "moshpit.conf");
  const manifest = path.join(dir, "..", `restore-${path.basename(dir)}.json`);

  const point = await captureRestorePoint({
    plan: { steps: [{ kind: "write", path: ours, content: "# Written by `moshcode dns enable`.\n[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" }] },
    platform: "linux",
    bridge: "127.0.0.1:5354",
    dir,
    dropins: async () => Object.entries(before).map(([name, content]) => ({ name, content })),
  });
  fsSync.writeFileSync(manifest, JSON.stringify(point));

  // The switch.
  await applyPlan({ steps: [{ kind: "write", path: ours, content: "whatever enable wrote" }] });
  fsSync.writeFileSync(path.join(dir, "00-moshpit.conf"), "mangled by something\n");

  // The undo.
  await applyPlan(restorePlan(parseManifest(fsSync.readFileSync(manifest, "utf8"))), { runner: async () => {} });

  const after = Object.fromEntries(fsSync.readdirSync(dir).map((n) => [n, fsSync.readFileSync(path.join(dir, n), "utf8")]));
  assert.deepEqual(after, before, "byte-identical, including the file moshcode never wrote");
  fsSync.rmSync(dir, { recursive: true, force: true });
  fsSync.rmSync(manifest, { force: true });
});

/* -------------------------------------------------- disable, through the CLI */

test("with no manifest, a foreign drop-in is named and NOT removed, and disable does not claim success", async () => {
  // The live bug, in the shape it was found: `moshcode dns disable` removed its
  // own file, restarted the resolver, and reported that Moshpit names were back
  // on the normal resolver while 00-moshpit.conf kept routing them.
  const lines = [];
  const removed = [];
  const code = await dnsCommand(["disable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\nDomains=~.\n" }],
    applyWith: async (plan) => {
      removed.push(...plan.steps.filter((s) => s.kind === "remove").map((s) => s.path));
      return done();
    },
  });

  assert.equal(code, 1, "routing is still in place — that is not a success");
  assert.ok(!removed.includes("/etc/systemd/resolved.conf.d/00-moshpit.conf"), "never removed without being asked");
  const out = lines.join("\n");
  assert.match(out, /likely the moshpit-proxy installer/);
  assert.match(out, /Moshpit names still resolve here/);
  assert.match(out, /--remove-foreign/);
  assert.doesNotMatch(out, /back to your normal resolver/, "the old line was the bug");
});

test("--remove-foreign removes it, and only then", async () => {
  const removed = [];
  const code = await dnsCommand(["disable", "--remove-foreign"], () => {}, {
    ...noSystem(),
    dropins: async () => [{ name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\n" }],
    applyWith: async (plan) => {
      removed.push(...plan.steps.filter((s) => s.kind === "remove").map((s) => s.path));
      return done();
    },
  });
  assert.equal(code, 0);
  assert.ok(removed.includes("/etc/systemd/resolved.conf.d/00-moshpit.conf"));
});

test("with a manifest, disable replays it instead of deleting a filename", async () => {
  const steps = [];
  const code = await dnsCommand(["disable"], () => {}, {
    ...noSystem(),
    readManifest: async () => ({
      version: MANIFEST_VERSION,
      createdAt: "2026-08-03T00:00:00.000Z",
      files: [
        { path: "/etc/systemd/resolved.conf.d/00-moshpit.conf", content: "[Resolve]\nDNS=8.8.8.8\n" },
        { path: "/etc/systemd/resolved.conf.d/moshpit.conf", content: null },
      ],
      restart: [{ command: "systemctl", args: ["restart", "systemd-resolved"] }],
    }),
    dropins: async () => [],
    applyWith: async (plan) => { steps.push(...plan.steps); return done(); },
  });
  assert.equal(code, 0);
  // The foreign file is put back as it was before enable ran — restoring is not
  // the same as removing, and the manifest is the only thing that knows which.
  assert.deepEqual(steps.map((s) => `${s.kind} ${s.path || s.command}`), [
    "write /etc/systemd/resolved.conf.d/00-moshpit.conf",
    "remove /etc/systemd/resolved.conf.d/moshpit.conf",
    "run systemctl",
  ]);
});

test("no manifest and nothing routed is a clean no-op, not an error and not a restart", async () => {
  // Restarting systemd-resolved is a real, if brief, outage. Doing it to undo
  // something that was never done is a cost paid for nothing.
  const lines = [];
  const code = await dnsCommand(["disable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "corp.conf", content: "[Resolve]\nDNS=10.0.0.1\n" }],
    applyWith: async () => { throw new Error("disable restarted the resolver for nothing"); },
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /not routed on this machine — nothing to undo/);
});

test("a disable that leaves the machine unable to resolve is undone", async () => {
  // The same standard as enable, and the same reason: restoring a prior state
  // that turns out not to resolve is the identical outage in reverse.
  const lines = [];
  const code = await dnsCommand(["disable"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "moshpit.conf", content: "# Written by `moshcode dns enable`.\n[Resolve]\nDNS=127.0.0.1:5354\n" }],
    applyWith: async () => ({
      saved: { ok: true },
      applied: { ok: true, results: [] },
      verified: { ok: false, checks: [{ name: "pit.moshcode.sh", kind: "clearnet", ok: false, error: "ENOTFOUND" }] },
      rolledBack: { ok: true, results: [] },
      backups: [],
    }),
    stopBridge: async () => { throw new Error("the bridge must stay up when the undo was undone"); },
  });
  assert.equal(code, 1);
  const out = lines.join("\n");
  assert.match(out, /unable to resolve, so the undo was undone/);
  assert.match(out, /machine is as it was before this command ran/);
});

test("disable verifies clearnet only — a Moshpit name is supposed to stop resolving", async () => {
  let asked = null;
  await dnsCommand(["disable"], () => {}, {
    ...noSystem(),
    dropins: async () => [{ name: "moshpit.conf", content: "# Written by `moshcode dns enable`.\n[Resolve]\nDNS=127.0.0.1:5354\n" }],
    applyWith: async (plan, o) => { await o.verify(); asked = lastVerifyArgs; return done(); },
  });
  assert.equal(asked.moshpit, null, "requiring a Moshpit name would roll back every successful undo");
});

test("--dry-run for disable names every file and writes nothing", async () => {
  const lines = [];
  const code = await dnsCommand(["disable", "--dry-run"], (l) => lines.push(String(l)), {
    ...noSystem(),
    dropins: async () => [{ name: "00-moshpit.conf", content: "[Resolve]\nDNS=127.0.0.1:5354\n" }],
    applyWith: async () => { throw new Error("--dry-run applied a plan"); },
    stopBridge: async () => { throw new Error("--dry-run stopped the bridge"); },
  });
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /remove {2}\/etc\/systemd\/resolved\.conf\.d\/moshpit\.conf/);
  assert.match(out, /NOT removed[\s\S]*00-moshpit\.conf.*likely the moshpit-proxy installer/);
  assert.match(out, /^rollback {2}\(only if verify fails\)/m);
  assert.match(out, /^verify {2}\(this machine must still resolve after the undo\)/m);
});

/* ------------------------------------------------------------------------- */

const done = () => ({
  saved: { ok: true },
  applied: { ok: true, results: [] },
  verified: { ok: true, checks: [] },
  rolledBack: null,
  backups: [],
});

/** What `disable` last asked its verifier for — the stub below records it. */
let lastVerifyArgs = null;

function noSystem() {
  return {
    // The enable/disable tree reads host drop-ins only on linux +
    // systemd-resolved; pinning the platform makes those paths deterministic
    // on a Mac or Windows checkout instead of silently skipped.
    platform: () => "linux",
    tlds: async () => ["eggs", "hacker"],
    safety: async () => ({ safe: true, upstreams: ["1.1.1.1"], why: "" }),
    preflight: async () => ({ ok: true, blockers: [], conflicts: [], duplicates: [], holder: null }),
    verify: async (args) => { lastVerifyArgs = args; return { ok: true, checks: [] }; },
    bridgeStatus: async () => ({ running: false, pid: null, stale: false }),
    startBridge: async () => ({ started: true, pid: 1, alreadyRunning: false }),
    stopBridge: async () => ({ stopped: true, reason: null }),
    dropins: async () => [],
    readManifest: async () => null,
    manifestFile: "/tmp/moshcode-test-manifest-never-written.json",
    uid: 0,
  };
}
