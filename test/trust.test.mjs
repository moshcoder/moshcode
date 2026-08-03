/**
 * Installing a root into a trust store, and refusing to when it is not safe.
 *
 * No CA will ever sign for a Moshpit name — the Baseline Requirements banned
 * issuance for non-IANA names in 2015 — so a stock client can only be satisfied
 * by a root generated on this machine. That is a real thing to hand someone,
 * and the reason it is acceptable is one extension: name constraints limiting
 * the root to Moshpit endings, so the worst it can forge is a name its holder
 * already controls.
 *
 * moshpit-proxy sets that constraint today and has its own test for it. These
 * tests exist because "upstream does it correctly" is not a property this side
 * can assume: a regression there would otherwise become a root that can vouch
 * for anything, installed automatically by `dns enable`, on every machine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  applyTrust, caPath, describeCertificateCommand, operatorHome, parseNameConstraints,
  refusalRemedy, requireNameConstraints, trustPlan, trustStores, verifyStockTls,
} from "../src/trust.mjs";

/**
 * A real root with whatever nameConstraints line you hand it, or null when
 * openssl is unavailable.
 *
 * `constraints` is the raw openssl extension value, so a test can build the
 * shapes that matter — permitted, excluded, both, neither — rather than only
 * the one the happy path uses.
 */
function makeRoot({ constraints }) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshca-"));
    const key = path.join(dir, "ca.key");
    const crt = path.join(dir, "ca.crt");
    const cnf = path.join(dir, "openssl.cnf");
    fs.writeFileSync(cnf, [
      "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no",
      "[dn]", "CN=Moshpit Local CA",
      "[v3]", "basicConstraints=critical,CA:true", "keyUsage=critical,keyCertSign",
      ...(constraints ? [`nameConstraints=${constraints}`] : []),
    ].join("\n"));
    execFileSync("openssl", [
      "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", key, "-out", crt, "-days", "1", "-config", cnf,
    ], { stdio: "ignore" });
    const text = execFileSync("openssl", ["x509", "-noout", "-text", "-in", crt]).toString();
    fs.rmSync(dir, { recursive: true, force: true });
    return text;
  } catch {
    return null;
  }
}

const MOSHPIT_ONLY = "critical,permitted;DNS:.hacker,permitted;DNS:.rank";

/**
 * Skip loudly, never silently.
 *
 * These tests are the only thing standing between a regression upstream and an
 * unconstrained root installed by `dns enable`. A fixture that fails to build
 * used to `return` — passing without asserting anything — so a box without
 * openssl reported a green guard it had not tested at all.
 */
function needRoot(t, constraints) {
  const text = makeRoot({ constraints });
  if (!text) t.skip("openssl is not available to generate a test root");
  return text;
}

/* ------------------------------------------------------------- the gate */

test("a root constrained to Moshpit endings is accepted", (t) => {
  const text = needRoot(t, MOSHPIT_ONLY);
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker", "rank"] });
  assert.equal(verdict.ok, true, verdict.why);
});

test("a root with no name constraints is refused, not warned about", (t) => {
  // This is the whole safety argument. An unconstrained root in the system
  // store can vouch for a bank; there is no wording of a warning that makes
  // that acceptable, so it must not be installable at all.
  const text = needRoot(t, null);
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker"] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /no name constraints|any name/);
});

test("an excluded-only root is refused — exclusions constrain nothing", (t) => {
  // RFC 5280 §4.2.1.10: constraints bind only the name types they mention, so
  // a root that merely *excludes* .hacker permits every other DNS name on the
  // internet. It carries a critical Name Constraints extension naming the very
  // ending we asked about, which is exactly why a substring check passed it and
  // installed a root that could vouch for a bank.
  const text = needRoot(t, "critical,excluded;DNS:.hacker");
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker"] });
  assert.equal(verdict.ok, false, "an excluded-only root must never be installable");
  assert.match(verdict.why, /permits no DNS subtree|any name/);
});

test("permitting someone else's namespace while excluding ours is refused", (t) => {
  // The same confusion in its other shape: the ending we care about appears in
  // the extension, but under Excluded, while Permitted names a namespace we do
  // not control.
  const text = needRoot(t, "critical,permitted;DNS:.evil,excluded;DNS:.hacker");
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker"] });
  assert.equal(verdict.ok, false);
});

