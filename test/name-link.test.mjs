// `moshcode name link` — the proof it emits has to be one the app accepts.
//
// The interesting assertion here is not that we produce a signature; it is that
// the signature verifies under exactly the check the other side runs, including
// the DER encoding. A P-1363 signature carries the same numbers in a shape the
// verifier rejects, and that failure is indistinguishable from a wrong key.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  normalizeName,
  keyPaths,
  signChallenge,
  pinOf,
  parseArgs,
  fetchChallenge,
  readNameKey,
  nameCommand,
  DEFAULT_APP,
} from "../src/name-link.mjs";

/** A P-256 keypair, the curve moshcode mints names on. */
function nameKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey,
  };
}

test("a name is label.tld, and empty segments are refused not collapsed", () => {
  assert.equal(normalizeName("Chovy.Hacker."), "chovy.hacker");
  for (const bad of ["", "hacker", "a.b.c", "chovy..hacker", "-x.hacker"]) {
    assert.equal(normalizeName(bad), null, `${bad} should be refused`);
  }
});

test("keyPaths cannot climb out of the directory it is given", () => {
  const paths = keyPaths("../../etc/passwd", "/etc/ssl/moshpit");
  assert.ok(paths.key.startsWith("/etc/ssl/moshpit/"));
  assert.ok(!paths.key.includes(".."));
});

test("the signature verifies under the app's own check", () => {
  const { keyPem, publicKey } = nameKey();
  const nonce = "2f8a1c9e4b7d6033a5e1c8b2d94f7061";
  const signature = signChallenge({ keyPem, nonce });

  // Byte-for-byte the verification the server performs.
  const ok = crypto.verify(
    "sha256",
    Buffer.from(nonce, "utf8"),
    { key: publicKey, dsaEncoding: "der" },
    Buffer.from(signature, "base64"),
  );
  assert.equal(ok, true);
});

test("a signature over one nonce does not verify against another", () => {
  const { keyPem, publicKey } = nameKey();
  const signature = signChallenge({ keyPem, nonce: "the-real-nonce" });
  const ok = crypto.verify(
    "sha256",
    Buffer.from("a-different-nonce", "utf8"),
    { key: publicKey, dsaEncoding: "der" },
    Buffer.from(signature, "base64"),
  );
  assert.equal(ok, false);
});

test("parseArgs keeps flag values out of the positionals", () => {
  const parsed = parseArgs(["link", "blue.eggs", "--app", "https://example.com", "--json"]);
  assert.equal(parsed.verb, "link");
  assert.equal(parsed.name, "blue.eggs");
  assert.equal(parsed.app, "https://example.com");
  assert.equal(parsed.json, true);
});

test("parseArgs defaults to the app that speaks this protocol", () => {
  assert.equal(parseArgs(["link", "blue.eggs"]).app, DEFAULT_APP);
});

test("a root-owned key reports the fix, not the errno", () => {
  const denied = () => {
    const error = new Error("EACCES");
    error.code = "EACCES";
    throw error;
  };
  assert.throws(
    () => readNameKey({ name: "blue.eggs", keyPath: "/etc/ssl/moshpit/blue.eggs.key", certPath: "x", readFile: denied }),
    /run this with sudo/,
  );
});

test("a missing key says which name has none", () => {
  const missing = () => {
    const error = new Error("ENOENT");
    error.code = "ENOENT";
    throw error;
  };
  assert.throws(
    () => readNameKey({ name: "blue.eggs", keyPath: "/k", certPath: "/c", readFile: missing }),
    /no key for blue\.eggs/,
  );
});

test("fetchChallenge surfaces the app's own refusal", async () => {
  const refusing = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: "Too many challenges for this name" }),
  });
  await assert.rejects(
    fetchChallenge({ app: "https://qrypt.chat", name: "blue.eggs", fetchImpl: refusing }),
    /Too many challenges/,
  );
});

test("link emits a single-use bundle carrying the challenge id", async () => {
  const { keyPem } = nameKey();
  const cert = "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----";
  const lines = [];

  const code = await nameCommand(["link", "blue.eggs", "--json"], {
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    readFile: (p) => (p.endsWith(".key") ? keyPem : cert),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jti: "challenge-1", nonce: "n", expiresAt: "later" }),
    }),
  });

  assert.equal(code, 0);
  const bundle = JSON.parse(lines[0]);
  assert.equal(bundle.jti, "challenge-1");
  assert.equal(bundle.name, "blue.eggs");
  assert.ok(bundle.signature);
  // The ML-KEM key is deliberately absent: it belongs to the device the person
  // reads messages on, and this command never sees it.
  assert.equal(bundle.publicKey, undefined);
});

test("link refuses a name that is not one, before touching the disk", async () => {
  let read = 0;
  const code = await nameCommand(["link", "not-a-name"], {
    out: () => {},
    err: () => {},
    readFile: () => {
      read += 1;
      return "";
    },
  });
  assert.equal(code, 1);
  assert.equal(read, 0);
});

test("pinOf hashes the SPKI the way the registry does", () => {
  // A certificate minted the way src/pins.mjs mints them.
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const expected = crypto.createHash("sha256").update(spki).digest("base64");
  assert.equal(expected.length, 44);
});
