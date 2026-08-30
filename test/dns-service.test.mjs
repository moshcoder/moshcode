// What the generated unit is not allowed to be.
//
// A unit file shipped in examples/templates said this, and could not start on
// an ordinary install:
//
//     ExecStart=/usr/bin/env moshcode dns start --port 5354
//     DynamicUser=yes
//     ProtectHome=yes
//
// Three independent reasons, and each one alone is fatal. `moshcode` is not on
// systemd's PATH — it installs to ~/.local/bin. The `node` its wrapper execs is
// not on it either, because on a mise, nvm or asdf box that is a shim under
// $HOME. And ProtectHome hides the install from the service even if both had
// somehow been found. It starts only where moshcode and node are both installed
// system-wide, which is the server case that was already working — so the unit
// that existed to fix desktops was the one thing guaranteed not to.
//
// These tests are mostly negative for that reason: the failure mode is a unit
// that looks plausible and dies at 203/EXEC with nothing useful in the journal.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installService, removeService, serviceUnit, servicePaths, UNIT_NAME } from "../src/dns-service.mjs";
import { proxyProbeFromArgs, captureRestorePoint } from "../src/dns.mjs";
import { proxyServiceUnit, proxyServicePaths, PROXY_UNIT_NAME } from "../src/dns-service.mjs";

const scratch = () => mkdtemp(join(tmpdir(), "moshcode-service-"));
const unit = (opts = {}) => serviceUnit({ entry: "/opt/moshcode/bin/moshcode.mjs", port: 5354, execPath: "/opt/node/bin/node", ...opts });

test("ExecStart names an interpreter by absolute path, never a PATH lookup", () => {
  const text = unit();
  assert.match(text, /^ExecStart=\/opt\/node\/bin\/node \/opt\/moshcode\/bin\/moshcode\.mjs dns start --port 5354$/m);
  assert.doesNotMatch(text, /\/usr\/bin\/env/, "env re-introduces the PATH lookup that could not find moshcode or node");
});

test("the three settings that made the shipped unit unstartable are absent", () => {
  const text = unit();
  assert.doesNotMatch(text, /DynamicUser/, "a transient user has no $HOME to find the install in");
  assert.doesNotMatch(text, /ProtectHome/, "the whole program lives under $HOME");
});

test("a user unit does not pin a user, and installs into the user's own tree", () => {
  const text = unit({ system: false });
  assert.doesNotMatch(text, /^User=/m, "a user unit already runs as the user");
  assert.match(text, /^WantedBy=default\.target$/m);

  const { path, systemctl, scope } = servicePaths({ system: false, home: "/home/someone" });
  assert.equal(path, `/home/someone/.config/systemd/user/${UNIT_NAME}`);
  assert.deepEqual(systemctl, ["systemctl", "--user"]);
  assert.equal(scope, "user");
});

test("a system unit has to be told whose install to run", () => {
  const text = unit({ system: true, user: "ettinger" });
  assert.match(text, /^User=ettinger$/m, "without this it runs as root and looks for the install in /root");
  assert.match(text, /^WantedBy=multi-user\.target$/m);
  assert.equal(servicePaths({ system: true }).path, `/etc/systemd/system/${UNIT_NAME}`);
});

test("the port and registry the bridge was asked for reach the unit", () => {
  const text = unit({ port: 5355, registryBase: "https://pit.example.test" });
  assert.match(text, /--port 5355/);
  assert.match(text, /--registry https:\/\/pit\.example\.test/);
});

test("a path with a space survives being written into ExecStart", () => {
  // "Application Support" and "Program Files" both contain one, and systemd
  // splits ExecStart on whitespace.
  const text = unit({ execPath: "/opt/my node/bin/node" });
  assert.match(text, /ExecStart="\/opt\/my node\/bin\/node"/);
});

test("a unit without an entry is refused rather than written half-formed", () => {
  assert.throws(() => serviceUnit({ port: 5354 }), /entry/);
});