test("a root that also permits the clearnet is refused", (t) => {
  // One extra permitted entry is the whole hole. `.hacker` is present and
  // correct; `.com` sitting beside it means the root reaches past Moshpit.
  const text = needRoot(t, "critical,permitted;DNS:.hacker,permitted;DNS:.com");
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker"] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /\.com/);
});

test("Permitted and Excluded are read as the opposite things they are", (t) => {
  const text = needRoot(t, "critical,permitted;DNS:.hacker,excluded;DNS:.evil");
  if (!text) return;
  const parsed = parseNameConstraints(text);
  assert.equal(parsed.critical, true);
  assert.deepEqual(parsed.permitted, [".hacker"]);
  assert.deepEqual(parsed.excluded, [".evil"]);
});

test("parsing stops at the end of the extension, not the end of the file", () => {
  // The next extension's own DNS-looking content must not be read as a
  // permitted subtree.
  const text = [
    "Certificate:",
    "            X509v3 Name Constraints: critical",
    "                Permitted:",
    "                  DNS:.hacker",
    "            X509v3 Subject Alternative Name:",
    "                DNS:.com",
  ].join("\n");
  assert.deepEqual(parseNameConstraints(text).permitted, [".hacker"]);
});

test("constraints that are not critical do not count", () => {
  // A verifier may ignore an extension it does not recognise. Non-critical
  // constraints are therefore a comment, not a guarantee.
  const text = [
    "Certificate:", "        X509v3 Name Constraints: ",
    "            Permitted:", "              DNS:.hacker",
  ].join("\n");
  const verdict = requireNameConstraints(text, { tlds: ["hacker"] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /critical/);
});

test("a root that does not permit the endings we resolve is refused", (t) => {
  const text = needRoot(t, MOSHPIT_ONLY);
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker", "eggs"] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /eggs/);
});

test("nothing usable from openssl is a refusal, not a pass", () => {
  // Failing open here would install an unverified root the first time openssl
  // changed its output or the file was unreadable.
  assert.equal(requireNameConstraints("", { tlds: [] }).ok, false);
  assert.equal(requireNameConstraints(null).ok, false);
  assert.equal(requireNameConstraints("-----BEGIN CERTIFICATE-----\nMIIB\n").ok, false,
    "the PEM body is base64 — an extension cannot be read out of it");
});

/* ------------------------------------------------------------ the plan */

// Permits exactly the endings the tests below ask about, which is the shape
// production hands in: `dns enable` passes the full claimed list, so a root
// permitting an ending outside it is the "reaches past Moshpit" case, not the
// normal one.
const CONSTRAINED = [
  "Certificate:",
  "        X509v3 Name Constraints: critical",
  "            Permitted:", "              DNS:.hacker",
].join("\n");

test("without root, the store that needs it is skipped and said so", () => {
  // The two halves fail separately and must be reported separately: NSS lands
  // without privileges while curl's store does not, and a summary that says
  // "installed" while curl still refuses is how someone concludes it is broken.
  const plan = trustPlan({
    caText: CONSTRAINED, tlds: ["hacker"], platform: "linux", home: "/home/x", isRoot: false,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((s) => s.id), ["nss"]);
  assert.deepEqual(plan.skipped.map((s) => s.id), ["system"]);
  assert.match(plan.skipped[0].why, /needs root/);
});

test("as root, both stores are written", () => {
  const plan = trustPlan({
    caText: CONSTRAINED, tlds: ["hacker"], platform: "linux", home: "/home/x", isRoot: true,
  });
  assert.deepEqual(plan.steps.map((s) => s.id), ["nss", "system"]);
});

test("a missing certutil is named with the package that provides it", () => {
  const plan = trustPlan({
    caText: CONSTRAINED, tlds: ["hacker"], platform: "linux", home: "/home/x",
    isRoot: true, haveCertutil: false,
  });
  assert.deepEqual(plan.steps.map((s) => s.id), ["system"]);
  assert.match(plan.skipped.find((s) => s.id === "nss").why, /libnss3-tools/);
});

test("an unconstrained root produces no steps at all", () => {
  const plan = trustPlan({ caText: "Certificate:\n  nothing here", tlds: ["hacker"], isRoot: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.refused, true);
  assert.deepEqual(plan.steps, []);
});

test("no root yet points at what generates it, rather than reporting a missing file", () => {
  const plan = trustPlan({ caText: null, home: "/home/x", platform: "linux" });
  assert.equal(plan.ok, false);
  assert.match(plan.why, /moshpit-proxy generates one/);
});

/* ------------------------------------------------------------- the paths */

test("the root is looked for where moshpit-proxy writes it", () => {
  assert.equal(caPath({ home: "/home/x" }), "/home/x/.moshpit/ca/ca.crt");
  assert.match(describeCertificateCommand("/tmp/ca.crt").args.join(" "), /-noout -text/);
});

/* ------------------------------------------------------- whose home it is */

test("under sudo, the operator's home is used and not root's", () => {
  // `dns enable` needs root and escalates itself, so os.homedir() here is
  // /root — while moshpit-proxy wrote the root, and the NSS database the
  // browser reads, under the operator's home. Getting this wrong reports
  // "no local root" on a machine that has one, or installs into a browser
  // profile nobody uses. It is the same $HOME-under-sudo trap as #272/#274.
  const home = operatorHome({
    env: { SUDO_USER: "anthony", HOME: "/root" },
    expand: (user) => (user === "anthony" ? "/home/anthony" : null),
  });
  assert.equal(home, "/home/anthony");
  assert.equal(caPath({ home }), "/home/anthony/.moshpit/ca/ca.crt");
});

test("without sudo it is just this user's home", () => {
  assert.equal(
    operatorHome({ env: { HOME: "/home/x" }, homedir: () => "/home/x" }),
    "/home/x",
  );
  // A bare root shell — a container, a CI image — is genuinely root's own.
  assert.equal(
    operatorHome({ env: { SUDO_USER: "root", HOME: "/root" }, homedir: () => "/root" }),
    "/root",
  );
});

test("an unresolvable SUDO_USER falls back rather than inventing a path", () => {
  assert.equal(
    operatorHome({ env: { SUDO_USER: "ghost", HOME: "/root" }, expand: () => null }),
    "/root",
  );
});

test("the NSS store is handed back to the operator after a root writes it", async () => {
  // Left owned by root, the browser silently loses the ability to update its
  // own store — a failure that surfaces much later looking unrelated.
  const h = harness({ uid: 0 });
  h.deps.env = { SUDO_USER: "anthony" };
  await applyTrust(["hacker"], h.out, h.deps);
  assert.ok(
    h.ran.some((c) => /^chown -R anthony: .*\.pki\/nssdb$/.test(c)),
    `nssdb was not handed back — ran: ${JSON.stringify(h.ran)}`,
  );
});

test("macOS has one store and it needs root", () => {
  const stores = trustStores({ platform: "darwin", home: "/Users/x", caFile: "/Users/x/ca.crt" });
  assert.deepEqual(stores.map((s) => s.id), ["macos-keychain"]);
  assert.equal(stores[0].needsRoot, true);
});

test("an unknown platform offers nothing rather than guessing", () => {
  assert.deepEqual(trustStores({ platform: "sunos", home: "/home/x" }), []);
});

/* ------------------------------------------------------------ the proof */

test("the verification relaxes nothing, or it would pass in the broken case", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    return { status: 200 };
  };
  const result = await verifyStockTls("seo.rank", { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(seen[0].url, "https://seo.rank/");
  // No pin, no relaxation — the point is that an ordinary client succeeds.
  assert.doesNotMatch(JSON.stringify(seen[0].opts || {}), /pin|insecure|rejectUnauthorized/i);
});

test("a TLS failure comes back as the reason, not as a thrown error", async () => {
  const fetchImpl = async () => {
    const err = new Error("fetch failed");
    err.cause = { code: "SELF_SIGNED_CERT_IN_CHAIN" };
    throw err;
  };
  const result = await verifyStockTls("seo.rank", { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.why, /SELF_SIGNED_CERT_IN_CHAIN/);
});

/* ------------------------------------------------ the step inside `dns enable` */

/** applyTrust with every edge injected, so no real trust store is touched. */
function harness({ caText = CONSTRAINED, describeOk = true, uid = 0, certutil = true, fail = null } = {}) {
  const lines = [];
  const ran = [];
  const runner = async (command, args) => {
    ran.push(`${command} ${args.join(" ")}`);
    if (command === "which") return { ok: certutil, stdout: "", stderr: "" };
    if (command === "openssl") return { ok: describeOk, stdout: describeOk ? caText : "", stderr: "" };
    if (command === fail) return { ok: false, stdout: "", stderr: "denied\n" };
    return { ok: true, stdout: "", stderr: "" };
  };
  return {
    lines, ran,
    deps: { readFile: async () => caText, runner, home: "/home/x", platform: "linux", uid },
    out: (l) => lines.push(l),
  };
}

test("as root it installs into both stores and says which", async () => {
  const h = harness({ uid: 0 });
  const result = await applyTrust(["hacker"], h.out, h.deps);
  const text = h.lines.join("\n");

  assert.equal(result.ok, true);
  assert.match(text, /installed into the NSS store/);
  assert.match(text, /installed into the system store/);
  assert.ok(h.ran.some((c) => c.startsWith("certutil")), "NSS is written with certutil");
  assert.ok(h.ran.some((c) => c.startsWith("update-ca-certificates")), "and the system store is refreshed");
});

test("without root it does the half it can and names the half it cannot", async () => {
  // The failure this avoids: reporting "installed" while curl still refuses,
  // which is exactly how someone concludes the whole feature is broken.
  const h = harness({ uid: 1000 });
  const text = (await applyTrust(["hacker"], h.out, h.deps), h.lines.join("\n"));

  assert.match(text, /installed into the NSS store/);
  assert.match(text, /system store.*needs root/s);
  assert.match(text, /sudo moshcode dns enable/);
  assert.ok(!h.ran.some((c) => c.startsWith("update-ca-certificates")), "and does not pretend to have run it");
});

test("an unconstrained root stops the whole trust step", async () => {
  const h = harness({ caText: "Certificate:\n  no constraints here" });
  const result = await applyTrust(["hacker"], h.out, h.deps);

  assert.equal(result.ok, false);
  assert.match(h.lines.join("\n"), /STOP|will not put an unconstrained root/);
  assert.ok(!h.ran.some((c) => c.startsWith("certutil")), "nothing is installed");
});

test("a failed store is reported as failed, not skipped over", async () => {
  const h = harness({ uid: 0, fail: "certutil" });
  await applyTrust(["hacker"], h.out, h.deps);
  assert.match(h.lines.join("\n"), /FAIL the NSS store.*— denied/);
});

test("no root yet points at what makes one, and is not a failure of enable", async () => {
  const lines = [];
  const result = await applyTrust(["hacker"], (l) => lines.push(l), {
    readFile: async () => { throw new Error("ENOENT"); },
    runner: async () => ({ ok: true, stdout: "", stderr: "" }),
    home: "/home/x", platform: "linux", uid: 0,
  });
  assert.equal(result.ok, false);
  assert.match(lines.join("\n"), /moshpit-proxy generates one/);
});

/* ------------------------------------------------- refusals say what to do */

test("a stale root is told how to be regenerated, not just refused", (t) => {
  // Permits a real Moshpit ending, just not the one claimed today. Nothing
  // dangerous — the root predates the current ending list. A refusal that only
  // says "no" is how a safety gate ends up disabled with --no-trust instead of
  // satisfied, so this one has to carry the one command that fixes it.
  const text = needRoot(t, "critical,permitted;DNS:.hacker");
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["rank"] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "out-of-step");

  const remedy = refusalRemedy(verdict.kind, "/home/x/.moshpit/ca/ca.crt").join("\n");
  assert.match(remedy, /rm -rf \/home\/x\/\.moshpit\/ca/, "names the directory to clear");
  assert.match(remedy, /moshpit-proxy/, "and what regenerates it");
});

test("a dangerous root is offered no way around the check", (t) => {
  const text = needRoot(t, "critical,excluded;DNS:.hacker");
  if (!text) return;
  const verdict = requireNameConstraints(text, { tlds: ["hacker"] });
  assert.equal(verdict.kind, "unconstrained");

  const remedy = refusalRemedy(verdict.kind, "/home/x/.moshpit/ca/ca.crt").join("\n");
  assert.match(remedy, /not overridable/);
  assert.doesNotMatch(remedy, /--no-trust/, "never advertises the opt-out as the fix");
});

test("the refusal a session prints carries its remedy", async () => {
  const h = harness({ caText: "Certificate:\n  no constraints here" });
  await applyTrust(["hacker"], h.out, h.deps);
  const text = h.lines.join("\n");
  assert.match(text, /STOP/);
  assert.match(text, /not overridable/, "the STOP line alone is not actionable");
});
