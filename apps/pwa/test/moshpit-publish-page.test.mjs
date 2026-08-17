// /pit/publish — the page that drives the streaming endpoint.
//
// The upload itself is the browser's job and is covered by the route tests.
// What is worth pinning here is that the page hands the browser the right
// things: the names the signed-in user actually holds, escaped, and a form that
// posts to the streaming endpoint rather than the buffered one.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
let deps = null;
try {
  deps = { express: require("express"), cookieParser: require("cookie-parser") };
} catch {
  deps = null;
}

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-publish-page-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  const { moshpitRouter } = await import("../src/routes/moshpit.mjs");

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  await run(`INSERT INTO moshpit_tlds (tld,user_id,owner_email,created_at) VALUES ('eggs','u1','a@b.c',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','blue','u1',1)`);
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','green','u1',1)`);
  // Someone else's, under the same ending. Must not appear in u1's picker.
  await run(`INSERT INTO moshpit_names (tld,label,user_id,created_at) VALUES ('eggs','theirs','u2',1)`);

  // One long-lived server per identity, closed once at the end. A server per
  // request hangs the run: fetch keeps the connection alive, so close() never
  // settles and the process never exits.
  const serve = async (user) => {
    const app = deps.express();
    app.use(deps.cookieParser());
    app.use((req, _res, next) => { req.csrfToken = () => "csrf"; if (user) req.user = user; next(); });
    app.use(moshpitRouter);
    return new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  };

  const asUser = await serve({ id: "u1", email: "a@b.c" });
  const asAnon = await serve(null);

  const fetchPage = async (server, url = "/pit/publish") => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: res.status, html: await res.text() };
  };

  return { db, asUser, asAnon, fetchPage };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ db, asUser, asAnon }) => {
    // closeAllConnections, not close: fetch leaves keep-alive sockets open and
    // close() alone waits on them forever.
    for (const server of [asUser, asAnon]) { server.closeAllConnections?.(); server.close(); }
    db.close?.();
  }).finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("publish page: offers the names you hold, and only those", skip, async () => {
  const { asUser, fetchPage } = await app();
  const { status, html } = await fetchPage(asUser);

  assert.equal(status, 200);
  assert.ok(html.includes('value="blue.eggs"'), "should offer blue.eggs");
  assert.ok(html.includes('value="green.eggs"'), "should offer green.eggs");
  assert.ok(!html.includes("theirs.eggs"), "must not offer a name held by someone else");
});

test("publish page: posts to the streaming endpoint, not the buffered one", skip, async () => {
  const { asUser, fetchPage } = await app();
  const { html } = await fetchPage(asUser);

  // The whole feature is the streaming path. Pointing the form at the batch
  // endpoint would still work for small files and quietly lose the progress
  // bar and the memory bound for large ones.
  assert.match(html, /content\/stream/);
  assert.match(html, /application\/x-ndjson/);
  assert.ok(html.includes('id="pub-fill"'), "the progress bar needs its fill element");
});

test("publish page: signed out, it explains rather than showing a dead form", skip, async () => {
  const { asAnon, fetchPage } = await app();
  const { status, html } = await fetchPage(asAnon);

  assert.equal(status, 200);
  assert.match(html, /Sign in/);
  assert.ok(!html.includes('id="pub-file"'), "no upload control for someone who cannot upload");
});
