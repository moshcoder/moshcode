/**
 * Trusting the registry's root: the check that decides whether what the
 * registry served is the root it says it is, the plan of stores it goes into,
 * and the apply/remove paths with every side effect injected.
 *
 * The root is made with openssl here, the same way trust.test.mjs makes its
 * roots; the tests skip when openssl is missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";

import {
  REGISTRY_ROOT_NICKNAME, REGISTRY_ROOT_SYSTEM_FILE, applyRegistryTrust, checkRegistryRoot,
  fetchRegistryRoot, registryRootPath, registryTrustPlan, removeRegistryTrust, trustStores, untrustPlan,
} from "../src/trust.mjs";

function haveOpenssl() {
  try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}

/** A self-signed certificate: a CA root, or a plain leaf, as asked. */
function makeCert({ ca = true, cn = "Test Root" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moshcode-registry-root-"));
  const key = path.join(dir, "k.pem");
  const crt = path.join(dir, "c.pem");
  const args = ["req", "-x509", "-new", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-sha256", "-days", "30", "-subj", `/CN=${cn}`, "-keyout", key, "-out", crt,
    "-addext", `basicConstraints=critical,CA:${ca ? "TRUE" : "FALSE"}`];
  execFileSync("openssl", args, { stdio: "ignore" });
  const pem = fs.readFileSync(crt, "utf8");
  fs.rmSync(dir, { recursive: true, force: true });
  return pem;
}

const skip = haveOpenssl() ? false : "openssl not installed";

test("a self-signed CA:TRUE root whose fingerprint matches is accepted", { skip }, () => {
  const pem = makeCert();
  const fp = new X509Certificate(pem).fingerprint256;
  const r = checkRegistryRoot(pem, { fingerprint: fp });
  assert.equal(r.ok, true, r.why);
  assert.match(r.subject, /Test Root/);
  // Fingerprint compared without regard to colons or case.
  assert.equal(checkRegistryRoot(pem, { fingerprint: fp.replace(/:/g, "").toLowerCase() }).ok, true);
});

test("a fingerprint that does not match is refused", { skip }, () => {
  const pem = makeCert();
  const r = checkRegistryRoot(pem, { fingerprint: "00".repeat(32) });
  assert.equal(r.ok, false);
  assert.match(r.why, /does not match/);
});

test("a leaf is refused as a root, and so is garbage", { skip }, () => {
  assert.match(checkRegistryRoot(makeCert({ ca: false })).why, /CA:TRUE/);
  assert.match(checkRegistryRoot("not a certificate").why, /not a certificate/);
});

test("trustStores takes a nickname and a system file, and defaults to the local CA's", () => {
  const local = trustStores({ platform: "linux", home: "/home/x", caFile: "/tmp/a.crt" });
  assert.ok(local.find((s) => s.id === "nss").args.includes("Moshpit Local CA"));
  assert.equal(local.find((s) => s.id === "system").copyTo, "/usr/local/share/ca-certificates/moshpit-local-ca.crt");

  const registry = trustStores({ platform: "linux", home: "/home/x", caFile: "/tmp/r.crt",
    nickname: REGISTRY_ROOT_NICKNAME, systemFile: REGISTRY_ROOT_SYSTEM_FILE });
  assert.ok(registry.find((s) => s.id === "nss").args.includes("Moshpit Root CA"));
  assert.equal(registry.find((s) => s.id === "system").copyTo, "/usr/local/share/ca-certificates/moshpit-root-ca.crt");
  assert.deepEqual(registry.find((s) => s.id === "nss").remove.args.slice(-2), ["-n", "Moshpit Root CA"]);
});

test("registryTrustPlan: NSS without root, the system store only as root, neither without certutil", () => {
  const user = registryTrustPlan({ platform: "linux", home: "/home/x", file: "/f", isRoot: false, haveCertutil: true });
  assert.deepEqual(user.steps.map((s) => s.id), ["nss"]);
  assert.deepEqual(user.skipped.map((s) => s.id), ["system"]);
  const root = registryTrustPlan({ platform: "linux", home: "/home/x", file: "/f", isRoot: true, haveCertutil: true });
  assert.deepEqual(root.steps.map((s) => s.id), ["nss", "system"]);
  const bare = registryTrustPlan({ platform: "linux", home: "/home/x", file: "/f", isRoot: false, haveCertutil: false });
  assert.deepEqual(bare.steps, []);
  assert.deepEqual(bare.skipped.map((s) => s.id), ["nss", "system"]);
});

test("untrustPlan honours the registry nickname and system file", () => {
  const p = untrustPlan({ platform: "linux", home: "/home/x", caFile: "/f", isRoot: true,
    nickname: REGISTRY_ROOT_NICKNAME, systemFile: REGISTRY_ROOT_SYSTEM_FILE });
  assert.equal(p.steps.find((s) => s.id === "system").remove.removeFile, "/usr/local/share/ca-certificates/moshpit-root-ca.crt");
  assert.ok(p.steps.find((s) => s.id === "nss").remove.args.includes("Moshpit Root CA"));
});

/** A fetch that answers the two registry endpoints from memory. */
function fakeRegistry({ enabled = true, pem = "", fingerprint = null }) {
  return async (url) => {
    if (url.endsWith("/api/moshpit/ca")) {
      return { ok: true, status: 200, json: async () => (enabled ? { enabled: true, root: { fingerprint_sha256: fingerprint, subject: "CN=Test Root" } } : { enabled: false }) };
    }
    if (url.endsWith("/api/moshpit/ca.crt")) return { ok: true, status: 200, text: async () => pem };
    return { ok: false, status: 404 };
  };
}

test("fetchRegistryRoot reports a registry without a CA, and the root of one with", { skip }, async () => {
  const pem = makeCert();
  const fp = new X509Certificate(pem).fingerprint256;
  assert.deepEqual(await fetchRegistryRoot({ fetchImpl: fakeRegistry({ enabled: false }) }), { enabled: false });
  const got = await fetchRegistryRoot({ fetchImpl: fakeRegistry({ pem, fingerprint: fp }) });
  assert.equal(got.enabled, true);
  assert.equal(got.pem, pem);
  assert.equal(got.fingerprint, fp);
});

test("applyRegistryTrust writes the root and installs it, with every command visible", { skip }, async () => {
  const pem = makeCert();
  const fp = new X509Certificate(pem).fingerprint256;
  const calls = [];
  const written = {};
  const lines = [];
  const runner = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, stdout: "", stderr: "" }; };
  const r = await applyRegistryTrust((l) => lines.push(l), {
    runner, env: { SUDO_USER: "alice" }, home: "/home/alice", platform: "linux", uid: 0,
    fetchImpl: fakeRegistry({ pem, fingerprint: fp }),
    writeFile: async (f, body) => { written[f] = body; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.installed, 2);
  const file = registryRootPath({ home: "/home/alice" });
  assert.equal(written[file], pem, "the root is written where dns disable will look for it");
  assert.ok(calls.some((c) => c[0] === "certutil" && c.includes("-A") && c.includes("Moshpit Root CA")), "NSS import");
  assert.ok(calls.some((c) => c[0] === "cp" && c[2] === "/usr/local/share/ca-certificates/moshpit-root-ca.crt"), "system copy");
  assert.ok(calls.some((c) => c[0] === "update-ca-certificates"), "system refresh");
  assert.ok(calls.some((c) => c[0] === "chown" && c.at(-1) === "/home/alice/.pki/nssdb"), "the operator gets their database back");
  assert.ok(lines.some((l) => /installed into the NSS store/.test(l)));
});

test("applyRegistryTrust refuses a root that does not match the registry's fingerprint, and installs nothing", { skip }, async () => {
  const pem = makeCert();
  const calls = [];
  const lines = [];
  const r = await applyRegistryTrust((l) => lines.push(l), {
    runner: async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, stdout: "", stderr: "" }; },
    env: {}, home: "/home/alice", platform: "linux", uid: 1000,
    fetchImpl: fakeRegistry({ pem, fingerprint: "00".repeat(32) }),
    writeFile: async () => { throw new Error("must not be called"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.ok(lines.some((l) => /STOP/.test(l)));
  assert.equal(calls.filter((c) => c[0] === "certutil").length, 0);
});

test("applyRegistryTrust says so when the registry has no CA, or cannot be reached", { skip }, async () => {
  const lines = [];
  const quiet = async () => ({ ok: true, stdout: "", stderr: "" });
  const none = await applyRegistryTrust((l) => lines.push(l), { runner: quiet, env: {}, home: "/h", platform: "linux", uid: 1000, fetchImpl: fakeRegistry({ enabled: false }) });
  assert.equal(none.ok, false);
  assert.ok(lines.some((l) => /publishes no root yet/.test(l)));
  const down = await applyRegistryTrust((l) => lines.push(l), { runner: quiet, env: {}, home: "/h", platform: "linux", uid: 1000, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.ok, false);
  assert.ok(lines.some((l) => /could not reach the registry/.test(l)));
});

test("removeRegistryTrust takes the root out of both stores and deletes the file", async () => {
  const calls = [];
  const lines = [];
  const r = await removeRegistryTrust((l) => lines.push(l), {
    runner: async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, stdout: "", stderr: "" }; },
    env: {}, home: "/home/alice", platform: "linux", uid: 0,
    readFile: async () => "PEM",
  });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  assert.ok(calls.some((c) => c[0] === "certutil" && c.includes("-D") && c.includes("Moshpit Root CA")));
  assert.ok(calls.some((c) => c[0] === "rm" && c[2] === "/usr/local/share/ca-certificates/moshpit-root-ca.crt"));
  assert.ok(calls.some((c) => c[0] === "rm" && c[2] === registryRootPath({ home: "/home/alice" })));
});
