// The Moshpit certificate authority, against a real (throwaway) libSQL database
// and a CA generated in memory.
//
// What is worth checking is what a browser will check: that a leaf chains to
// the root, names the right host and nothing else, is not a CA, and that only
// the person who controls the name can obtain one -- including the resale
// case, where the ending's owner must not get a certificate for a name they
// sold, and the lease case, where the tenant may and the holder may not.
//
// Skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { X509Certificate } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); require("@peculiar/x509"); } catch { installed = false; }

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-ca-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice"; // owns .eggs and blue.eggs
const BOB = "user-bob";     // bought red.eggs
const DAY = 24 * 60 * 60 * 1000;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  return {
    moshpit: await import("../src/moshpit.mjs"),
    ca: await import("../src/lib/moshpit-ca.mjs"),
    certs: await import("../src/lib/moshpit-certs.mjs"),
    run,
  };
}

test("moshpit certificate authority", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { moshpit, ca, certs, run } = await boot();

  const generated = await ca.generateCa({ rootName: "Test Root", issuerName: "Test Issuer" });
  const root = new X509Certificate(generated.root.cert);
  const issuer = new X509Certificate(generated.issuer.cert);

  await t.test("the generated CA is a real chain", () => {
    assert.equal(root.ca, true);
    assert.equal(issuer.ca, true);
    assert.ok(issuer.verify(root.publicKey), "issuer is signed by the root");
    assert.ok(root.verify(root.publicKey), "root is self-signed");
    assert.match(issuer.issuer, /Test Root/);
  });

  await t.test("the CA refuses a key that does not match its certificate", async () => {
    const other = await ca.generateCa();
    await assert.rejects(
      ca.configureCa({ cert: generated.issuer.cert, key: other.issuer.key, root: generated.root.cert }),
      /does not match/,
    );
  });

  await t.test("nothing is signed while the CA is not configured", async () => {
    ca.resetCaForTests();
    delete process.env.MOSHPIT_CA_CERT;
    const r = await ca.issueLeaf({ tld: "eggs", label: "blue", csr: "" });
    assert.equal(r.status, 503);
  });

  await ca.configureCa({ cert: generated.issuer.cert, key: generated.issuer.key, root: generated.root.cert, leafDays: 30 });

  assert.equal((await moshpit.registerTld({ tld: "eggs", userId: ALICE })).ok, true);
  assert.equal((await moshpit.registerName({ tld: "eggs", label: "blue", userId: ALICE })).ok, true);
  assert.equal((await moshpit.registerName({ tld: "eggs", label: "red", userId: ALICE })).ok, true);
  // red.eggs is sold to Bob: the row's holder changes, the ending stays Alice's.
  await run(`UPDATE moshpit_names SET user_id = ? WHERE tld = 'eggs' AND label = 'red'`, [BOB]);

  let blueLeaf;
  await t.test("the holder gets a leaf that a browser would accept", async () => {
    const { csr } = await ca.generateCsr("blue.eggs");
    const r = await certs.issueNameCertificate({ tld: "eggs", label: "blue", userId: ALICE, csr });
    assert.equal(r.ok, true, r.error);
    blueLeaf = new X509Certificate(r.cert);
    assert.equal(blueLeaf.ca, false, "a leaf, never a CA");
    assert.ok(blueLeaf.verify(issuer.publicKey), "signed by the issuing CA");
    assert.equal(blueLeaf.subject, "CN=blue.eggs");
    assert.ok(blueLeaf.checkHost("blue.eggs"), "names the host");
    assert.ok(blueLeaf.checkHost("www.blue.eggs"), "and everything under it");
    assert.equal(blueLeaf.checkHost("red.eggs"), undefined, "and nothing else");
    assert.match(blueLeaf.keyUsage.join(","), /1\.3\.6\.1\.5\.5\.7\.3\.1/, "serverAuth");
    const days = (new Date(blueLeaf.validTo).getTime() - new Date(blueLeaf.validFrom).getTime()) / DAY;
    assert.ok(days > 29 && days < 31.1, `short-lived, got ${days} days`);
    // The chain the origin serves: leaf, issuer, root, in that order.
    const pems = r.chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    assert.equal(pems.length, 3);
    assert.equal(new X509Certificate(pems[1]).fingerprint256, issuer.fingerprint256);
    assert.equal(new X509Certificate(pems[2]).fingerprint256, root.fingerprint256);
  });

  await t.test("the leaf's key is published as a pin, so pin clients keep working", async () => {
    const pins = await moshpit.listPins("eggs", "blue", "tls");
    assert.equal(pins.length, 1);
    assert.equal(pins[0].pin, ca.pinOf(new (await import("@peculiar/x509")).X509Certificate(blueLeaf.raw)));
    assert.equal(pins[0].note, "moshpit-ca");
  });

  await t.test("the CSR's own subject never decides the name", async () => {
    const { csr } = await ca.generateCsr("red.eggs"); // Alice asks for blue but the CSR says red
    const r = await certs.issueNameCertificate({ tld: "eggs", label: "blue", userId: ALICE, csr });
    assert.equal(r.ok, true, r.error);
    const leaf = new X509Certificate(r.cert);
    assert.equal(leaf.subject, "CN=blue.eggs");
    assert.equal(leaf.checkHost("red.eggs"), undefined);
  });

  await t.test("the ending's owner cannot get a certificate for a name they sold", async () => {
    const { csr } = await ca.generateCsr("red.eggs");
    const r = await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: ALICE, csr });
    assert.equal(r.ok, false);
    assert.match(r.error, /do not own red\.eggs/);
    assert.equal(r.status, 403);
  });

  await t.test("the buyer can", async () => {
    const { csr } = await ca.generateCsr("red.eggs");
    const r = await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: BOB, csr });
    assert.equal(r.ok, true, r.error);
    assert.ok(new X509Certificate(r.cert).checkHost("red.eggs"));
  });

  await t.test("during a lease the tenant may and the holder may not", async () => {
    await run(`UPDATE moshpit_names SET leased_to = ?, leased_until = ? WHERE tld = 'eggs' AND label = 'blue'`, [BOB, Date.now() + 30 * DAY]);
    const { csr } = await ca.generateCsr("blue.eggs");
    const holder = await certs.issueNameCertificate({ tld: "eggs", label: "blue", userId: ALICE, csr });
    assert.equal(holder.ok, false);
    assert.match(holder.error, /leased until/);
    const tenant = await certs.issueNameCertificate({ tld: "eggs", label: "blue", userId: BOB, csr });
    assert.equal(tenant.ok, true, tenant.error);
    await run(`UPDATE moshpit_names SET leased_to = NULL, leased_until = NULL WHERE tld = 'eggs' AND label = 'blue'`);
  });

  await t.test("a real top-level domain is never signed, whatever the registry says", async () => {
    const r = await ca.issueLeaf({ tld: "com", label: "google", csr: (await ca.generateCsr("google.com")).csr });
    assert.equal(r.status, 400);
    assert.match(r.error, /real top-level domain/);
  });

  await t.test("a CSR that does not verify, or is not a CSR, is refused", async () => {
    const bad = await ca.issueLeaf({ tld: "eggs", label: "blue", csr: "-----BEGIN CERTIFICATE REQUEST-----\nnope\n-----END CERTIFICATE REQUEST-----" });
    assert.equal(bad.status, 400);
    const { csr } = await ca.generateCsr("blue.eggs");
    const tampered = csr.replace(/A/g, "B");
    const t2 = await ca.issueLeaf({ tld: "eggs", label: "blue", csr: tampered });
    assert.equal(t2.status, 400);
  });

  await t.test("an unregistered name gets nothing", async () => {
    const { csr } = await ca.generateCsr("nobody.eggs");
    const r = await certs.issueNameCertificate({ tld: "eggs", label: "nobody", userId: ALICE, csr });
    assert.equal(r.ok, false);
    assert.match(r.error, /not registered/);
  });

  await t.test("issuance is recorded and listable", async () => {
    const list = await certs.listNameCertificates("eggs", "blue");
    assert.ok(list.length >= 2);
    assert.equal(list[0].expired, false);
    const one = await certs.getNameCertificate(list[0].serial);
    assert.match(one.cert, /BEGIN CERTIFICATE/);
  });

  await t.test("a runaway renewal loop is stopped", async () => {
    const { csr } = await ca.generateCsr("red.eggs");
    let last;
    for (let i = 0; i < certs.MAX_CERTS_PER_DAY + 1; i++) {
      last = await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: BOB, csr });
      if (!last.ok) break;
    }
    assert.equal(last.ok, false);
    assert.equal(last.status, 429);
  });

  await t.test("the material a client installs is the root, and the chain is issuer then root", async () => {
    const m = await ca.caMaterial();
    assert.equal(new X509Certificate(m.root).fingerprint256, root.fingerprint256);
    assert.match(m.rootSubject, /Test Root/);
    assert.equal(m.rootFingerprint, root.fingerprint256);
    const pems = m.chain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    assert.equal(pems.length, 2);
  });
});
