// Arrow keys sent from the session page.
//
// A key is not a line: it is queued as a sentinel the CLI decodes and presses
// straight away, and it is refused outright for a mosh that never declared it
// can press keys — because that mosh would hand the sentinel to readline and
// type it at the prompt of a live machine.
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

const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-keys-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

const SESSION = "keys-session-token";
const CSRF = "keys-csrf-token";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const routes = await import("../src/routes/sessions.mjs");

  const app = deps.express();
  app.use(deps.express.json());
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(routes.sessionsRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  await run(`INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
  await run(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    [SESSION, "u1", Date.now(), Date.now() + 60_000]);
  // One session per case: live and able to press keys, live but older than the
  // feature (no `features` at all, the way every session before it looks), and
  // one that has ended.
  const cli = async (id, features, status = "live") => run(
    `INSERT INTO cli_sessions (id,user_id,name,features,status,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)`,
    [id, "u1", "local", features, status, Date.now(), Date.now()]);
  await cli("new-cli", JSON.stringify(["keys"]));
  await cli("old-cli", null);
  await cli("dead-cli", JSON.stringify(["keys"]), "ended");

  const post = (id, body) => fetch(`${base}/sessions/${id}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: `mc_sess=${SESSION}; mc_csrf=${CSRF}`,
    },
    body: JSON.stringify({ ...body, _csrf: CSRF }),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  const queued = (id) => all(
    `SELECT body FROM session_commands WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`, [id]);

  const { createApiKey } = await import("../src/lib/apikey.mjs");
  const { plaintext: apiKey } = await createApiKey("u1", "keys-test");

  return { routes, run, all, db, server, base, apiKey, post, queued };
}

let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

const skip = { skip: !deps && "apps/pwa deps not installed" };

test("a key is queued as the sentinel the CLI decodes", skip, async () => {
  const { post, queued, routes } = await app();

  for (const key of ["up", "down", "left", "right", "enter"]) {
    const res = await post("new-cli", { key });
    assert.equal(res.status, 200, `${key} should queue`);
    assert.equal(res.body.key, key);
  }

  assert.deepEqual(
    (await queued("new-cli")).map((row) => row.body),
    ["up", "down", "left", "right", "enter"].map(routes.keyCommand),
  );
});

test("the app and the CLI agree on the sentinel", skip, async () => {
  const { routes } = await app();
  // The CLI half is a plain module over node builtins, so it imports here even
  // though apps/pwa is not part of the same package. Drifting the two apart
  // would leave the arrows silently typing at somebody's prompt.
  const { decodeKey, KEY_NAMES } = await import("../../../src/mirror.mjs");
  for (const key of KEY_NAMES) assert.equal(decodeKey(routes.keyCommand(key)), key);
  assert.equal(decodeKey("/help"), null, "an ordinary line is not a key");
});

test("an unknown key is refused before anything is queued", skip, async () => {
  const { post, queued } = await app();
  const before = (await queued("new-cli")).length;
  const res = await post("new-cli", { key: "escape" });
  assert.equal(res.status, 400);
  assert.equal((await queued("new-cli")).length, before);
});

test("a mosh that never claimed keys is told so, not sent one", skip, async () => {
  const { post, queued } = await app();
  const res = await post("old-cli", { key: "up" });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /too old/);
  assert.deepEqual(await queued("old-cli"), []);
});

test("an ended session takes no keys", skip, async () => {
  const { post, queued } = await app();
  const res = await post("dead-cli", { key: "up" });
  assert.equal(res.status, 409);
  assert.deepEqual(await queued("dead-cli"), []);
});

test("the sentinel cannot be smuggled in as a typed line", skip, async () => {
  const { post, queued, routes } = await app();
  // Nobody can type an ESC into the send box, but a hand-rolled post could, and
  // it would reach the prompt as a keypress that never met the version check.
  const res = await post("old-cli", { body: routes.keyCommand("up") });
  assert.equal(res.status, 400);
  assert.deepEqual(await queued("old-cli"), []);
});

test("a session only carries features we know", skip, async () => {
  const { routes } = await app();
  assert.deepEqual(routes.readFeatures(["keys"]), ["keys"]);
  assert.deepEqual(routes.readFeatures(["keys", "keys"]), ["keys"], "declared twice is still once");
  assert.deepEqual(routes.readFeatures(["keys", "rm -rf", 7, null]), ["keys"]);
  // Every shape an older or hand-rolled client can register with.
  for (const value of [undefined, null, "keys", {}, 3]) assert.deepEqual(routes.readFeatures(value), []);
});

test("supportsKeys reads what the session declared, and nothing else", skip, async () => {
  const { routes } = await app();
  assert.equal(routes.supportsKeys({ features: '["keys"]' }), true);
  assert.equal(routes.supportsKeys({ features: "[]" }), false);
  assert.equal(routes.supportsKeys({ features: null }), false, "every session before this shipped");
  assert.equal(routes.supportsKeys({ features: "not json" }), false);
  assert.equal(routes.supportsKeys({}), false);
});

test("a CLI that declares keys can then be sent them end to end", skip, async () => {
  const { all, base, apiKey, post } = await app();
  // Register the way the CLI does — through the API — rather than by hand.
  const registered = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ name: "declared", version: "0.68.0", features: ["keys", "telepathy"] }),
  }).then((r) => r.json());

  const row = await all(`SELECT features FROM cli_sessions WHERE id = ?`, [registered.id]);
  assert.equal(row[0].features, '["keys"]', "telepathy is not a feature we know");
  assert.equal((await post(registered.id, { key: "left" })).status, 200);
});
