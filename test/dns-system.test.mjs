// Routing Moshpit TLDs on each OS.
//
// The plans are data, so every platform's behaviour is testable from any
// platform — which matters, because the Windows and macOS paths would otherwise
// only ever be exercised by someone running Windows or macOS.
import assert from "node:assert/strict";
import test from "node:test";

import {
  WINDOWS_REQUIRED_PORT, describePlan, detectPlatform, disablePlan, enablePlan, requiredPort,
} from "../src/dns-system.mjs";

const TLDS = ["moshpit", "eggs"];

test("platform detection", () => {
  assert.equal(detectPlatform("darwin"), "macos");
  assert.equal(detectPlatform("win32"), "windows");
  assert.equal(detectPlatform("linux"), "linux");
  assert.equal(detectPlatform("aix"), null, "an unknown platform is null, not a guess");
});

test("macOS routes per TLD and restarts nothing", () => {
  const plan = enablePlan({ platform: "macos", tlds: TLDS, port: 5354 });

  assert.equal(plan.steps.length, 2, "one file per TLD");
  assert.deepEqual(plan.steps.map((s) => s.path), ["/etc/resolver/moshpit", "/etc/resolver/eggs"]);
  assert.match(plan.steps[0].content, /nameserver 127\.0\.0\.1/);
  assert.match(plan.steps[0].content, /port 5354/);
  assert.ok(!plan.steps.some((s) => s.kind === "run"), "nothing to restart on macOS");
});

test("linux routes the suffixes only, never becoming the default resolver", () => {
  const plan = enablePlan({ platform: "linux", tlds: TLDS, port: 5354 });
  const conf = plan.steps.find((s) => s.kind === "write");

  assert.equal(conf.path, "/etc/systemd/resolved.conf.d/moshpit.conf");
  assert.match(conf.content, /DNS=127\.0\.0\.1:5354/);
  // The tilde is what makes it routing-only. Without it this becomes the
  // machine's resolver for everything, and every lookup depends on the bridge.
  assert.match(conf.content, /Domains=~moshpit ~eggs/);
  assert.deepEqual(plan.steps.at(-1).args, ["restart", "systemd-resolved"]);
});

test("linux can use dnsmasq instead", () => {
  const plan = enablePlan({ platform: "linux", tlds: TLDS, port: 5354, linuxBackend: "dnsmasq" });
  const conf = plan.steps.find((s) => s.kind === "write");

  assert.equal(conf.path, "/etc/dnsmasq.d/moshpit.conf");
  assert.match(conf.content, /server=\/moshpit\/127\.0\.0\.1#5354/);
  assert.deepEqual(plan.steps.at(-1).args, ["restart", "dnsmasq"]);
});

test("windows adds one NRPT rule per TLD", () => {
  const plan = enablePlan({ platform: "windows", tlds: TLDS, port: WINDOWS_REQUIRED_PORT });

  assert.equal(plan.steps.length, 2);
  assert.ok(plan.steps.every((s) => s.kind === "run" && s.command === "powershell"));
  assert.match(plan.steps[0].args.at(-1), /Add-DnsClientNrptRule -Namespace "\.moshpit"/);
});

test("windows refuses a port it cannot express", () => {
  // An NRPT rule has no port field. Accepting 5354 here would produce a rule
  // pointing at 127.0.0.1:53, where nothing is listening, and every Moshpit
  // name would fail with the routing looking correct.
  assert.throws(
    () => enablePlan({ platform: "windows", tlds: TLDS, port: 5354 }),
    /cannot carry a port/,
  );
  assert.equal(requiredPort("windows", 5354), 53);
  assert.equal(requiredPort("linux", 5354), 5354);
  assert.equal(requiredPort("macos", 5354), 5354);
});

test("an empty TLD list is refused rather than writing empty routing", () => {
  for (const platform of ["macos", "linux", "windows"]) {
    assert.throws(() => enablePlan({ platform, tlds: [] }), /no TLDs/, platform);
  }
});

test("TLDs are normalised and deduplicated", () => {
  const plan = enablePlan({ platform: "macos", tlds: [".Moshpit", "moshpit", "EGGS"], port: 5354 });
  assert.deepEqual(plan.steps.map((s) => s.path), ["/etc/resolver/moshpit", "/etc/resolver/eggs"]);
});

test("an unsupported platform is an error, not a silent no-op", () => {
  assert.throws(() => enablePlan({ platform: "plan9", tlds: TLDS }), /unsupported platform/);
  assert.throws(() => disablePlan({ platform: "plan9" }), /unsupported platform/);
});

test("disable removes what enable added", () => {
  const off = disablePlan({ platform: "macos", tlds: TLDS });
  assert.deepEqual(off.steps.map((s) => s.kind), ["remove", "remove"]);
  assert.deepEqual(off.steps.map((s) => s.path), ["/etc/resolver/moshpit", "/etc/resolver/eggs"]);

  const linux = disablePlan({ platform: "linux" });
  assert.equal(linux.steps[0].kind, "remove");
  assert.deepEqual(linux.steps.at(-1).args, ["restart", "systemd-resolved"]);
});

test("windows disable matches on the nameserver, not on a remembered list", () => {
  // The TLD list changes between enable and disable; a removal driven by the
  // current list would strand every rule for a TLD claimed since.
  const off = disablePlan({ platform: "windows", tlds: [] });
  assert.equal(off.steps.length, 1);
  assert.match(off.steps[0].args.at(-1), /Remove-DnsClientNrptRule -Force/);
  assert.match(off.steps[0].args.at(-1), /127\.0\.0\.1/);
});

test("macOS disable with no known TLDs says so instead of pretending", () => {
  const off = disablePlan({ platform: "macos", tlds: [] });
  assert.equal(off.steps.length, 0);
  assert.match(off.notes.join(" "), /nothing removed/i);
});

test("a plan reads as something you can agree to before running it", () => {
  const text = describePlan(enablePlan({ platform: "linux", tlds: TLDS, port: 5354 }));
  assert.match(text, /write\s+\/etc\/systemd/);
  assert.match(text, /run\s+systemctl restart systemd-resolved/);
  assert.match(text, /Domains=~moshpit ~eggs/, "the actual file contents, not a summary");
});
