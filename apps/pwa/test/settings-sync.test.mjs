// Settings sync — the account half of the pit's `/save` and `/load`.
//
// Same shape as sessions-output-seq.test.mjs: boot the real router against a
// throwaway libsql file database, and skip cleanly when the PWA dependencies
// aren't installed so the root `node --test` stays green in a fresh clone.
//
// The concurrency test defers every statement to a macrotask for the reason
// spelled out there: the local driver resolves in microtasks and fully
// serializes concurrent handlers, hiding exactly the read-then-insert race that
// two machines running `/save` at the same moment produce against Turso.
import assert from "node:assert/strict";
import http from "node:http";
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
  deps = null; // pwa dependencies not installed — tests below skip
}
const skip = deps ? false : "PWA dependencies are not installed";

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-settings-sync-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const snapshot = (files, extra = {}) => ({
  version: 1,
  host: "dev",
  moshcode: "0.39.0",
  installed: { engines: ["claude"], tools: [] },
  files,
  ...extra,
});

const ALIASES = { "aliases.json": { content: '{"gs":"git status"}' } };

async function boot({ slowStatements = false } = {}) {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, db } = await import("../src/db.mjs");
  if (slowStatements) {
    const execute = db.execute.bind(db);
    db.execute = (stmt) => new Promise((resolve, reject) => {
      setTimeout(() => execute(stmt).then(resolve, reject), 2);
    });
  }
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { settingsSyncRouter } = await import("../src/routes/settings-sync.mjs");
  const { createApiKey } = await import("../src/lib/apikey.mjs");

  const app = deps.express();
  app.use(deps.express.json({ limit: "2mb" }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(settingsSyncRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();

  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','one',1)`);
  await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u2','x@y.z','two',1)`);
  const keyOne = (await createApiKey("u1", "cli one")).plaintext;
  const keyTwo = (await createApiKey("u2", "cli two")).plaintext;

  // Raw http with a fresh connection per request: undici would reuse a
  // keep-alive socket and serialize the "concurrent" saves.
  const call = (token) => (method, route, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, method, path: route, agent: new http.Agent({ keepAlive: false }),
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

  return { server, one: call(keyOne), two: call(keyTwo), reset: () => run(`DELETE FROM settings_snapshots`) };
}

test("a saved snapshot comes back exactly as it went up", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    const empty = await one("GET", "/api/settings");
    assert.equal(empty.status, 404, "an account with nothing saved is a 404, not an empty 200");

    const put = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: null });
    assert.equal(put.status, 200);
    assert.equal(put.body.revision, 1, "the first save is revision 1");
    assert.match(put.body.digest, /^[0-9a-f]{64}$/);

    const got = await one("GET", "/api/settings");
    assert.equal(got.status, 200);
    assert.equal(got.body.revision, 1);
    assert.equal(got.body.host, "dev");
    assert.equal(got.body.version, "0.39.0");
    assert.deepEqual(got.body.snapshot, snapshot(ALIASES));
    assert.equal(got.body.digest, put.body.digest);
  } finally { server.close(); }
});

test("the digest matches the CLI's, byte for byte", { skip }, async () => {
  // Two implementations of one hash: src/settings-sync.mjs (digestFiles) and
  // this one. They diverged once — a NUL frame there, a space here — and nothing
  // noticed, because no code path compares them. Both suites now pin the same
  // hex for the same fixture, so either framing changing fails both.
  const { digestSnapshot } = await import("../src/routes/settings-sync.mjs");
  const fixture = {
    "aliases.json": { content: '{"gs":"git status"}' },
    "herd/rules.json": { content: "{}" },
  };
  assert.equal(
    digestSnapshot({ files: fixture }),
    "659fc77cca201fa9499620fc6bf34535d30313c4748658c84e5887ba0aa2761b",
  );
});

test("the digest is computed here, not taken from the client", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    const put = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES, { digest: "0".repeat(64) }) });
    assert.notEqual(put.body.digest, "0".repeat(64));
    const again = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES) });
    assert.equal(again.body.digest, put.body.digest, "the same files must digest the same");
  } finally { server.close(); }
});

test("a stale ifRevision is refused, and says where the account actually is", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: null });
    const second = await one("PUT", "/api/settings", {
      snapshot: snapshot({ "aliases.json": { content: '{"gs":"git log"}' } }),
      ifRevision: null,
    });
    assert.equal(second.body.revision, 2);

    // A machine that still thinks the account is at revision 1.
    const stale = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.revision, 2, "the CLI needs the current revision to explain the conflict");

    // Nothing was written: the account is still on the second machine's save.
    const got = await one("GET", "/api/settings");
    assert.equal(got.body.revision, 2);
    assert.deepEqual(got.body.snapshot.files, { "aliases.json": { content: '{"gs":"git log"}' } });

    // And the current revision as a precondition goes through.
    const fresh = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: 2 });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.revision, 3);
  } finally { server.close(); }
});

test("an identical snapshot is answered, not stored again", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    const first = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES) });
    assert.equal(first.body.revision, 1);
    assert.equal(first.body.unchanged, undefined);

    const again = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES) });
    assert.equal(again.status, 200);
    assert.equal(again.body.revision, 1, "an unchanged save must not burn a revision");
    assert.equal(again.body.unchanged, true);

    const list = await one("GET", "/api/settings/revisions");
    assert.equal(list.body.revisions.length, 1);

    // Identical content also settles a stale precondition: there is nothing to
    // lose when the bytes already match.
    const stale = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: 99 });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.unchanged, true);
  } finally { server.close(); }
});

