// Pointing a Moshpit name at a c0mpute site, against a real (throwaway) libSQL
// database and a CA generated in memory.
//
// What matters: the site id is validated and stored; a resolver is told the
// edge's hostname only while an edge is configured (so nothing changes for
// anyone until it is); a target set later takes the name back; and the CA signs
// for the edge only while the holder has the name pointed at c0mpute.
//
// Skips cleanly when the PWA dependencies are not installed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { X509Certificate } from "node:crypto";
import test from "node:test";

import {
  c0mputeEdgeHost,
  c0mputeEdgeUsers,
  effectiveC0mputeTarget,
  normalizeC0mputeSite,
} from "../src/lib/moshpit-c0mpute.mjs";

const require = createRequire(import.meta.url);
let installed = true;
try { require("@libsql/client"); require("@peculiar/x509"); } catch { installed = false; }

const SITE = "0123456789abcdef0123";
const OTHER = "fedcba9876543210fedc";

test("c0mpute site ids are validated, in the forms people paste", () => {
  assert.equal(normalizeC0mputeSite(SITE), SITE);
  assert.equal(normalizeC0mputeSite(SITE.toUpperCase()), SITE);
  assert.equal(normalizeC0mputeSite(` site=${SITE} `), SITE, "the TXT form");
  assert.equal(normalizeC0mputeSite(`http://gw.example:7777/s/${SITE}/`), SITE, "a gateway URL");
  assert.equal(normalizeC0mputeSite(`http://gw.example:7777/s/${SITE}`), SITE);
  assert.equal(normalizeC0mputeSite(""), "", "empty clears");
  assert.equal(normalizeC0mputeSite(null), "");
  assert.equal(normalizeC0mputeSite("off"), "");
  assert.equal(normalizeC0mputeSite("0123"), null, "too short");
  assert.equal(normalizeC0mputeSite(`${SITE}00`), null, "too long");
  assert.equal(normalizeC0mputeSite("g123456789abcdef0123"), null, "not hex");
  assert.equal(normalizeC0mputeSite("../../etc/passwd"), null);
});

test("the edge is a hostname or nothing", () => {
  assert.equal(c0mputeEdgeHost({}), null);
  assert.equal(c0mputeEdgeHost({ MOSHPIT_C0MPUTE_EDGE: "Edge.Moshcode.sh." }), "edge.moshcode.sh");
  assert.equal(c0mputeEdgeHost({ MOSHPIT_C0MPUTE_EDGE: "https://edge.moshcode.sh" }), null, "no scheme");
  assert.equal(c0mputeEdgeHost({ MOSHPIT_C0MPUTE_EDGE: "edge" }), null, "a bare label resolves nowhere");
  assert.deepEqual([...c0mputeEdgeUsers({ MOSHPIT_C0MPUTE_EDGE_USERS: "u1, u2  u3" })], ["u1", "u2", "u3"]);
  assert.equal(c0mputeEdgeUsers({}).size, 0);
});

test("a site wins over a target only while an edge is configured", () => {
  const env = { MOSHPIT_C0MPUTE_EDGE: "edge.moshcode.sh" };
  assert.equal(effectiveC0mputeTarget({ target: "box.example.com", site: SITE }, env), "edge.moshcode.sh");
  assert.equal(effectiveC0mputeTarget({ target: null, site: SITE }, env), "edge.moshcode.sh");
  assert.equal(effectiveC0mputeTarget({ target: "box.example.com", site: null }, env), "box.example.com");
  assert.equal(effectiveC0mputeTarget({ target: "box.example.com", site: SITE }, {}), "box.example.com");
  assert.equal(effectiveC0mputeTarget({ target: null, site: SITE }, {}), null);
});

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-c0mpute-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const ALICE = "user-alice"; // owns .eggs, blue.eggs, red.eggs
const BOB = "user-bob";     // stranger
const EDGE = "user-edge";   // the c0mpute edge's account

