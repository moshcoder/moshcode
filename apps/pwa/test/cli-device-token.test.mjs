// Integration tests for the device-code exchange (POST /cli/device/token).
//
// These boot the real router against a throwaway libsql file database. They
// skip cleanly when the PWA dependencies are not installed (a fresh repo
// clone only has the root CLI deps), so the root `npm test` stays green
// either way. Run `npm install` in apps/pwa to enable them.
import assert from "node:assert/strict";
import http from "node:http";
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
  deps = null; // pwa dependencies not installed — tests below skip
}

// Point the app at a throwaway database BEFORE importing its modules (config
// reads the environment once, at import time).
const workdir = mkdtempSync(path.join(tmpdir(), "moshcode-pwa-test-"));
process.env.DATABASE_URL = `file:${path.join(workdir, "test.db")}`;
process.env.SESSION_SECRET = "test-secret";

async function boot() {
  const { migrate } = await import("../src/migrate.mjs");
  await migrate();
  const { run, all, db } = await import("../src/db.mjs");
  // The local libsql driver resolves statements in microtasks, which fully
  // serializes concurrent request handlers and hides read-check-write races.
  // Production runs against a network database (Turso), where every statement
  // is a round trip. Defer each statement to a macrotask so two in-flight
  // handlers genuinely interleave, like they would against the remote DB.
  const execute = db.execute.bind(db);
  db.execute = (stmt) => new Promise((resolve, reject) => {
    setTimeout(() => execute(stmt).then(resolve, reject), 2);
  });
  const { sessionMiddleware, csrfGuard } = await import("../src/lib/session.mjs");
  const { cliRouter } = await import("../src/routes/cli.mjs");

  const app = deps.express();
  app.use(deps.express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(deps.express.urlencoded({ extended: false }));
  app.use(deps.cookieParser());
  app.use(sessionMiddleware);
  app.use(csrfGuard);
  app.use(cliRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address();

  const seedDeviceCode = async (deviceCode, { status = "approved", ageMs = 0 } = {}) => {
    await run(`INSERT OR REPLACE INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','demo',1)`);
    const now = Date.now();
    await run(
      `INSERT INTO device_codes (device_code,user_code,user_id,status,name,interval_s,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)`,
      [deviceCode, "ABCD-2345", status === "pending" ? null : "u1", status, "test", 5, now - ageMs, now - ageMs + 10 * 60 * 1000]
    );
  };
  // Raw http with a fresh connection per request: fetch()/undici would reuse a
  // keep-alive socket for same-origin calls and serialize the "concurrent"
  // polls, hiding the race this exercises.
  const poll = (deviceCode) => new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/cli/device/token", method: "POST", agent: false,
      headers: { "content-type": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ device_code: deviceCode }));
  });

  return { run, all, db, server, seedDeviceCode, poll };
}

// One shared app/db for the whole file (db.mjs is a module-level singleton —
// closing it between tests would break the next boot).
let booted = null;
const app = () => (booted ||= boot());

test.after(() => {
  if (!booted) return;
  booted.then(({ server, db }) => { server.close(); db.close?.(); })
    .finally(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* noop */ } });
});

test("cli/device/token: an approved code exchanges exactly once, then is rejected", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { all, seedDeviceCode, poll } = await app();

  await seedDeviceCode("dev-once");
  const before = (await all(`SELECT id FROM api_keys`)).length;

  const first = await poll("dev-once");
  assert.equal(first.status, 200);
  assert.ok(first.body.access_token, "first poll must mint an API key");
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before + 1);

  // Replay with the same device code must fail — the code is single-use.
  const replay = await poll("dev-once");
  assert.equal(replay.status, 400);
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before + 1, "replay must not mint a second key");
});

test("cli/device/token: concurrent polls claim the code once — one key, not two", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { all, seedDeviceCode, poll } = await app();

  await seedDeviceCode("dev-race");
  const before = (await all(`SELECT id FROM api_keys`)).length;

  // Two CLI polls in flight at once (retry after a timeout, double-clicked
  // CI job, …). Both read status "approved" before either claim lands; only
  // one may win.
  const [a, b] = await Promise.all([poll("dev-race"), poll("dev-race")]);
  const wins = [a, b].filter((r) => r.status === 200);
  assert.equal(wins.length, 1, `exactly one poll may mint a key, got statuses ${a.status}/${b.status}`);
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before + 1, "one device code must mint exactly one API key");
});

test("cli/device/token: a pending code is not exchangeable", { skip: !deps && "apps/pwa deps not installed" }, async () => {
  const { all, seedDeviceCode, poll } = await app();

  await seedDeviceCode("dev-pending", { status: "pending" });
  const before = (await all(`SELECT id FROM api_keys`)).length;
  const res = await poll("dev-pending");
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "authorization_pending");
  assert.equal((await all(`SELECT id FROM api_keys`)).length, before);
});