test("an emptied account accepts a save that names a revision it no longer has", { skip }, async () => {
  // The web page's "forget" deletes every revision. A machine still holding a
  // marker from before would otherwise be stuck behind --force, having done
  // nothing wrong — and there is no other machine's save left to protect.
  const { server, one, reset } = await boot();
  try {
    await reset();
    const res = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: 4 });
    assert.equal(res.status, 200);
    assert.equal(res.body.revision, 1, "numbering restarts on an empty account");
  } finally { server.close(); }
});

test("two machines saving at once: one wins, the other is told", { skip }, async () => {
  const { server, one, reset } = await boot({ slowStatements: true });
  try {
    await reset();
    await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: null });

    // Both hold revision 1 and both save. Without the compare-and-set inside the
    // INSERT they would both read MAX(revision) = 1 and one save would vanish.
    const [a, b] = await Promise.all([
      one("PUT", "/api/settings", { snapshot: snapshot({ "aliases.json": { content: '{"a":"1"}' } }), ifRevision: 1 }),
      one("PUT", "/api/settings", { snapshot: snapshot({ "aliases.json": { content: '{"b":"2"}' } }), ifRevision: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], "exactly one concurrent save may win");

    const winner = a.status === 200 ? a : b;
    assert.equal(winner.body.revision, 2);
    const got = await one("GET", "/api/settings");
    assert.equal(got.body.revision, 2, "no revision was skipped or duplicated");
  } finally { server.close(); }
});

test("a snapshot that could write outside the settings dir is refused at the door", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    for (const name of ["../../.ssh/authorized_keys", "/etc/passwd", "herd\\rules.json", "a\0b"]) {
      const res = await one("PUT", "/api/settings", { snapshot: snapshot({ [name]: { content: "x" } }) });
      assert.equal(res.status, 400, `${JSON.stringify(name)} was accepted`);
    }
    assert.equal((await one("GET", "/api/settings")).status, 404, "nothing hostile was stored");
  } finally { server.close(); }
});

test("junk, empty and oversized snapshots are 400s with a reason", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    for (const body of [{}, { snapshot: null }, { snapshot: "a string" }, { snapshot: { files: {} } }, { snapshot: { files: [] } }]) {
      const res = await one("PUT", "/api/settings", body);
      assert.equal(res.status, 400);
      assert.ok(res.body.error, "a 400 has to say why");
    }
    const huge = await one("PUT", "/api/settings", {
      snapshot: snapshot({ "aliases.json": { content: "x".repeat(300 * 1024) } }),
    });
    assert.equal(huge.status, 400);
    assert.match(huge.body.error, /cap/);

    const badPrecondition = await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES), ifRevision: "soon" });
    assert.equal(badPrecondition.status, 400);
  } finally { server.close(); }
});

test("only the last few revisions are kept, and the newest is current", { skip }, async () => {
  const { server, one, reset } = await boot();
  try {
    await reset();
    const { KEEP_REVISIONS } = await import("../src/routes/settings-sync.mjs");
    const saves = KEEP_REVISIONS + 4;
    for (let i = 1; i <= saves; i++) {
      const res = await one("PUT", "/api/settings", { snapshot: snapshot({ "aliases.json": { content: `{"n":"${i}"}` } }) });
      assert.equal(res.body.revision, i);
    }
    const list = await one("GET", "/api/settings/revisions");
    assert.equal(list.body.revisions.length, KEEP_REVISIONS);
    assert.equal(list.body.revisions[0].revision, saves, "newest first");
    assert.equal(list.body.revisions.at(-1).revision, saves - KEEP_REVISIONS + 1);

    const current = await one("GET", "/api/settings");
    assert.deepEqual(current.body.snapshot.files, { "aliases.json": { content: `{"n":"${saves}"}` } });
  } finally { server.close(); }
});

test("one account cannot read or overwrite another's settings", { skip }, async () => {
  const { server, one, two, reset } = await boot();
  try {
    await reset();
    await one("PUT", "/api/settings", { snapshot: snapshot(ALIASES) });
    assert.equal((await two("GET", "/api/settings")).status, 404, "the second account has its own, empty, settings");

    const theirs = await two("PUT", "/api/settings", { snapshot: snapshot({ "aliases.json": { content: '{"theirs":"1"}' } }) });
    assert.equal(theirs.body.revision, 1, "revisions are per account, not global");

    const mine = await one("GET", "/api/settings");
    assert.deepEqual(mine.body.snapshot.files, ALIASES, "the other account's save must not be visible here");
  } finally { server.close(); }
});

test("no key, no settings", { skip }, async () => {
  const { server, reset } = await boot();
  try {
    await reset();
    const anonymous = (method, route, body) => new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: "127.0.0.1", port: server.address().port, method, path: route,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    assert.equal((await anonymous("GET", "/api/settings")).status, 401);
    assert.equal((await anonymous("PUT", "/api/settings", { snapshot: snapshot(ALIASES) })).status, 401);
    assert.equal((await anonymous("GET", "/api/settings/revisions")).status, 401);
  } finally { server.close(); }
});

test("the page lists file names, never their contents", { skip }, async () => {
  const { fileNames } = await import("../src/routes/settings-sync.mjs");
  const body = JSON.stringify(snapshot({ "herd/rules.json": { content: "{}" }, "aliases.json": { content: "SECRET" } }));
  assert.deepEqual(fileNames(body), ["aliases.json", "herd/rules.json"]);
  assert.deepEqual(fileNames("{not json"), []);
});
