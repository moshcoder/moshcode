// The certificate authority over HTTP: what an origin script and a client see.
//
// Boots the real moshpit router against a throwaway libsql file and a CA made
// in memory, because the things worth being sure of are the wire shapes: the
// 503 when the CA is off, PEM with the right content type for the root and
// chain, a bearer key minting a leaf for its own name and not for somebody
// else's, and the issued list.
//
// Skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { X509Certificate } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
  require("@peculiar/x509");
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-ca-route-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PIT_ORIGIN = "https://pit.moshcode.sh";
delete process.env.MOSHPIT_CA_CERT;
delete process.env.MOSHPIT_CA_KEY;
delete process.env.MOSHPIT_CA_ROOT;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const moshpit = await import("../src/moshpit.mjs");
  const ca = await import("../src/lib/moshpit-ca.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','d@e.f','two',1)`);
  const mine = (await createApiKey("u1", "test")).plaintext;
  const theirs = (await createApiKey("u2", "test")).plaintext;
  assert.equal((await moshpit.registerTld({ tld: "eggs", userId: "u1" })).ok, true);
  assert.equal((await moshpit.registerName({ tld: "eggs", label: "blue", userId: "u1" })).ok, true);

  const json = (res) => res.json().then((body) => ({ status: res.status, body, headers: res.headers }));
  const issue = (body, key = mine) => fetch(`${base}/api/moshpit/tlds/eggs/certs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  }).then(json);
  const getText = (p) => fetch(`${base}${p}`).then(async (res) => ({ status: res.status, text: await res.text(), headers: res.headers }));

  return { server, db, base, mine, theirs, issue, getText, json, ca, moshpit };
}

let booted = null;
const app = () => (booted ||= boot());
const skip = !deps && "apps/pwa deps not installed";

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("with no CA configured, /api/moshpit/ca says so and issuing is 503", { skip }, async () => {
  const { base, getText, issue, ca } = await app();
  ca.resetCaForTests();
  const status = await fetch(`${base}/api/moshpit/ca`).then((r) => r.json());
  assert.deepEqual(status, { enabled: false });
  assert.equal((await getText("/api/moshpit/ca.crt")).status, 503);
  const r = await issue({ label: "blue", csr: "x" });
  assert.equal(r.status, 503);
});

test("once configured: root and chain are served as PEM, and a key mints a leaf for its own name", { skip }, async () => {
  const { base, getText, issue, ca, theirs } = await app();
  const made = await ca.generateCa({ rootName: "Route Test Root" });
  await ca.configureCa({ cert: made.issuer.cert, key: made.issuer.key, root: made.root.cert });

  const status = await fetch(`${base}/api/moshpit/ca`).then((r) => r.json());
  assert.equal(status.enabled, true);
  assert.match(status.root.subject, /Route Test Root/);
  assert.equal(status.leaf_days, 30);

  const root = await getText("/api/moshpit/ca.crt");
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type"), /x-pem-file/);
  assert.equal(new X509Certificate(root.text).fingerprint256, new X509Certificate(made.root.cert).fingerprint256);

  const chain = await getText("/api/moshpit/ca-chain.crt");
  assert.equal(chain.text.match(/BEGIN CERTIFICATE/g).length, 2);

  const { csr } = await ca.generateCsr("blue.eggs");
  const r = await issue({ label: "blue", csr });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, "blue.eggs");
  const leaf = new X509Certificate(r.body.cert);
  assert.ok(leaf.checkHost("blue.eggs"));
  assert.ok(leaf.verify(new X509Certificate(made.issuer.cert).publicKey));
  assert.equal(r.body.chain.match(/BEGIN CERTIFICATE/g).length, 3);
  assert.equal(r.body.pin_published, true);

  // Somebody else's key: refused with the ownership reason, nothing issued.
  const other = await issue({ label: "blue", csr }, theirs);
  assert.equal(other.status, 403);
  assert.match(other.body.error, /do not own/);

  // No key at all.
  const anon = await issue({ label: "blue", csr }, null);
  assert.equal(anon.status, 401);

  // The issued list is public and the certificate can be fetched back by serial.
  const list = await fetch(`${base}/api/moshpit/tlds/eggs/certs?label=blue`).then((x) => x.json());
  assert.equal(list.certs.length, 1);
  assert.equal(list.certs[0].serial, r.body.serial);
  const again = await getText(`/api/moshpit/certs/${r.body.serial}`);
  assert.equal(again.status, 200);
  assert.equal(new X509Certificate(again.text).fingerprint256, leaf.fingerprint256);

  // The pin the leaf carries is what /api/moshpit/pins now publishes.
  const pins = await fetch(`${base}/api/moshpit/pins?name=blue.eggs`).then((x) => x.json());
  assert.deepEqual(pins.pins, [r.body.pin]);
});
