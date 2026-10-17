// /pit/dns leads with "Ways to connect": the browser route, the opt-in root for
// https, TronBrowser and the whole-machine route, in that order, above the
// resolver addresses. The https step must match the registry's real state: a
// download link and fingerprint when it signs, no link to a 503 when it does not.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-dns-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";
process.env.PIT_ORIGIN = "https://pit.moshcode.sh";
process.env.MOSHPIT_DOH_URL = "https://dns.moshcode.sh/dns-query";
delete process.env.MOSHPIT_DNS_RESOLVERS;
delete process.env.MOSHPIT_CA_CERT;
delete process.env.MOSHPIT_CA_KEY;
delete process.env.MOSHPIT_CA_ROOT;

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");
  const ca = await import("../src/lib/moshpit-ca.mjs");

  const app = deps.express();
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(moshpitRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = () => fetch(`${base}/pit/dns`).then(async (res) => ({ status: res.status, html: await res.text() }));
  return { server, db, ca, page };
}

let booted = null;
const app = () => (booted ||= boot());
const skip = !deps && "apps/pwa deps not installed";

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("Ways to connect leads the page, browser route first, above the addresses", { skip }, async () => {
  const { ca, page } = await app();
  ca.resetCaForTests();
  const { status, html } = await page();
  assert.equal(status, 200);
  const connect = html.indexOf('id="connect"');
  assert.ok(connect > 0, "the section is on the page");
  assert.ok(connect < html.indexOf(">The addresses<"), "and comes before the resolver addresses");
  const section = html.slice(connect, html.indexOf(">The addresses<"));
  assert.match(section, /Just your browser/);
  assert.match(section, /Use secure DNS/);
  assert.match(section, /https:\/\/dns\.moshcode\.sh\/dns-query/);
  assert.ok(section.indexOf("Just your browser") < section.indexOf("TronBrowser"), "browser route is listed first");
  assert.match(section, /moshcode dns enable/);
});

test("with no CA, the https step says so and links no root", { skip }, async () => {
  const { ca, page } = await app();
  ca.resetCaForTests();
  const { html } = await page();
  assert.doesNotMatch(html, /\/api\/moshpit\/ca\.crt/);
  assert.match(html, /does not sign certificates yet/);
  assert.doesNotMatch(html, /it is not built\s+yet/);
});

test("with a CA, the https step links the root and shows its real fingerprint", { skip }, async () => {
  const { ca, page } = await app();
  const made = await ca.generateCa({ rootName: "DNS Page Test Root" });
  await ca.configureCa({ cert: made.issuer.cert, key: made.issuer.key, root: made.root.cert });
  const { html } = await page();
  assert.match(html, /href="\/api\/moshpit\/ca\.crt"/);
  assert.ok(html.includes(new X509Certificate(made.root.cert).fingerprint256), "the fingerprint shown is the root's");
  assert.match(html, /moshcode dns ca --user-only/);
  assert.match(html, /policy, not a technical limit/);
  assert.match(html, /href="#connect">Ways to connect<\/a>, step two/);
  ca.resetCaForTests();
});
