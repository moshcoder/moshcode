// Fetching a Moshpit origin over TLS, authenticated by a published pin.
//
// A Moshpit ending is outside the DNS root, so no CA will issue for it and the
// origin's certificate is necessarily self-signed. The pin replaces the chain:
// it names one exact public key, published by the name's owner in the registry.
//
// The origin redirecting to HTTPS is the ordinary case — the nginx block the
// setup script writes does exactly that — and forwarding that redirect to a
// browser is useless, since the browser can neither resolve the name nor
// validate the certificate. So the gateway follows it and checks the pin.
//
// Uses a real self-signed certificate and a real TLS handshake, generated per
// run rather than committed, so there is no private key in the tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { fetchOriginTls, pinFromCertificate, tlsRedirect } from "../src/lib/moshpit-gateway.mjs";

let openssl = true;
try { execFileSync("openssl", ["version"], { stdio: "ignore" }); } catch { openssl = false; }
const skip = !openssl && "openssl not available";

const workdir = mkdtempSync(path.join(tmpdir(), "moshpit-tls-test-"));
test.after(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });

// A self-signed certificate for a Moshpit name, exactly as setup-origin.sh
// produces one, plus the pin as the *shell one-liner* computes it. Comparing
// against openssl rather than against our own function is the point: a pin only
// works if both ends independently agree on the string.
function selfSigned(name) {
  const key = path.join(workdir, `${name}.key`);
  const crt = path.join(workdir, `${name}.crt`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", key, "-out", crt, "-days", "1", "-subj", `/CN=${name}`,
  ], { stdio: "ignore" });

  const pubkey = execFileSync("openssl", ["x509", "-in", crt, "-pubkey", "-noout"]);
  const der = execFileSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: pubkey });
  const digest = execFileSync("openssl", ["dgst", "-sha256", "-binary"], { input: der });
  const pin = execFileSync("openssl", ["enc", "-base64"], { input: digest }).toString().trim();

  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), pin, crtPath: crt };
}

async function tlsOrigin(material) {
  const seen = [];
  const server = https.createServer({ key: material.key, cert: material.cert }, (req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>the actual site</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, port: server.address().port };
}

const call = (port, pins, extra = {}) => fetchOriginTls({
  host: "127.0.0.1", port, servername: "chovy.hacker", path: "/",
  headers: { host: "chovy.hacker" }, pins, timeoutMs: 5000, maxBytes: 1_000_000, ...extra,
});

test("our pin is the one openssl prints", { skip }, () => {
  const material = selfSigned("chovy.hacker");
  const ours = pinFromCertificate(new X509Certificate(material.cert));
  assert.equal(ours, material.pin,
    "a pin only works if the registry and the operator compute the same string");
  assert.match(ours, /^[A-Za-z0-9+/]{43}=$/, "base64 of a SHA-256, RFC 7469 style");
});

test("a matching pin serves the site over a self-signed certificate", { skip }, async () => {
  const material = selfSigned("chovy.hacker");
  const { server, seen, port } = await tlsOrigin(material);
  try {
    const res = await call(port, [material.pin]);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "<h1>the actual site</h1>",
      "a certificate no CA would sign is fine — the pin is the authentication");
    assert.equal(seen[0].host, "chovy.hacker", "and the origin is still asked for the name");
  } finally { server.close(); }
});

test("a wrong pin is refused before the request is sent", { skip }, async () => {
  const material = selfSigned("chovy.hacker");
  const impostor = selfSigned("impostor");
  const { server, seen, port } = await tlsOrigin(material);
  try {
    await assert.rejects(() => call(port, [impostor.pin]), (e) => e.name === "PinError");
    assert.deepEqual(seen, [],
      "the request must never reach a key we did not expect — checked on secureConnect, not on the response");
  } finally { server.close(); }
});

test("no published pin is its own error, not a generic failure", { skip }, async () => {
  const material = selfSigned("chovy.hacker");
  const { server, port } = await tlsOrigin(material);
  try {
    await assert.rejects(() => call(port, []), (e) => e.name === "NoPinError");
    await assert.rejects(() => call(port, undefined), (e) => e.name === "NoPinError");
  } finally { server.close(); }
});

test("one of several published pins is enough", { skip }, async () => {
  const material = selfSigned("chovy.hacker");
  const other = selfSigned("rotating");
  const { server, port } = await tlsOrigin(material);
  try {
    // Publishing the next key before cutting over is how a rotation happens
    // without an outage.
    const res = await call(port, [other.pin, material.pin]);
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

// ---- which redirects may be followed ----

const FOR = { name: "chovy.hacker", host: "dev.profullstack.com" };

test("an upgrade to HTTPS on the same name is followed", () => {
  assert.deepEqual(tlsRedirect("https://chovy.hacker/", FOR), { port: 443, path: "/" });
  assert.deepEqual(tlsRedirect("https://chovy.hacker/a/b?c=1", FOR), { port: 443, path: "/a/b?c=1" });
  assert.deepEqual(tlsRedirect("https://chovy.hacker:8443/", FOR), { port: 8443, path: "/" });
  assert.deepEqual(tlsRedirect("https://CHOVY.HACKER/", FOR), { port: 443, path: "/" },
    "hostnames are case-insensitive");
  assert.deepEqual(tlsRedirect("https://dev.profullstack.com/", FOR), { port: 443, path: "/" },
    "the target's own hostname counts as the same place");
});

test("a redirect anywhere else is not followed", () => {
  // The redirect is written by whoever claimed the name. Following it to a new
  // host would re-open the SSRF hole checkTarget() exists to close — after the
  // check has already passed.
  assert.equal(tlsRedirect("https://169.254.169.254/latest/meta-data/", FOR), null,
    "cloud metadata is the reason this restriction exists");
  assert.equal(tlsRedirect("https://evil.example/", FOR), null);
  assert.equal(tlsRedirect("http://chovy.hacker/", FOR), null, "plaintext is not an upgrade");
  assert.equal(tlsRedirect("/somewhere", FOR), null, "a relative Location has no host to check");
  assert.equal(tlsRedirect("", FOR), null);
  assert.equal(tlsRedirect(undefined, FOR), null);
  assert.equal(tlsRedirect("https://chovy.hacker.evil.example/", FOR), null,
    "a suffix of the name is not the name");
});