test("install writes the unit, then reloads and enables — and stops at the first failure", async () => {
  const home = await scratch();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return { ok: !args.includes("enable"), error: args.includes("enable") ? "Failed to enable" : "" };
  };

  const result = await installService(unit(), { home, exec });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT_NAME}`]);
  assert.equal(existsSync(join(home, ".config/systemd/user", UNIT_NAME)), true, "the file is written before systemctl is asked about it");
  assert.equal(result.steps.at(-1).error, "Failed to enable", "the reason systemctl gave is carried back, not swallowed");
});

test("remove takes the unit away even when it was never enabled", async () => {
  const home = await scratch();
  // `disable` on a unit systemd has never heard of is an error, and removal
  // still has to work — otherwise a half-installed service cannot be undone.
  const result = await removeService({ home, exec: async () => ({ ok: false, error: "does not exist" }) });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(home, ".config/systemd/user", UNIT_NAME)), false);
});

/* ------------------------------------------------- pointing at the proxy */

// A supervised bridge that answers with the origin gives every name a
// certificate no CA signed, so `https://` fails on a machine where the
// pinned-TLS proxy is installed, trusted and running. `dns enable` has always
// probed for the proxy and passed it to the daemon; `dns service` did not,
// which made a service-managed bridge the one way to run Moshpit where HTTPS
// could not work at all.

test("the unit points names at the local proxy when there is one", () => {
  assert.match(unit({ proxy: "127.0.0.1" }), /ExecStart=.* --proxy 127\.0\.0\.1$/m);
});

test("a v6 proxy address survives into the unit", () => {
  assert.match(unit({ proxy: "::1" }), /--proxy ::1$/m);
});

test("no proxy means no flag, not an empty one", () => {
  // `--proxy` with nothing after it would make the daemon read the next token
  // as an address, and there is no next token.
  assert.doesNotMatch(unit({ proxy: null }), /--proxy/);
  assert.doesNotMatch(unit(), /--proxy/);
});

test("upstreams and proxy coexist without eating each other's values", () => {
  const text = unit({ upstreams: ["1.1.1.1", "1.0.0.1"], proxy: "127.0.0.1" });
  assert.match(text, /--upstream 1\.1\.1\.1,1\.0\.0\.1 --proxy 127\.0\.0\.1$/m);
});

/* ----------------------------------------- which name detects the proxy */

// The probe is a TLS handshake with the name in SNI, and the proxy can only
// present a certificate for a name that exists — it fetches the registry pin to
// mint one. Measured against a proxy that was installed, trusted and listening
// on 127.0.0.1:443:
//
//     a.moshpit  -> no certificate
//     a.2600     -> no certificate
//     alt.2600   -> issuer=CN=Moshpit Local CA
//
// So the synthesised `a.<ending>` default reports "no proxy found" on a machine
// where the proxy is working perfectly, and every https:// URL then fails with
// a self-signed certificate that nothing explains.

test("a named probe is used exactly as given", () => {
  assert.deepEqual(proxyProbeFromArgs(["--proxy-probe", "alt.2600"]), { name: "alt.2600", invalid: false });
});

test("a named probe does not need the registry", () => {
  // The name wins over the ending list, so the 18000-ending fetch is skipped.
  assert.equal(proxyProbeFromArgs(["--proxy-probe", "blue.eggs"], ["aaa", "abb"]).name, "blue.eggs");
});

test("a bare --proxy-probe is a typo, not a request to probe with nothing", () => {
  assert.deepEqual(proxyProbeFromArgs(["--proxy-probe"]), { name: null, invalid: true });
  assert.deepEqual(proxyProbeFromArgs(["--proxy-probe", "--write"]), { name: null, invalid: true });
});

test("without the flag it falls back to the historical synthetic name", () => {
  // Right on a machine whose proxy serves every ending; wrong on one that only
  // serves real names — which is why the flag exists rather than replacing it.
  assert.equal(proxyProbeFromArgs([], ["eggs", "hacker"]).name, "a.eggs");
  assert.equal(proxyProbeFromArgs([]).name, null);
  assert.equal(proxyProbeFromArgs([], []).name, null);
});

