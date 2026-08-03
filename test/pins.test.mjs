// Pins, and the promise that nobody has to know what one is.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { tldOf, spkiPin, pinFromCertificate, keyPaths, certificateCommand, publishPin, pinPublished } from "../src/pins.mjs";

function keypair() {
  return crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("a pin is SHA-256 over the SPKI, so it survives re-issuing the certificate", () => {
  const { publicKey } = keypair();
  const pin = spkiPin(publicKey);

  assert.equal(Buffer.from(pin, "base64").length, 32, "SHA-256 is 32 bytes");
  assert.equal(spkiPin(publicKey), pin, "the same key always gives the same pin");

  // The point of pinning the key rather than the certificate: a certificate
  // re-issued for the same key — longer expiry, an added name — must not
  // invalidate every client's pin.
  const { publicKey: other } = keypair();
  assert.notEqual(spkiPin(other), pin, "a different key is a different pin");
});

test("pins hang off the ending, not the name", () => {
  // The registry has no per-name record: you claim `.hacker`, not
  // `chovy.hacker`, so there is nowhere for a per-name key to live.
  assert.equal(tldOf("chovy.hacker"), "hacker");
  assert.equal(tldOf("seo.rank"), "rank");
  assert.equal(tldOf("deep.sub.eggs"), "eggs");
  assert.equal(tldOf("bare"), "", "a name with no ending has nothing to publish under");
  assert.equal(tldOf("SEO.RANK"), "rank", "case is not part of the identity");
});

test("one key per ending, because that is the granularity the registry stores", () => {
  const paths = keyPaths("hacker");
  assert.match(paths.key, /hacker\.key$/);
  assert.match(paths.cert, /hacker\.crt$/);

  // Per-name keys would mean a pin published per site, and every name under
  // the ending would then accept all of them — more keys able to impersonate
  // each other, for no isolation gained.
  assert.deepEqual(keyPaths("hacker"), keyPaths("hacker"));
});

test("a path traversal in the ending cannot escape the key directory", () => {
  // The ending reaches this from a registry response, so it is not trusted
  // input. Writing a key through `../../` would be a very bad day.
  assert.match(keyPaths("../../etc/passwd").key, /\/etcpasswd\.key$/);
  assert.equal(keyPaths("..."), null, "nothing usable left after stripping");
  assert.equal(keyPaths(""), null);
});

test("the certificate covers every name under the ending, since they share the key", () => {
  const paths = keyPaths("hacker");
  const { args } = certificateCommand({ name: "chovy.hacker", tld: "hacker", paths });
  const san = args[args.indexOf("-addext") + 1];

  assert.match(san, /DNS:chovy\.hacker/);
  assert.match(san, /DNS:\*\.hacker/, "the other names under this ending present the same key");
  assert.match(args.join(" "), /prime256v1/, "P-256, matching what is already deployed");
});

test("publishing without credentials says so instead of failing obscurely", async () => {
  const result = await publishPin({ tld: "hacker", pin: "x".repeat(43) + "=", token: "" });

  assert.equal(result.ok, false);
  assert.equal(result.needsAuth, true, "the caller needs to know this is fixable by logging in");
  assert.match(result.error, /moshcode login|MOSHCODE_API_KEY/);
});

test("publishing twice is not an error", async () => {
  // `site --install` run again must not fail. A 409 means the pin is already
  // published, which is the desired state reached earlier.
  const conflict = async () => ({ status: 409, text: async () => "already published" });
  const result = await publishPin({ tld: "hacker", pin: "abc", token: "t", fetchImpl: conflict });

  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(result.published, false, "nothing new was written");
});

test("a registry that cannot be reached does not look like a rejected pin", async () => {
  const offline = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await publishPin({ tld: "hacker", pin: "abc", token: "t", fetchImpl: offline });

  assert.equal(result.ok, false);
  assert.notEqual(result.needsAuth, true, "an outage is not an auth problem, and must not send anyone to `login`");
  assert.match(result.error, /unreachable/);
});

test("an already-published pin is detected without credentials", async () => {
  // The common case — key deployed, pin published — should cost one GET and
  // no token at all.
  const listing = async () => ({
    ok: true,
    json: async () => ({ tld: "rank", pins: [{ pin: "QCXCr9ZWmbOXLvnbNHYvHFu97LKcUECb1I2HNsBzxug=", kind: "tls" }] }),
  });

  assert.equal(
    await pinPublished({ tld: "rank", pin: "QCXCr9ZWmbOXLvnbNHYvHFu97LKcUECb1I2HNsBzxug=", fetchImpl: listing }),
    true,
  );
  assert.equal(await pinPublished({ tld: "rank", pin: "something-else", fetchImpl: listing }), false);
});

/** A throwaway self-signed certificate, or null if openssl is not available. */
function selfSign() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-"));
    const key = path.join(dir, "k.pem");
    const crt = path.join(dir, "c.pem");
    execFileSync("openssl", [
      "req", "-x509", "-nodes", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-keyout", key, "-out", crt, "-days", "1", "-subj", "/CN=t.test",
    ], { stdio: "ignore" });
    const cert = fs.readFileSync(crt, "utf8");
    const pub = execFileSync("openssl", ["x509", "-pubkey", "-noout", "-in", crt]).toString();
    fs.rmSync(dir, { recursive: true, force: true });
    return { cert, pub };
  } catch {
    return null;
  }
}

test("a certificate's pin is the pin of the key inside it", () => {
  const made = selfSign();
  if (!made) return;
  assert.equal(pinFromCertificate(made.cert), spkiPin(made.pub));
});