test("names pointed at c0mpute", { skip: installed ? false : "pwa dependencies not installed" }, async (t) => {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run } = await import("../src/db.mjs");
  for (const [id, email] of [[ALICE, "alice@example.com"], [BOB, "bob@example.com"], [EDGE, "edge@example.com"]]) {
    await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?,?,?)`, [id, email, Date.now()]);
  }
  const m = await import("../src/moshpit.mjs");
  const ca = await import("../src/lib/moshpit-ca.mjs");
  const certs = await import("../src/lib/moshpit-certs.mjs");

  assert.equal((await m.registerTld({ tld: "eggs", userId: ALICE })).ok, true);
  assert.equal((await m.registerName({ tld: "eggs", label: "blue", userId: ALICE, target: "box.example.com" })).ok, true);
  assert.equal((await m.registerName({ tld: "eggs", label: "red", userId: ALICE })).ok, true);

  const saved = { edge: process.env.MOSHPIT_C0MPUTE_EDGE, users: process.env.MOSHPIT_C0MPUTE_EDGE_USERS };
  t.after(() => {
    for (const [k, v] of [["MOSHPIT_C0MPUTE_EDGE", saved.edge], ["MOSHPIT_C0MPUTE_EDGE_USERS", saved.users]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  delete process.env.MOSHPIT_C0MPUTE_EDGE;
  delete process.env.MOSHPIT_C0MPUTE_EDGE_USERS;

  await t.test("only the holder may set it, and only to a site id", async () => {
    assert.equal((await m.setNameC0mpute({ tld: "eggs", label: "blue", userId: BOB, site: SITE })).ok, false);
    const badId = await m.setNameC0mpute({ tld: "eggs", label: "blue", userId: ALICE, site: "nope" });
    assert.equal(badId.ok, false);
    assert.match(badId.error, /20 hex/);
    const r = await m.setNameC0mpute({ tld: "eggs", label: "blue", userId: ALICE, site: `site=${SITE}` });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.site, SITE);
  });

  await t.test("with no edge configured, resolvers see exactly what they saw before", async () => {
    const res = await m.resolveMoshpitName("blue.eggs");
    assert.equal(res.target, "box.example.com");
    assert.equal(res.c0mpute, SITE);
  });

  await t.test("with an edge configured, the name resolves to it", async () => {
    process.env.MOSHPIT_C0MPUTE_EDGE = "edge.moshcode.sh";
    const res = await m.resolveMoshpitName("blue.eggs");
    assert.equal(res.target, "edge.moshcode.sh");
    assert.equal(res.c0mpute, SITE);
    const plain = await m.resolveMoshpitName("red.eggs");
    assert.equal(plain.target, null, "names without a site are untouched");
    assert.equal(plain.c0mpute, null);
  });

  await t.test("setting a target takes the name back from c0mpute", async () => {
    assert.equal((await m.setNameTarget({ tld: "eggs", label: "blue", userId: ALICE, target: "other.example.com" })).ok, true);
    const res = await m.resolveMoshpitName("blue.eggs");
    assert.equal(res.target, "other.example.com");
    assert.equal(res.c0mpute, null);
  });

  await t.test("clearing works, and clearing a target leaves the site alone", async () => {
    assert.equal((await m.setNameC0mpute({ tld: "eggs", label: "red", userId: ALICE, site: OTHER })).ok, true);
    assert.equal((await m.setNameTarget({ tld: "eggs", label: "red", userId: ALICE, target: "" })).ok, true);
    assert.equal((await m.resolveMoshpitName("red.eggs")).c0mpute, OTHER);
    const cleared = await m.setNameC0mpute({ tld: "eggs", label: "red", userId: ALICE, site: "" });
    assert.deepEqual(cleared, { ok: true, site: null });
    assert.equal((await m.resolveMoshpitName("red.eggs")).target, null);
  });

  await t.test("the CA signs for the edge only while the name points at c0mpute", async () => {
    const generated = await ca.generateCa({ rootName: "Test Root", issuerName: "Test Issuer" });
    await ca.configureCa({ cert: generated.issuer.cert, key: generated.issuer.key, root: generated.root.cert, leafDays: 30 });
    t.after(() => ca.resetCaForTests());
    process.env.MOSHPIT_C0MPUTE_EDGE_USERS = EDGE;

    const { csr } = await ca.generateCsr("red.eggs");
    // red.eggs has no site: the edge is a stranger.
    assert.equal((await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: EDGE, csr })).status, 403);

    assert.equal((await m.setNameC0mpute({ tld: "eggs", label: "red", userId: ALICE, site: SITE })).ok, true);
    const r = await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: EDGE, csr });
    assert.equal(r.ok, true, r.error);
    const leaf = new X509Certificate(r.cert);
    assert.equal(leaf.subject, "CN=red.eggs");
    const pins = await m.listPins("eggs", "red", "tls");
    assert.equal(pins.length, 1, "published as a pin");
    assert.equal(pins[0].user_id, ALICE, "under the holder, whose name it is");

    // A stranger who is not an edge still gets nothing.
    assert.equal((await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: BOB, csr })).status, 403);

    // Taken off c0mpute: the edge is refused again.
    assert.equal((await m.setNameC0mpute({ tld: "eggs", label: "red", userId: ALICE, site: "" })).ok, true);
    assert.equal((await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: EDGE, csr })).status, 403);

    // Not an edge account: refused even with a site set.
    process.env.MOSHPIT_C0MPUTE_EDGE_USERS = "";
    assert.equal((await m.setNameC0mpute({ tld: "eggs", label: "red", userId: ALICE, site: SITE })).ok, true);
    assert.equal((await certs.issueNameCertificate({ tld: "eggs", label: "red", userId: EDGE, csr })).status, 403);
  });
});