/* ------------------------------------------------ supervising the proxy */

// moshpit-proxy ships no unit of its own, so on every machine that installed it
// it sat there installed, trusted, and never started. That is indistinguishable
// from absent — nothing on 443, no certificate, and `dns enable` correctly
// reporting no proxy on a box that had one. Verified against dev's
// hand-written unit, which reached the same shape independently.

const px = (opts = {}) => proxyServiceUnit({
  wrapper: "/home/x/.local/bin/moshpit-proxy",
  nodeDir: "/opt/node/bin",
  home: "/home/x",
  user: "x",
  ...opts,
});

test("the proxy unit runs the wrapper with a PATH that has the right node", () => {
  const text = px();
  assert.match(text, /^ExecStart=\/home\/x\/\.local\/bin\/moshpit-proxy$/m);
  // The wrapper execs `node`, which systemd's PATH does not have on a mise,
  // nvm or asdf box. Three separate bugs today were this exact thing.
  assert.match(text, /^Environment=PATH=\/opt\/node\/bin:/m);
});

test("it binds 443 by capability rather than by running as root", () => {
  const text = px();
  assert.match(text, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
  assert.match(text, /^User=x$/m, "it drops to the operator, who owns the local root");
  assert.match(text, /^Environment=MOSHPIT_PROXY_PORT=443$/m);
});

test("the proxy dir is the operator's, never root's", () => {
  // A system unit would otherwise look in /root/.moshpit, where the local root
  // that moshpit-proxy's installer generated is definitively not.
  assert.match(px(), /^Environment=MOSHPIT_PROXY_DIR=\/home\/x\/\.moshpit$/m);
});

test("it serves the endings it is given, and says nothing when given none", () => {
  assert.match(px({ tlds: ["moshpit", "eggs", "2600"] }), /^Environment=MOSHPIT_PROXY_TLDS=moshpit,eggs,2600$/m);
  // Unset means the proxy's own default of `.moshpit` alone — which is why a
  // healthy proxy can still fail to present a certificate for the name someone
  // is actually trying to reach.
  assert.doesNotMatch(px({ tlds: [] }), /MOSHPIT_PROXY_TLDS/);
});

test("a unit it cannot pin is refused rather than written half-formed", () => {
  assert.throws(() => proxyServiceUnit({ nodeDir: "/opt/node/bin", user: "x" }), /wrapper/);
  assert.throws(() => proxyServiceUnit({ wrapper: "/w", nodeDir: "/n", user: "" }), /account/);
});

test("the proxy is a system unit, because 443 is privileged", () => {
  const { path, systemctl, scope } = proxyServicePaths();
  assert.equal(path, `/etc/systemd/system/${PROXY_UNIT_NAME}`);
  assert.deepEqual(systemctl, ["systemctl"]);
  assert.equal(scope, "system");
});

/* ------------------------------------------------- recording them for undo */

test("the restore point records the units, including that they were absent", async () => {
  // `null` is the load-bearing value: it is what makes `disable` remove a unit
  // this run created, and what stops it removing one that was already there.
  const point = await captureRestorePoint({
    plan: { steps: [] },
    platform: "linux",
    bridge: "127.0.0.1:5354",
    dropins: async () => [],
    read: async (path) => (path === "/etc/systemd/system/moshpit-proxy.service" ? "theirs, from before\n" : null),
    extraPaths: ["/etc/systemd/system/moshpit-proxy.service", "/home/x/.config/systemd/user/moshcode-dns.service"],
  });

  const byPath = Object.fromEntries(point.files.map((f) => [f.path, f.content]));
  assert.equal(byPath["/etc/systemd/system/moshpit-proxy.service"], "theirs, from before\n");
  assert.equal(byPath["/home/x/.config/systemd/user/moshcode-dns.service"], null);
});
